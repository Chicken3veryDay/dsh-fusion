/** Node child evaluation over typed RPC; the host owns process lifetime. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Duplex } from 'node:stream'
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import { createProcessRpc } from './rpc.ts'
import {
  captureStreamWrites, LogBuffer, makeConsoleShim, makeBindingErrorClass, makeNamespaces,
  prepareCompletion, prepareException, prepareUncaught, renderThrown,
} from './bootstrap.ts'
import type { BindingErrorConstructor, PatchableStream } from './bootstrap.ts'
import { clearProgramEnvironment } from './environment.ts'
import { createProgramEvaluator } from './evaluators/index.ts'
import type { ProgramEvaluator } from './evaluators/types.ts'
import type { ProgramResult, HostMethods, ProgramMethods } from './protocol.ts'

/** Process-owned environment, output and directory control consumed by the child. */
export interface ProgramProcess {
  env: NodeJS.ProcessEnv
  stdout: PatchableStream
  stderr: PatchableStream
  exitCode?: string | number | null | undefined
  chdir(directory: string): void
}

interface Evaluation {
  logs: LogBuffer
  maxOutputBytes: number
  /** Accepts binding calls and a completion. */
  active: boolean
  /** The result reached the host; later diagnostics cannot change it. */
  published: boolean
  reusable: boolean
  finish(result: ProgramResult): void
  /** Replace the completion, or the result awaiting publication, with an `uncaught` failure. */
  fail(result: ProgramResult): void
}

/**
 * Serve sequential evaluations until the host closes the control channel.
 * @param stream - Inherited, already-adopted control endpoint.
 * @param maxMessageBytes - Maximum control message and queued output bytes.
 * @param processState - Child environment, output, directory control and exit status.
 * @param defaultFormat - Syntax used by installed bootstraps when the host omits it.
 * @returns After control closure and evaluator cleanup.
 */
export async function runNodeMain(
  stream: Duplex, maxMessageBytes: number, processState: ProgramProcess, defaultFormat: PtcProgramFormat = 'function-body',
): Promise<void> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) throw new Error('invalid control message limit')
  clearProgramEnvironment(processState)
  const context = new AsyncLocalStorage<Evaluation>()
  const closed = Promise.withResolvers<void>()
  const errors = new Map<string, { name: string; memberNameProperty: string; constructor: BindingErrorConstructor }>()
  const errorLookup = { get: (name: string) => errors.get(name)?.constructor }
  const unsettled = new Promise<never>(() => {})
  let evaluator: ProgramEvaluator | undefined
  let current: Evaluation | undefined
  const host: Pick<HostMethods, 'invoke'> = {
    invoke: (global, name, args) => {
      const evaluation = context.getStore()
      if (!evaluation?.active) {
        if (evaluation && !evaluation.reusable) return unsettled
        throw new Error('PTC evaluation has ended; call this function from a new run_code evaluation')
      }
      return connection.invoke(global, name, args).then((value) => {
        return !evaluation.active && !evaluation.reusable ? unsettled : value
      }, (error: unknown) => {
        // Closing a temporary process must not resume an unawaited binding with a late rejection.
        if (!evaluation.active && !evaluation.reusable) return unsettled
        throw error
      })
    },
  }
  const logSink = { push(text: string): void { const evaluation = context.getStore(); if (evaluation?.active) evaluation.logs.push(text) } }
  captureStreamWrites(logSink, processState.stdout)
  captureStreamWrites(logSink, processState.stderr)
  const connection = createProcessRpc<HostMethods, ProgramMethods>(stream, maxMessageBytes, {
    async run(cwd, data) {
      const completion = Promise.withResolvers<ProgramResult>()
      const logs = new LogBuffer(data.maxOutputBytes, (text) => { void connection.log(text) }, () => { void connection.outputLimit() })
      const format = data.programFormat ?? defaultFormat
      let pending: ProgramResult = {}
      const evaluation: Evaluation = {
        logs, maxOutputBytes: data.maxOutputBytes, active: true, published: false, reusable: data.retainsState,
        finish(result) {
          if (!evaluation.active) return
          evaluation.active = false
          pending = result
          if (evaluation.reusable) {
            void connection.$rejectPendingCalls(({ reject }) => { reject(new Error('PTC evaluation ended before the binding completed')) })
          }
          // Node reports unhandled rejections after the current microtasks. End binding admission now,
          // but publish the result after that checkpoint, so a detached rejection fails this run.
          setImmediate(() => {
            evaluation.published = true
            completion.resolve(pending)
          })
        },
        fail(result) {
          if (evaluation.active) evaluation.finish(result)
          else if (!evaluation.published && pending.error?.kind !== 'uncaught') pending = result
        },
      }
      current = evaluation
      context.run(evaluation, () => {
        try {
          processState.chdir(cwd)
          if (evaluator === undefined) {
            evaluator = createProgramEvaluator(format, (diagnostic) => {
              // Diagnostics run in the causing evaluation's async context; a published result stays final.
              const cause = context.getStore()
              if (cause === undefined || cause.published) return
              const remaining = cause.logs.remainingOutputBytes()
              if (diagnostic.kind === 'printed' && cause.active) {
                cause.finish(prepareException(diagnostic.message, remaining, cause.maxOutputBytes))
                return
              }
              const message = diagnostic.kind === 'printed' ? diagnostic.message : `Uncaught ${renderThrown(diagnostic.reason)}`
              cause.fail(prepareUncaught(message, remaining, cause.maxOutputBytes))
            })
            evaluator.globals.console = makeConsoleShim(logSink)
            // Context access must not reserve a function-body parameter named process.
            Object.defineProperty(evaluator.globals, 'process', { configurable: true, writable: true, value: processState })
          }
          for (const namespace of data.namespaces) {
            const descriptor = namespace.errorClass
            if (!descriptor) { errors.delete(namespace.global); continue }
            const previous = errors.get(namespace.global)
            if (previous?.name === descriptor.name && previous.memberNameProperty === descriptor.memberNameProperty) continue
            const constructor = makeBindingErrorClass(descriptor)
            errors.set(namespace.global, { name: descriptor.name, memberNameProperty: descriptor.memberNameProperty, constructor })
          }
          const namespaces = makeNamespaces(data, host, errorLookup)
          for (const [index, namespace] of data.namespaces.entries()) {
            Object.defineProperty(evaluator.globals, namespace.global, { configurable: true, enumerable: true, value: namespaces[index] })
            if (namespace.errorClass) {
              Object.defineProperty(evaluator.globals, namespace.errorClass.name, {
                configurable: true, enumerable: true, value: errorLookup.get(namespace.global),
              })
            }
          }
          evaluator.evaluate(data.code, (result) => {
            evaluation.finish(result.ok ? prepareCompletion(result.value, logs.remainingOutputBytes(), data.maxOutputBytes)
              : prepareException(result.error, logs.remainingOutputBytes(), data.maxOutputBytes))
          })
        } catch (error: unknown) {
          evaluation.finish(prepareException(error, logs.remainingOutputBytes(), data.maxOutputBytes))
        }
      })
      return await completion.promise
    },
  }, ['ready', 'log', 'outputLimit'], (_error, kind) => {
    if (current?.active || kind === 'protocol') processState.exitCode = 1
    if (current) current.active = false
    closed.resolve()
  })
  try {
    await connection.ready()
    await closed.promise
  } finally {
    evaluator?.close()
    connection.$close()
    context.disable()
  }
}
