/**
 * Review (Fable autonomy-core sweep): a rejected external admission whose
 * rollback fails must not become an untracked live execution.
 *
 * `SubagentManager.materializeTracked` publishes the external run into
 * `resident`, then re-checks caller cancellation. When that check throws, it
 * calls `rollbackUnpublished`, which awaits `run.dispose()` and, in `finally`,
 * removes the run from `resident`, releases the slot and rejects the result.
 * The rollback's own rejection is swallowed (`.catch(() => undefined)`), and
 * the caller receives only the original cancellation error: no run id, no
 * cause naming the failed cleanup, and no remaining manager ownership.
 *
 * For an in-process backend the Agent handle is at least detached from the
 * registry; for an external backend (ACP, Claude Code, Codex, a dedicated
 * process) the provider's execution keeps running with nothing in this host
 * able to find it: `drain()`, `drainDescendants()` and `interrupt()` all
 * iterate `resident`. `startExternal` wraps the same `dispose` failure with a
 * warning log and rethrows the admission error.
 *
 * The expected contract (README "Activation settlement": "Closing admission
 * and disposing the handle prevent late work from entering a released
 * Agent"; `SubagentRun.dispose` "reach child quiescence, and release
 * resources") is that a rejection either means the execution was released or
 * the caller is told that it was not. Neither holds here.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import type { SubagentCapabilities, SubagentResult, SubagentRun, SubagentStartRequest } from '../src/types.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { managerState } from './manager-internals.ts'

const capabilities: SubagentCapabilities = {
  agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false,
}

async function setup(start: (request: SubagentStartRequest) => Promise<SubagentRun>) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const parent = await externalTestParent(ctx)
  await ctx.plugin(TestSessionQuery)
  ctx.subagents.registerProvider({ name: 'external', capabilities, inheritsParentContext: false, start })
  return { ctx, parent }
}

describe('review: external admission rollback failure', () => {
  it('a cancelled admission whose run.dispose() rejects stays owned by the manager or reports the failed release', async () => {
    const controller = new AbortController()
    const result = Promise.withResolvers<SubagentResult>()
    let producerFinished = false
    void result.promise.then(() => { producerFinished = true }, () => { producerFinished = true })
    // An ordinary cleanup failure: the backend's process kill rejects while the
    // execution keeps running. The provider honours neither the startup signal
    // (it already established the run when the caller cancelled) nor a second
    // dispose attempt, which is the point: the host must still own the run.
    const dispose = vi.fn(() => Promise.reject(new Error('kill failed: EPERM')))
    const run: SubagentRun = { id: SessionId('external-live-run'), result: result.promise, dispose }
    const fixture = await setup(() => {
      // The caller cancels at the exact moment the provider publishes its run.
      controller.abort(new Error('caller cancelled during startup'))
      return Promise.resolve(run)
    })

    let rejection: unknown
    try {
      await fixture.ctx.subagents.startActivation({
        provider: 'external', label: 'External work', signal: controller.signal, delivery: 'caller',
        request: { parent: fixture.parent, prompt: [{ type: 'text', text: 'Work independently' }] },
      })
    } catch (error: unknown) {
      rejection = error
    }
    expect(rejection, 'the cancelled admission rejects').toBeInstanceOf(Error)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(producerFinished).toBe(false)

    const resident = managerState(fixture.ctx).resident
    const stillOwned = resident.has(run.id)
    const chain: string[] = []
    for (let error: unknown = rejection; error instanceof Error; error = error.cause) chain.push(error.message)
    const reportsFailedRelease = chain.some(message => message.includes('kill failed'))

    // Either the manager still owns the live run (so a later drain can retry
    // its release) or the rejection carries the failed release so the caller
    // can act. A plain cancellation error with the run forgotten is a zombie.
    expect(
      stillOwned || reportsFailedRelease,
      `rejection chain ${JSON.stringify(chain)}; resident ids ${JSON.stringify([...resident.keys()])}`,
    ).toBe(true)

    // Host teardown is the last chance: it must at least attempt the release
    // again. With the run forgotten, drain never reaches it.
    await fixture.ctx.subagents.drainDescendants([fixture.parent])
    expect(dispose.mock.calls.length, 'drain must attempt to release the live run').toBeGreaterThan(1)
  })
})
