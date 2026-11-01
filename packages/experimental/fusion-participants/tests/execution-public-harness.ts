/** Fake held host over the public Loader composition and real retained JSONL writers. */
import { expect } from 'vitest'
import type { ExecutionHostProvider, EffectClass, HeldAttempt, PreparedParticipants, TaskExecutionHost } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'
import { mount } from './harness.ts'
import { gate } from './execution-harness.ts'

export async function publicFixture(
  register?: (ctx: Context, task: PreparedParticipants, provider: ExecutionHostProvider) => Promise<TaskExecutionHost>,
  projectionCache = false,
) {
  const { ctx, adapter: model, root } = await mount(undefined, 'none', false, projectionCache)
  const task = await ctx.fusionParticipants.prepare('single-test')
  const adopted = await task.adopt('participant')
  const control = {
    registrations: 0, preparations: 0, bodies: 0, cleanups: 0, cancellations: 0,
    classification: 'mutation' as EffectClass | undefined,
    onClassify: undefined as (() => void) | undefined,
    onRegister: undefined as ((attempt: HeldAttempt) => void) | undefined,
    onInvoke: undefined as (() => void) | undefined,
    onCleanup: undefined as (() => void) | undefined,
    prepare: undefined as ReturnType<typeof gate> | undefined,
    body: undefined as ReturnType<typeof gate> | undefined,
    cleanup: undefined as ReturnType<typeof gate> | undefined,
    prepareError: undefined as Error | undefined,
    invokeError: undefined as Error | undefined,
    cleanupError: undefined as Error | undefined,
    cancelError: undefined as Error | undefined,
    outcome: 'completed' as 'completed' | 'failed' | 'uncertain',
    identities: new Set<HeldAttempt>(),
  }
  const provider: ExecutionHostProvider = {
    name: 'fake-public-held', revision: 'fake-1',
    classify() { control.onClassify?.(); return control.classification },
    registerHeld(attempt) {
      control.registrations++
      control.identities.add(attempt)
      control.onRegister?.(attempt)
      return {
        async prepare() {
          control.preparations++
          control.prepare?.entered.resolve(undefined)
          await control.prepare?.resume.promise
          if (control.prepareError !== undefined) throw control.prepareError
          return { invoke() {
            control.bodies++
            control.onInvoke?.()
            if (control.invokeError !== undefined) throw control.invokeError
            control.body?.entered.resolve(undefined)
            return Promise.resolve(control.body?.resume.promise).then(() => control.outcome)
          } }
        },
        cancel() {
          control.cancellations++
          if (control.cancelError !== undefined) throw control.cancelError
        },
        async cleanup() {
          control.onCleanup?.()
          control.cleanup?.entered.resolve(undefined)
          await control.cleanup?.resume.promise
          if (control.cleanupError !== undefined) throw control.cleanupError
          control.identities.delete(attempt)
          control.cleanups++
        },
      }
    },
  }
  const host = await (register === undefined ? ctx.fusionParticipants.registerExecutionHost(task, provider) : register(ctx, task, provider))
  const grant = () => host.grant(host.controller, adopted.agent.session.id)
  const bind = (signal = new AbortController().signal) => host.bindRun(host.issuer, adopted.agent, signal)
  const dispose = async () => {
    control.prepare?.resume.resolve(undefined); control.body?.resume.resolve(undefined); control.cleanup?.resume.resolve(undefined)
    await host.dispose(); await adopted.dispose(); await task.dispose()
    expect(model.requests).toHaveLength(0)
  }
  return { ctx, model, root, task, adopted, provider, control, host, grant, bind, dispose }
}
