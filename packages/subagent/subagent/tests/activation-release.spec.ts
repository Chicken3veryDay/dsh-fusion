/**
 * Release guarantees of rejected admissions, parent ownership holds across
 * concurrent deliveries, and selected drains against in-flight child work.
 */

import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import type { SubagentCapabilities, SubagentResult, SubagentRun, SubagentStartRequest } from '../src/types.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { managerState } from './manager-internals.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

const capabilities: SubagentCapabilities = {
  agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false,
}
const signal = new AbortController().signal
const text = (value: string) => [{ type: 'text' as const, text: value }]

async function externalSetup(start: (request: SubagentStartRequest) => Promise<SubagentRun>, maxActiveSubagents = 1) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime, { maxActiveSubagents })
  const parent = await externalTestParent(ctx)
  await ctx.plugin(TestSessionQuery)
  ctx.subagents.registerProvider({ name: 'external', capabilities, inheritsParentContext: false, start })
  const startExternal = (controller = new AbortController()) => ctx.subagents.startActivation({
    provider: 'external', label: 'External work', signal: controller.signal, delivery: 'caller',
    request: { parent, prompt: text('work') },
  })
  return { ctx, parent, startExternal }
}

/** Adapter whose entries can hold a model call open until the test releases it or the call is aborted. */
class GatedAdapter extends LlmAdapter {
  constructor(private readonly script: { chunks: StreamChunk[]; gate?: Promise<unknown> }[]) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
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

async function localSetup(adapter: LlmAdapter) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-activation-release-'))
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root })
  cleanups.push(async () => {
    await ctx.fiber.dispose()
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

function waitForStatus(ctx: Context, agent: Agent, wanted: 'idle' | 'running'): Promise<void> {
  if (agent.status === wanted) return Promise.resolve()
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === wanted) { dispose(); resolve() }
    })
  })
}

describe('rejected admission release', () => {
  it('keeps the capacity slot of a retained execution until a retried release succeeds', async () => {
    const controller = new AbortController()
    let releases = 0
    const dispose = vi.fn(() => ++releases === 1 ? Promise.reject(new Error('kill failed')) : Promise.resolve())
    const retained: SubagentRun = { id: SessionId('retained-run'), result: new Promise<SubagentResult>(() => {}), dispose }
    const next: SubagentRun = { id: SessionId('next-run'), result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: () => Promise.resolve() }
    let starts = 0
    const fixture = await externalSetup(() => {
      if (starts++ > 0) return Promise.resolve(next)
      controller.abort(new Error('caller cancelled'))
      return Promise.resolve(retained)
    })

    const rejected = fixture.startExternal(controller)
    await expect(rejected).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    await expect(rejected).rejects.toThrow('subagent "retained-run" was not admitted (caller cancelled)')
    // The one slot stays reserved while the execution may still run.
    await expect(fixture.startExternal()).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })

    await fixture.ctx.subagents.drainDescendants([fixture.parent])
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(managerState(fixture.ctx).resident.size).toBe(0)
    const other = await externalTestParent(fixture.ctx)
    const started = await fixture.ctx.subagents.startActivation({
      provider: 'external', label: 'External work', signal, delivery: 'caller',
      request: { parent: other, prompt: text('work') },
    })
    expect(started.childId).toBe(SessionId('next-run'))
    await started.dispose()
  })

  it('retains a colliding execution under its pending id without displacing the existing owner', async () => {
    const owner = Promise.withResolvers<SubagentResult>()
    const first: SubagentRun = {
      id: SessionId('shared-id'), result: owner.promise,
      dispose: () => { owner.resolve({ output: [], stopReason: 'aborted' }); return Promise.resolve() },
    }
    let releases = 0
    const collidingDispose = vi.fn(() => ++releases === 1 ? Promise.reject(new Error('kill failed')) : Promise.resolve())
    const colliding: SubagentRun = { id: SessionId('shared-id'), result: new Promise<SubagentResult>(() => {}), dispose: collidingDispose }
    let starts = 0
    const fixture = await externalSetup(() => Promise.resolve(starts++ === 0 ? first : colliding), 2)
    const accepted = await fixture.startExternal()

    const rejected = fixture.startExternal()
    await expect(rejected).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    await expect(rejected).rejects.toThrow('subagent "shared-id" was not admitted (subagent "shared-id" already exists)')
    const { resident } = managerState(fixture.ctx)
    const owned = resident.get(SessionId('shared-id'))
    expect(owned?.kind === 'external' ? owned.run : undefined).toBe(first)
    expect(resident.size).toBe(2)

    await fixture.ctx.subagents.drainDescendants([fixture.parent])
    expect(collidingDispose).toHaveBeenCalledTimes(2)
    expect(resident.size).toBe(0)
    await expect(accepted.result).resolves.toMatchObject({ stopReason: 'aborted' })
  })
  it('reports a cold resume whose rollback fails as retained instead of unavailable', async () => {
    const { ctx, parent } = await localSetup(new GatedAdapter([{ chunks: textResponse('done') }]))
    const started = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'member', signal, delivery: 'caller', request: { prompt: text('task'), parent },
    })
    await started.result
    const { resident } = managerState(ctx)
    let armed = true
    ctx.on('internal/dispatch', (_mode, eventName) => {
      if (eventName !== 'subagent/start' || !armed) return
      armed = false
      const activation = resident.get(started.childId)
      if (activation?.kind !== 'local') throw new Error('expected the resumed Activation')
      const dispose = activation.handle.dispose.bind(activation.handle)
      vi.spyOn(activation.handle, 'dispose').mockImplementationOnce(() => Promise.reject(new Error('handle release failed')))
        .mockImplementation(dispose)
      throw new Error('start publication failed')
    }, { global: true })

    const rejected = ctx.subagents.sendMessage(parent, started.childId, text('again'), { signal })
    await expect(rejected).rejects.toMatchObject({ code: 'ACTIVATION_TEARDOWN_FAILED' })
    await expect(rejected).rejects.toThrow(/not admitted \(start publication failed\).*handle release failed/)
    expect(resident.get(started.childId)?.retained).toBeDefined()
    // Input to the retained child is refused instead of waiting for a release that already failed.
    await expect(ctx.subagents.sendMessage(parent, started.childId, text('later'), { signal }))
      .rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
    await ctx.subagents.drainChildren(parent, [started.childId])
    expect(resident.has(started.childId)).toBe(false)
  })
})

