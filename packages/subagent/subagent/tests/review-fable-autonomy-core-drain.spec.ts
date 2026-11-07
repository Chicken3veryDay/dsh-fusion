/**
 * Review (Fable autonomy-core sweep): selected drain versus in-flight cold
 * resume, and settlement delivery during host shutdown.
 *
 * Case 1 — `drainChildren` ignores a child whose cold resume is in flight.
 * `deliverFollowup` serializes delivery per child through the ChildLock and,
 * for a non-resident child, runs `coldResume` under that lock: Session read,
 * `agents.resume`, publication into `resident`, then the waking delivery.
 * `drainChildren` reads only `resident`, so a child whose resume has not yet
 * published is "absent" and the drain resolves as an accepted no-op while
 * the pending delivery goes on to materialize the child and start its turn.
 * `drainDescendants` handles exactly this window by aborting admitted
 * materializations and awaiting them; `drainChildren` does not. A Workstream
 * `stop member` (which reports the member stopped once `drainChildren`
 * resolves) or any parallel `send_message` + stop pair therefore leaves a
 * running member behind that the host believes is stopped.
 *
 * Case 2 — a child settling during root unload wakes its idle parent through
 * `parent.followup()`. The registry closed its initiator scope when the root
 * fiber entered UNLOADING, so `wakeDriver` commits the parent's `running`
 * phase and then throws from `withInitiator`; the notice is logged as
 * undelivered, the parent has no driver, and the parent's own teardown waits
 * on `whenIdle()` forever. Root unload never completes.
 */

import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { managerState } from './manager-internals.ts'

/** Adapter whose entries can hold a model call open until the test releases it or the call is aborted. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: { chunks: StreamChunk[]; gate?: Promise<unknown> }[]) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate !== undefined) {
      await Promise.race([entry.gate, new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })])
    }
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function setup(adapter: LlmAdapter) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-review-autonomy-drain-'))
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root })
  cleanups.push(async () => {
    await Promise.race([persistence.dispose(), new Promise(resolve => setTimeout(resolve, 2000))])
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await mountWorkingDirectoryFixture(ctx)
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>((resolve) => { setTimeout(() => { resolve('pending') }, ms) }),
  ])
}

function waitForStatus(ctx: Context, agent: Agent, wanted: 'idle' | 'running'): Promise<void> {
  if (agent.status === wanted) return Promise.resolve()
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === wanted) { dispose(); resolve() }
    })
  })
}

const signal = new AbortController().signal
const text = (value: string) => [{ type: 'text' as const, text: value }]

describe('review: drainChildren against an in-flight cold resume', () => {
  it('a selected drain that resolves must not be followed by the drained child materializing and running', async () => {
    // Child turn 1 completes and the child settles naturally; the cold resume
    // (turn 2) is held open so a drain can land in its window.
    const resumeGate = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('child done') }, { chunks: textResponse('resumed work'), gate: resumeGate.promise }])
    const { ctx, parent } = await setup(adapter)
    const started = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'member', signal, delivery: 'caller',
      request: { prompt: text('first task'), parent },
    })
    await started.result
    const { resident, locks } = managerState(ctx)
    expect(resident.has(started.childId)).toBe(false)

    // Hold the child's ChildLock as a delivery that is still inside its cold
    // resume would, then queue the real waking delivery behind it.
    const resumeWindow = Promise.withResolvers<undefined>()
    void locks.run(started.childId, () => resumeWindow.promise)
    const delivery = ctx.subagents.sendMessage(parent, started.childId, text('second task'), { signal })
    void delivery.catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(resident.has(started.childId), 'the delivery is queued behind the in-flight resume').toBe(false)

    // The host stops the member now. Workstream reports the member stopped
    // as soon as this resolves.
    const drain = ctx.subagents.drainChildren(parent, [started.childId])
    const drainOutcome = await settlesWithin(drain, 500)

    // Let the pending delivery proceed as the real cold resume would.
    resumeWindow.resolve(undefined)
    let deliveryOutcome: 'accepted' | 'refused' = 'accepted'
    try { await delivery } catch { deliveryOutcome = 'refused' }
    await new Promise(resolve => setTimeout(resolve, 50))
    const child = ctx.agents.get(started.childId)
    const childRunning = child !== undefined && child.status === 'running'
    resumeGate.resolve(undefined)

    // Acceptable outcomes: the drain waited for the delivery and released the
    // child, or the delivery was refused. Not acceptable: the drain resolved,
    // then the drained child was published and started a turn.
    expect(
      drainOutcome === 'settled' && deliveryOutcome === 'accepted' && (resident.has(started.childId) || childRunning),
      `drain ${drainOutcome}, delivery ${deliveryOutcome}, resident ${resident.has(started.childId)}, child status ${child?.status ?? 'absent'}`,
    ).toBe(false)
    await ctx.subagents.drainDescendants([parent])
    await ctx.fiber.dispose()
  })
})

describe('review: settlement notice during root unload', () => {
  it('a child released by a selected drain during shutdown must not strand its idle parent and hang unload', async () => {
    const childGate = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('never reached'), gate: childGate.promise }])
    const { ctx, parent } = await setup(adapter)
    // Parent delivery: the child's settlement notice wakes the parent.
    const started = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'member', signal, delivery: 'parent',
      request: { prompt: text('long task'), parent },
    })
    const child = ctx.agents.get(started.childId)!
    await waitForStatus(ctx, child, 'running')
    expect(parent.status).toBe('idle')

    // A host plugin that stops its members at shutdown, as Workstream's
    // shutdown does with drainChildren.
    const observed: { drain?: unknown; parentStatus?: string } = {}
    ctx.effect(() => async () => {
      try { await ctx.subagents.drainChildren(parent, [started.childId]) } catch (error: unknown) { observed.drain = error }
      observed.parentStatus = parent.status
    }, 'review.hostShutdown()')

    const unload = ctx.fiber.dispose()
    const unloadOutcome = await settlesWithin(unload, 3000)
    childGate.resolve(undefined)
    expect(unloadOutcome, `root unload hung; parent status after drain: ${observed.parentStatus ?? 'unset'}; drain error: ${String(observed.drain)}`).toBe('settled')
  })
})
