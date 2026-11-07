/** Node REPL evaluation with declarations retained in its context. */
import { start } from 'node:repl'
import { PassThrough, Writable } from 'node:stream'
import type { EvaluatorDiagnostic, ProgramEvaluator } from './types.ts'

/**
 * Create a REPL whose globals survive sequential evaluations until close.
 * The REPL domain prints a thrown or callback exception; without a process
 * listener it also prints an unhandled rejection, indistinguishable from a
 * throw, so the evaluator listens for unhandled rejections until close.
 * @param report - REPL diagnostics in the async context of the evaluation that caused them.
 * @returns Retained globals, asynchronous evaluation and REPL cleanup.
 */
export function createReplEvaluator(report: (diagnostic: EvaluatorDiagnostic) => void): ProgramEvaluator {
  const input = new PassThrough()
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const message = chunk.toString().trim()
    if (message) report({ kind: 'printed', message })
    callback()
  } })
  const onUnhandledRejection = (reason: unknown): void => { report({ kind: 'unhandled-rejection', reason }) }
  process.on('unhandledRejection', onUnhandledRejection)
  const repl = start({ input, output, terminal: false, prompt: '', useGlobal: false, ignoreUndefined: true })
  // Interactive result setters print notices; program assignments use ordinary retained globals.
  for (const name of ['_', '_error']) {
    Object.defineProperty(repl.context, name, { configurable: true, enumerable: true, writable: true, value: undefined })
  }
  return {
    globals: repl.context,
    evaluate(code, finish) {
      // Node's REPL treats a leading brace as an object expression before transforming await.
      const program = code.trimStart().startsWith('{') ? `;${code}` : code
      repl.eval(`${program}\n`, repl.context, 'ptc-repl', (error: Error | null, value: unknown) => {
        finish(error ? { ok: false, error } : { ok: true, value })
      })
    },
    close() {
      process.off('unhandledRejection', onUnhandledRejection)
      repl.close()
      input.destroy()
      output.destroy()
    },
  }
}
