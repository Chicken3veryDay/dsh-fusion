/** Resolve unqualified CLI references in the shell execution world and persist only confirmed URLs. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { z } from 'zod'
import { ownChangeRequestUrls } from './commands.ts'
import { ghReferences } from './references.ts'

const completedShell = z.object({
  kind: z.literal('foreground'),
  cwd: z.string(),
  exitCode: z.literal(0),
  signal: z.null(),
  timedOut: z.literal(false),
  aborted: z.literal(false),
})
const shellArguments = z.object({ command: z.string() })
const resolvedReference = z.object({ url: z.string().regex(/^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*\/?$/) })

/**
 * Observe completed foreground Bash calls, model-issued or nested in a `run_code`
 * program, while tools and shell services exist. Queries use the same shell
 * service, cwd, managed environment, and standing sandbox policy. Failed lookups
 * leave bindings unchanged and log a warning. A model-issued call's lookups stop
 * when that call is cancelled; a nested call's signal fires when its program
 * returns, so its lookups run until the Session closes instead. Closing the
 * Session cancels every lookup without adding bindings; disposal aborts and
 * awaits all queries. Replay performs no lookup.
 * @param ctx - owning plugin context.
 * @param timeoutMs - shell deadline for one read-only lookup.
 * @param sessionSignal - aborts when the Session closes.
 * @param record - persists a confirmed URL without restoring dismissed bindings.
 */
export function observeReferences(
  ctx: Context,
  timeoutMs: number,
  sessionSignal: (session: Session) => AbortSignal,
  record: (session: Session, url: string) => void,
): void {
  ctx.inject(['tools', 'shell', 'shellEnv'], (scope) => {
    const lifetime = new AbortController()
    const tasks = new Set<Promise<void>>()
    scope.effect(() => async () => {
      lifetime.abort()
      await Promise.allSettled(tasks)
    }, 'forge-session: stop reference lookups')
    scope.on('tools/result', (exec, result) => {
      const session = exec.agent?.session
      if (exec.name !== 'bash' || session === undefined || result.isError) return
      const signals = [lifetime.signal, sessionSignal(session)]
      if (exec.parent === undefined) signals.push(exec.signal)
      const signal = AbortSignal.any(signals)
      const task = resolve(exec, session, result, signal).catch((error: unknown) => {
        if (signal.aborted) return
        scope.logger.warn(`forge-session: PR reference lookup failed; use a full PR URL to bind it: ${error instanceof Error ? error.message : String(error)}`)
      })
      tasks.add(task)
      void task.then(() => tasks.delete(task))
    })

    async function resolve(
      exec: Readonly<ToolExecution>,
      session: Session,
      result: Readonly<ToolExecutionResult>,
      signal: AbortSignal,
    ): Promise<void> {
      const argumentsResult = shellArguments.safeParse(exec.arguments)
      const shell = completedShell.safeParse(result.value)
      if (!argumentsResult.success || !shell.success) return
      const printed = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (ownChangeRequestUrls(printed).length > 0) return
      const lookups = ghReferences(argumentsResult.data.command).flatMap(reference => reference.lookup === null ? [] : [reference.lookup])
      for (const command of lookups) {
        signal.throwIfAborted()
        const spec = scope.shell.resolve({
          command,
          workdir: shell.data.cwd,
          timeoutMs,
          signal,
          dshEnv: scope.shellEnv.collect(exec),
          sandboxPolicy: scope.get('sandboxPolicy')?.resolve({ session }),
        })
        const process = await scope.shell.execute(spec)
        const output = await process.result()
        signal.throwIfAborted()
        if (output.exitCode !== 0 || output.signal !== null || output.timedOut || output.aborted || output.stdout.truncated) {
          throw new Error('gh did not return a complete successful reference lookup')
        }
        const parsed = resolvedReference.parse(JSON.parse(output.stdout.text))
        record(session, parsed.url)
      }
    }
  })
}
