import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { logPath } from '../../../session/session-persistence-jsonl/src/format.ts'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId, WorkstreamPartialHandoffError } from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(maxSnapshotBytes?: number, script?: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService, maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script ?? Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner, fiber, sessionDir: dir }
}

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }
function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = () => { done() } })
  return { promise, resolve }
}

function request(name: string) {
  return { operationId: WorkstreamOperationId(`create-${name}`), name, description: `${name} responsibility`, provider:
    'spawn', prompt: `${name} initial`, signal }
}

describe('round-2 Workstream review', () => {
  it('F1 includes a direct Ticket creation queued after the final empty list', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    const moving = ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id })
    const late = ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
      { subject: 'Arrived at the commit gap', description: '', coordinatorId: owner.id }))
    await moving
    const ticket = await late
    expect(ctx.workstreams.get(owner, owner.id).coordinatorId).toBe(member.id)
    const events = owner.session.snapshotEvents()
    expect(events.some(event => event.type === 'ticket/state' && event.data.ticket.id === ticket.id)).toBe(true)
    expect(events.some(event => event.type === 'workstream/state' && event.data.snapshot.coordinatorId === member.id)).toBe(true)
    // Whether the creation lands before the snapshot (and is moved) or after it (and derives the new coordinator),
    // Ticket and Workstream must agree once the handoff succeeded.
    expect(ctx.tickets.get(owner.session, ticket.id).coordinatorId,
      'successful handoff must leave the racing Ticket with the new coordinator').toBe(member.id)
  })

  it('F1 moves a direct Ticket created while an earlier Ticket moves and one created after the snapshot append', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    const first = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'First', description: '' })
    const original = ctx.tickets.handoff.bind(ctx.tickets)
    const entered = deferred(), release = deferred()
    vi.spyOn(ctx.tickets, 'handoff').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return original(...args)
    })
    const moving = ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id })
    try {
      await entered.promise
      const during = await ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
        { subject: 'Created mid-move', description: '', coordinatorId: owner.id }))
      expect(during.coordinatorId).toBe(owner.id)
      release.resolve()
      await moving
      const after = await ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
        { subject: 'Created after commit', description: '', coordinatorId: owner.id }))
      for (const ticket of [first, during, after]) expect(ctx.tickets.get(owner.session, ticket.id).coordinatorId).toBe(member.id)
    } finally { release.resolve(); await Promise.allSettled([moving]) }
  })

  it('F2 stops re-listing on shutdown instead of mutating more Tickets', async () => {
    const { ctx, owner, fiber } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Can be handed back', description: '' })
    const original = ctx.tickets.handoff.bind(ctx.tickets)
    const entered = deferred(), release = deferred(), continued = deferred(), shuttingDown = deferred()
    const service = ctx.workstreams
    // oxlint-disable-next-line typescript/unbound-method -- called back with the real receiver by the spy below.
    const abort = AbortController.prototype.abort
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort').mockImplementation(function (this: AbortController, reason?: unknown) {
      abort.call(this, reason)
      if (reason instanceof Error && 'code' in reason && reason.code === 'WORKSTREAM_DISPOSED') shuttingDown.resolve()
    })
    let calls = 0, stopChurn = false
    vi.spyOn(ctx.tickets, 'handoff').mockImplementation(async (session, input) => {
      const moved = await original(session, input)
      if (!stopChurn) {
        await ctx.agents.withInitiator(owner, () => original(session, { ticketId: moved.id,
          expectedRevision: moved.revision, actorId: owner.id, newCoordinatorId: owner.id }))
        calls++
        if (calls === 1) { entered.resolve(); await release.promise }
        if (calls === 2) continued.resolve()
      }
      return moved
    })
    const moving = ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id })
    const observed = moving.then(() => 'committed', () => 'rejected')
    let disposal: Promise<void> | undefined
    try {
      await entered.promise
      disposal = fiber.dispose()
      await shuttingDown.promise
      expect(() => service.get(owner, owner.id)).toThrow(expect.objectContaining({ code: 'WORKSTREAM_DISPOSED' }))
      release.resolve()
      const outcome = await Promise.race([observed, continued.promise.then(() => 'continued handoff after shutdown')])
      expect(outcome, `handoff calls after shutdown request: ${calls}`).toBe('rejected')
    } finally {
      stopChurn = true; release.resolve()
      await Promise.allSettled([moving, ...(disposal === undefined ? [] : [disposal])])
      abortSpy.mockRestore()
    }
  })

  it('F2 ends with a partial outcome instead of re-listing forever when a competing writer hands a moved Ticket back', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Handed back', description: '' })
    const original = ctx.tickets.handoff.bind(ctx.tickets)
    let calls = 0
    vi.spyOn(ctx.tickets, 'handoff').mockImplementation(async (session, input) => {
      const moved = await original(session, input)
      calls++
      return ctx.agents.withInitiator(owner, () => original(session, { ticketId: moved.id,
        expectedRevision: moved.revision, actorId: owner.id, newCoordinatorId: owner.id }))
    })
    const before = ctx.workstreams.get(owner, owner.id)
    const failure = await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: before.revision, coordinatorId: member.id }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkstreamPartialHandoffError)
    expect(failure).toMatchObject({ code: 'WORKSTREAM_PARTIAL_HANDOFF', moved: [ticket.id], pending: [ticket.id] })
    expect(failure instanceof Error ? failure.cause : undefined).toMatchObject({ code: 'WORKSTREAM_CONFLICT' })
    expect(calls).toBe(1)
    expect(ctx.workstreams.get(owner, owner.id)).toMatchObject({ coordinatorId: owner.id, revision: before.revision })
  })

  it('F1 gives a direct Ticket created after the handoff snapshot the new coordinator', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id })
    const direct = await ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
      { subject: 'Direct after handoff', description: '', coordinatorId: owner.id }))
    expect(direct.coordinatorId).toBe(member.id)
    await ctx.workstreams.endTicket(ctx.agents.get(member.id)!, owner.id, { ticketId: direct.id,
      expectedRevision: direct.revision, summary: 'Cancelled by the sitting coordinator' }).catch((error: unknown) => {
      // Completion checks may refuse a Ticket with no work; authority must not be the reason.
      expect(error).not.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
    })
  })

  it('F4 never reports an open retry as committed while its first snapshot is still unpersisted', async () => {
    const { ctx, sessionDir } = await setup()
    const owner = await ctx.agentLoop.create(SessionId('new-owner'), { provider: 'mock', model: 'mock' })
    await ctx.sessions.flush(owner.session)
    // oxlint-disable-next-line typescript/unbound-method -- called back with the real handle by the spy below.
    const drain = JsonlSessionHandle.prototype.drainLive
    const failure = new Error('review: disk drain unavailable')
    const spy = vi.spyOn(JsonlSessionHandle.prototype, 'drainLive').mockImplementation(function (this: JsonlSessionHandle) {
      if (this.id === owner.id) return Promise.reject(failure)
      return drain.call(this)
    })
    const input = { operationId: WorkstreamOperationId('failed-open'), title: 'Durable open' }
    try {
      await expect(ctx.workstreams.open(owner, input)).rejects.toThrow('disk drain unavailable')
      const file = logPath(sessionDir, owner.session.header.cwd, owner.id, 'none')
      // While the storage failure continues, a retry must report it instead of the unpersisted snapshot.
      await expect(ctx.workstreams.open(owner, input)).rejects.toThrow('disk drain unavailable')
      expect(readFileSync(file, 'utf8').includes('"type":"workstream/state"')).toBe(false)
      spy.mockRestore()
      expect(await ctx.workstreams.open(owner, input)).toMatchObject({ ownerSessionId: owner.id })
      expect(readFileSync(file, 'utf8').includes('"type":"workstream/state"'),
        'a successful open retry must have a physically retained snapshot').toBe(true)
    } finally { spy.mockRestore(); await ctx.sessions.flush(owner.session) }
  })

  it('C6 reports and recovers a final handoff flush failure after Tickets already moved', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Must recover', description: '' })
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let failed = false
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!failed && session === owner.session && ctx.workstreams.get(owner, owner.id).coordinatorId === member.id) {
        failed = true
        throw new Error('review: final snapshot flush failed')
      }
      return flush(session)
    })
    await expect(ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    expect(ctx.tickets.get(owner.session, ticket.id).coordinatorId).toBe(member.id)
    const result = await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id })
    expect(result.coordinatorId).toBe(member.id)
    const handle = await ctx.sessionPersistence.open(owner.id, 'read')
    try {
      const states = (await handle.read(0)).events.filter(event => event.type === 'workstream/state')
      expect(states.at(-1)?.data.snapshot.coordinatorId).toBe(member.id)
    } finally { await handle.close() }
  })

  it('C2 finishes only the already-admitted stop after its coordinator is revoked', async () => {
    const { ctx, owner } = await setup()
    const coordinator = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    const worker = await ctx.workstreams.addMember(owner, owner.id, request('worker'))
    const caller = ctx.agents.get(coordinator.id)!
    await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: coordinator.id })
    const entered = deferred(), release = deferred()
    const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'drainChildren').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return drain(...args)
    })
    const stopping = ctx.workstreams.stop(caller, owner.id, worker.id)
    const observed = stopping.then(() => 'committed', () => 'rejected')
    try {
      await entered.promise
      await ctx.workstreams.handoff(owner, owner.id,
        { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: owner.id })
      await ctx.workstreams.stop(owner, owner.id, coordinator.id)
      expect(ctx.agents.get(caller.id)).toBeUndefined()
      release.resolve()
      expect(await observed).toBe('committed')
      expect(ctx.workstreams.get(owner, owner.id).members.find(member => member.id === worker.id)?.phase).toBe('stopped')
    } finally { release.resolve(); await Promise.allSettled([stopping]) }
  })

  it('C1 concurrent stops of one member both await the same real child settlement', async () => {
    const { ctx, owner } = await setup()
    const worker = await ctx.workstreams.addMember(owner, owner.id, request('worker'))
    const entered = deferred(), release = deferred()
    const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'drainChildren').mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; return drain(...args)
    })
    const first = ctx.workstreams.stop(owner, owner.id, worker.id)
    await entered.promise
    const second = ctx.workstreams.stop(owner, owner.id, worker.id)
    try {
      release.resolve()
      expect(await first).toMatchObject({ id: worker.id, phase: 'stopped' })
      expect(await second).toMatchObject({ id: worker.id, phase: 'stopped' })
      expect(ctx.agents.get(worker.id)).toBeUndefined()
      const stops = owner.session.snapshotEvents().filter(event => event.type === 'workstream/state'
        && event.data.snapshot.members.find(member => member.id === worker.id)?.phase === 'stopped')
      expect(stops).toHaveLength(1)
    } finally { release.resolve(); await Promise.allSettled([first, second]) }
  })

  it('C3 reconciles and cold-resumes a provisioning child drained after acceptance', async () => {
    const { ctx, owner } = await setup()
    const original = ctx.subagents.startActivation.bind(ctx.subagents)
    const abort = new AbortController()
    vi.spyOn(ctx.subagents, 'startActivation').mockImplementationOnce(async (...args) => {
      const started = await original(...args)
      // Cancellation after durable acceptance but before addMember's confirmation.
      abort.abort(new Error('caller canceled after acceptance'))
      return started
    })
    const input = { ...request('canceled'), signal: abort.signal }
    await expect(ctx.workstreams.addMember(owner, owner.id, input)).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    const pending = ctx.workstreams.get(owner, owner.id).members.find(member => member.name === 'canceled')!
    expect(ctx.agents.get(pending.id)).toBeUndefined()
    const retry = await ctx.workstreams.addMember(owner, owner.id, { ...input, signal })
    expect(retry.phase).toBe('active')
    const sent = await ctx.workstreams.sendMessage(owner, owner.id, { operationId: WorkstreamOperationId('after-reconcile'),
      targetId: retry.id, text: 'Continue after cancellation', signal })
    expect(sent.delivery.phase).toBe('accepted')
    expect(ctx.agents.get(retry.id)).toBeDefined()
  })
})
