import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'
import { WorkstreamTools } from '../src/tools.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-r5-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner, fiber }
}

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }
function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = () => { done() } })
  return { promise, resolve }
}

describe('round-5 Workstream review', () => {
  it('R5-M1 addMember settles when its caller cancels after the new child queued a Workstream tool', async () => {
    // The new member's first model response calls a root-queued Workstream tool, as an initial prompt such as
    // "report to the owner when you start" produces.
    let disposing: Promise<string> | undefined
    const { ctx, owner, fiber } = await setup([toolCallResponse('child-send', 'workstream_send', {
      root_session_id: 'owner', operation_id: 'first-report', target_id: 'owner', text: 'Started',
    }), 'hang'])
    await ctx.plugin(WorkstreamTools)
    const childFlushEntered = deferred(), childFlushRelease = deferred()
    const sendQueued = deferred(), drainEntered = deferred(), rescue = deferred()
    // Hold only the post-acceptance flush of the new child Session, so the child's first tool call is queued
    // behind addMember while addMember still owns the root queue. Production storage latency has the same effect.
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let held = false
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!held && session !== owner.session && session.header.parentSession === owner.id) {
        held = true; childFlushEntered.resolve(); await childFlushRelease.promise
      }
      return flush(session)
    })
    const send = ctx.workstreams.sendMessage.bind(ctx.workstreams)
    let childSend: Promise<string> | undefined
    vi.spyOn(ctx.workstreams, 'sendMessage').mockImplementation((...args) => {
      const queued = send(...args); childSend = queued.then(() => 'settled', () => 'settled'); sendQueued.resolve(); return queued
    })
    const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
    let realDrain: Promise<void> | undefined
    let drainState: Promise<string> | undefined
    vi.spyOn(ctx.subagents, 'drainChildren').mockImplementationOnce(async (...args) => {
      realDrain = drain(...args); drainState = realDrain.then(() => 'settled', () => 'settled'); drainEntered.resolve()
      // Released only after the hang is observed, so the deadlocked child does not outlive the test.
      await Promise.race([realDrain, rescue.promise])
    })
    // The owner's workstream_add_member tool call is cancelled (for example, the user stops the turn).
    const cancel = new AbortController()
    const adding = ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('create-worker'),
      name: 'worker', description: 'worker responsibility', provider: 'spawn', prompt: 'Report when you start', signal: cancel.signal })
    const settled = adding.then(() => 'settled', () => 'settled')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await childFlushEntered.promise
      await sendQueued.promise
      cancel.abort(new Error('user stopped the turn'))
      childFlushRelease.resolve()
      await drainEntered.promise
      const outcome = await Promise.race([
        settled,
        new Promise<string>((resolve) => { timer = setTimeout(() => { resolve('deadlocked') }, 1000) }),
      ])
      if (outcome === 'deadlocked') {
        // Establish the circular wait rather than slowness: the real drain waits for the child's started send,
        // and that send waits for the root queue that addMember holds while awaiting the drain.
        const pending = (state: Promise<string> | undefined) => Promise.race([state, Promise.resolve('pending')])
        expect(await pending(drainState)).toBe('pending')
        expect(await pending(childSend)).toBe('pending')
        expect(ctx.workstreams.get(owner, owner.id).messages).toEqual([])
        // Service shutdown awaits pending operations, so unloading or reloading Workstream hangs too.
        disposing = fiber.dispose().then(() => 'disposed', () => 'disposed')
        const unload = await Promise.race([disposing,
          new Promise<string>((resolve) => { setTimeout(() => { resolve('hung') }, 300) })])
        expect(unload).toBe('hung')
      }
      expect(outcome, 'a cancelled addMember must not drain its child while holding the root queue the child waits on')
        .toBe('settled')
    } finally {
      clearTimeout(timer); childFlushRelease.resolve(); rescue.resolve()
      await adding.catch(() => undefined)
      await realDrain
      await disposing
    }
  })

  it('R5-N1 an accepted send stays retryable after its recipient is stopped', async () => {
    const { ctx, owner } = await setup(['hang', 'hang', 'hang'])
    const signal = new AbortController().signal
    const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('create-worker'),
      name: 'worker', description: 'worker responsibility', provider: 'spawn', prompt: 'Work', signal })
    const send = { operationId: WorkstreamOperationId('handover'), targetId: member.id, text: 'Take this', signal }
    const accepted = await ctx.workstreams.sendMessage(owner, owner.id, send)
    expect(accepted.delivery.phase).toBe('accepted')
    await ctx.workstreams.stop(owner, owner.id, member.id)
    const retry = await ctx.workstreams.sendMessage(owner, owner.id, send).then(value => ({ value }), (error: unknown) => ({ error }))
    expect(retry, 'the same-operation retry of a durably accepted send must return its receipt').toEqual({ value: accepted })
  })

  it('R5-N4 workstream_list returns no Workstream, not an error, for a non-member child of the root', async () => {
    const { ctx, owner } = await setup(['hang', 'hang', 'hang'])
    const signal = new AbortController().signal
    const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('create-worker'),
      name: 'worker', description: 'worker responsibility', provider: 'spawn', prompt: 'Work', signal })
    await ctx.workstreams.stop(owner, owner.id, member.id)
    await ctx.agents.resume({ resumeSessionId: member.id, parentAgent: owner,
      agentOptions: { provider: 'mock', model: 'mock' } })
    const stopped = ctx.agents.get(member.id)
    if (stopped === undefined) throw new Error('Expected the resumed stopped member to be live')
    const listed = (() => { try { return { value: ctx.workstreams.list(stopped) } } catch (error: unknown) { return { error } } })()
    expect(listed, 'list is documented as the caller\'s visible memberships').toEqual({ value: [] })
  })

  // R5-N5 (the profile's direct `ticket_assign` bypassing the active-member rule) is enforced and tested in the
  // Workstream profile (workstream-profile/tests/ticket-assignment.spec.ts): Ticket has no assignment-authority seam.

  it('R5-C1 control: the same cancellation settles as WORKSTREAM_UNKNOWN when the child has no queued Workstream tool', async () => {
    const { ctx, owner } = await setup(['hang', 'hang'])
    const childFlushEntered = deferred(), childFlushRelease = deferred()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let held = false
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!held && session !== owner.session && session.header.parentSession === owner.id) {
        held = true; childFlushEntered.resolve(); await childFlushRelease.promise
      }
      return flush(session)
    })
    const cancel = new AbortController()
    const adding = ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('create-worker'),
      name: 'worker', description: 'worker responsibility', provider: 'spawn', prompt: 'Work quietly', signal: cancel.signal })
    try {
      await childFlushEntered.promise
      cancel.abort(new Error('user stopped the turn'))
      childFlushRelease.resolve()
      await expect(adding).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
      expect(ctx.workstreams.get(owner, owner.id).members.find(member => member.name === 'worker')?.phase).toBe('provisioning')
    } finally { childFlushRelease.resolve(); await adding.catch(() => undefined) }
  })
})