describe('parent ownership holds', () => {
  it('keeps a managed parent owning its child while a concurrent delivery still resumes it', async () => {
    const parentTurn = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('parent waits'), gate: parentTurn.promise },
      { chunks: textResponse('child done') },
      { chunks: textResponse('child resumed') },
    ])
    const { ctx, parent } = await localSetup(adapter)
    const managed = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'managed', signal, delivery: 'caller', request: { prompt: text('coordinate'), parent },
    })
    const managedAgent = ctx.agents.get(managed.childId)!
    await waitForStatus(ctx, managedAgent, 'running')
    const child = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'child', signal, delivery: 'caller', request: { prompt: text('first'), parent: managedAgent },
    })
    await child.result
    const { resident } = managerState(ctx)
    const managedActivation = resident.get(managed.childId)!
    expect(resident.has(child.childId)).toBe(false)
    expect(managedActivation.ownedChildren.has(child.childId)).toBe(false)

    // Hold the second delivery inside its cold resume.
    const resumeGate = Promise.withResolvers<undefined>()
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (id, options) => {
      if (options?.signal?.aborted !== true) await resumeGate.promise
      return observe(id, options)
    })
    const failing = ctx.subagents.sendMessage(managedAgent, child.childId, text('a'), { signal: AbortSignal.abort(new Error('sender cancelled')) })
    const resuming = ctx.subagents.sendMessage(managedAgent, child.childId, text('b'), { signal })
    await expect(failing).rejects.toThrow('sender cancelled')
    expect(managedActivation.ownedChildren.has(child.childId), 'the remaining delivery still holds the edge').toBe(true)

    resumeGate.resolve(undefined)
    await expect(resuming).resolves.toBeTypeOf('string')
    parentTurn.resolve(undefined)
    await ctx.subagents.drainDescendants([parent])
  })
})

describe('selected drain', () => {
  it('releases a child that a creation already holding its lock publishes after the drain began', async () => {
    const adapter = new GatedAdapter([{ chunks: textResponse('never reached'), gate: new Promise(() => {}) }])
    const { ctx, parent } = await localSetup(adapter)
    const childId = SessionId('00000000-0000-4000-8000-000000000777')
    const { locks, resident } = managerState(ctx)
    const window = Promise.withResolvers<undefined>()
    void locks.run(childId, () => window.promise)
    const creating = ctx.subagents.startActivation({
      provider: 'spawn', label: 'member', signal, delivery: 'caller', request: { prompt: text('task'), parent }, childId,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const draining = ctx.subagents.drainChildren(parent, [childId])
    window.resolve(undefined)
    const started = await creating
    await draining
    expect(resident.has(childId)).toBe(false)
    await expect(started.result).resolves.toMatchObject({ stopReason: 'aborted' })
  })

  it('orders a delivery that reaches the manager after the drain began behind the drain', async () => {
    const childTurn = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: childTurn.promise },
      { chunks: textResponse('resumed') },
    ])
    const { ctx, parent } = await localSetup(adapter)
    const started = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'member', signal, delivery: 'caller', request: { prompt: text('task'), parent },
    })
    const child = ctx.agents.get(started.childId)!
    await waitForStatus(ctx, child, 'running')
    const draining = ctx.subagents.drainChildren(parent, [started.childId])
    const delivery = ctx.subagents.sendMessage(parent, started.childId, text('after the stop'), { signal })
    await draining
    await expect(delivery).resolves.toBeTypeOf('string')
    expect(managerState(ctx).resident.has(started.childId)).toBe(true)
    await ctx.subagents.drainDescendants([parent])
  })
})
