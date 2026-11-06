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
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'

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

function request(name: string) {
  return { operationId: WorkstreamOperationId(`create-${name}`), name, description: `${name} responsibility`, provider:
    'spawn', prompt: `${name} initial`, signal }
}

describe('round-3 Workstream review', () => {
  it('F1 rejects a disposed successor even when no Ticket needs moving', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    await ctx.subagents.drainChildren(owner, [member.id])
    expect(ctx.agents.get(member.id)).toBeUndefined()
    const before = ctx.workstreams.get(owner, owner.id)
    const direct = await ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
      { subject: 'Ticket live-successor control', description: '' }))
    await expect(ctx.agents.withInitiator(owner, () => ctx.tickets.handoff(owner.session,
      { ticketId: direct.id, expectedRevision: direct.revision, actorId: owner.id, newCoordinatorId: member.id })))
      .rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
    await ctx.agents.withInitiator(owner, () => ctx.tickets.cancel(owner.session,
      { ticketId: direct.id, expectedRevision: direct.revision, actorId: owner.id, summary: 'No open Tickets in this case' }))
    expect(before.members.find(candidate => candidate.id === member.id)?.phase).toBe('active')
    const result = await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: before.revision, coordinatorId: member.id }).then(() => 'committed', () => 'rejected')
    expect(result, 'handoff must not commit a coordinator that Ticket handoff rejects as not live').toBe('rejected')
    expect(ctx.workstreams.get(owner, owner.id)).toEqual(before)
  })

  it('F1 rechecks successor liveness after the final Ticket move', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Move then dispose', description: '' })
    const handoff = ctx.tickets.handoff.bind(ctx.tickets)
    vi.spyOn(ctx.tickets, 'handoff').mockImplementationOnce(async (...args) => {
      const result = await handoff(...args)
      await ctx.subagents.drainChildren(owner, [member.id])
      return result
    })
    const before = ctx.workstreams.get(owner, owner.id)
    const outcome = await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: before.revision, coordinatorId: member.id }).then(() => 'committed', () => 'rejected')
    expect(ctx.tickets.get(owner.session, ticket.id).coordinatorId).toBe(member.id)
    expect(ctx.agents.get(member.id)).toBeUndefined()
    expect(outcome, 'successor vanished after its Ticket move and before the Workstream commit').toBe('rejected')
    expect(ctx.workstreams.get(owner, owner.id)).toEqual(before)
  })

  it('C1 rejects a durably stopped successor before any Ticket or snapshot append', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('stopped'))
    await ctx.workstreams.stop(owner, owner.id, member.id)
    const before = owner.session.snapshotEvents().length
    await expect(ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT' })
    expect(owner.session.snapshotEvents()).toHaveLength(before)
  })

  it('C2 partial move to a successor that disappears can recover to the live owner', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    const first = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'First', description: '' })
    const second = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Second', description: '' })
    const handoff = ctx.tickets.handoff.bind(ctx.tickets)
    vi.spyOn(ctx.tickets, 'handoff').mockImplementationOnce(async (...args) => {
      const result = await handoff(...args)
      await ctx.subagents.drainChildren(owner, [member.id])
      return result
    })
    const before = ctx.workstreams.get(owner, owner.id)
    await expect(ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: before.revision, coordinatorId: member.id }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_PARTIAL_HANDOFF', moved: [first.id], pending: [second.id] })
    expect(ctx.workstreams.get(owner, owner.id)).toEqual(before)
    await ctx.workstreams.handoff(owner, owner.id, { expectedRevision: before.revision, coordinatorId: owner.id })
    expect(ctx.tickets.list(owner.session).map(ticket => ticket.coordinatorId)).toEqual([owner.id, owner.id])
  })

  it('F2 reproduces the reload race with real services and no readiness mock', async () => {
    const { ctx, owner, fiber } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id })
    await fiber.dispose()
    await ctx.agents.resume({ resumeSessionId: member.id, parentAgent: owner,
      agentOptions: { provider: 'mock', model: 'mock' } })
    const reloading = ctx.plugin(WorkstreamService)
    const creating = ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
      { subject: 'Concurrent reload and creation', description: '' }))
    const [, admission] = await Promise.all([reloading, creating.then(ticket => ({ ticket }), (error: unknown) => ({ error }))])
    expect(ctx.workstreams.get(owner, owner.id).coordinatorId).toBe(member.id)
    // An owner-default creation admitted during the load is refused with nothing appended; it never records the owner.
    // Ticket wraps a refusing coordinator authority and keeps the Workstream refusal as the cause.
    expect(admission, 'reload and direct Ticket creation must not commit different coordinators')
      .toMatchObject({ error: { code: 'TICKET_RECOVERY_FAILED', cause: { code: 'WORKSTREAM_NOT_READY' } } })
    expect(ctx.tickets.list(owner.session)).toEqual([])
    const retried = await ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
      { subject: 'After reload', description: '' }))
    expect(retried.coordinatorId).toBe(member.id)
  })

  it('F2 leaves an explicit non-owner coordinator alone while the Workstream loads', async () => {
    const { ctx, owner, fiber } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    await fiber.dispose()
    // Ticket accepts only a live coordinator, so the member is resumed after the Workstream fiber disposed it.
    await ctx.agents.resume({ resumeSessionId: member.id, parentAgent: owner,
      agentOptions: { provider: 'mock', model: 'mock' } })
    const reloading = ctx.plugin(WorkstreamService)
    const explicit = await ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
      { subject: 'Explicit member', description: '', coordinatorId: member.id }))
    expect(explicit.coordinatorId).toBe(member.id)
    await reloading
  })

  it('C3 coordinator authority is removed on disposal and returns on a completed reload', async () => {
    const { ctx, owner, fiber } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id })
    const direct = () => ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
      { subject: 'Direct', description: '' }))
    expect((await direct()).coordinatorId).toBe(member.id)
    await fiber.dispose()
    expect((await direct()).coordinatorId).toBe(owner.id)
    // Ticket accepts only a live coordinator, so the member is resumed after the Workstream fiber disposed it.
    await ctx.agents.resume({ resumeSessionId: member.id, parentAgent: owner,
      agentOptions: { provider: 'mock', model: 'mock' } })
    await ctx.plugin(WorkstreamService)
    expect((await direct()).coordinatorId).toBe(member.id)
  })

  it('C4 explicit non-owner coordination remains the documented caller choice', async () => {
    const { ctx, owner } = await setup()
    const first = await ctx.workstreams.addMember(owner, owner.id, request('first'))
    const second = await ctx.workstreams.addMember(owner, owner.id, request('second'))
    await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: first.id })
    const ticket = await ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session,
      { subject: 'Explicit second', description: '', coordinatorId: second.id }))
    expect(ticket.coordinatorId).toBe(second.id)
    await ctx.workstreams.handoff(owner, owner.id,
      { expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: first.id })
    expect(ctx.tickets.get(owner.session, ticket.id).coordinatorId).toBe(first.id)
  })
})

describe('round-3 Workstream durability controls', () => {
  for (const kind of ['member', 'send', 'acknowledge', 'stop'] as const) {
    it(`C5 ${kind} retries propagate storage failure and never append a duplicate result`, async () => {
      const { ctx, owner, sessionDir } = await setup()
      const input = request('worker')
      const member = kind === 'member' ? undefined : await ctx.workstreams.addMember(owner, owner.id, input)
      const messageInput = { operationId: WorkstreamOperationId('send-once'), targetId: member?.id ?? owner.id,
        text: 'One message', signal }
      if (kind === 'acknowledge') await ctx.workstreams.sendMessage(owner, owner.id, messageInput)
      // oxlint-disable-next-line typescript/unbound-method -- called back with the real handle by the spy below.
      const originalDrain = JsonlSessionHandle.prototype.drainLive
      const storageFailure = new Error('review-r3: drain unavailable')
      const spy = vi.spyOn(JsonlSessionHandle.prototype, 'drainLive').mockImplementation(function (this: JsonlSessionHandle) {
        const snapshot = ctx.workstreams.get(owner, owner.id)
        const reject = kind === 'member' ? snapshot.members.some(item => item.name === 'worker' && item.phase === 'active')
          : kind === 'send' ? snapshot.messages.some(item => item.delivery.phase === 'accepted') : true
        if (this.id === owner.id && reject) return Promise.reject(storageFailure)
        return originalDrain.call(this)
      })
      const run = () => {
        if (kind === 'member') return ctx.workstreams.addMember(owner, owner.id, input)
        if (kind === 'send') return ctx.workstreams.sendMessage(owner, owner.id, messageInput)
        if (kind === 'stop') return ctx.workstreams.stop(owner, owner.id, member!.id)
        return ctx.workstreams.acknowledge(ctx.agents.get(member!.id)!, owner.id, messageInput.operationId)
      }
      try {
        await expect(run()).rejects.toBeInstanceOf(Error)
        await expect(run()).rejects.toBeInstanceOf(Error)
        if (kind === 'stop') await expect(run()).rejects.toBeInstanceOf(Error)
        const beforeRetry = owner.session.snapshotEvents().length
        spy.mockRestore()
        await run()
        expect(owner.session.snapshotEvents()).toHaveLength(beforeRetry)
        const file = readFileSync(logPath(sessionDir, owner.session.header.cwd, owner.id, 'none'), 'utf8')
        const physicalStates = file.split('\n').filter(line => line.includes('"type":"workstream/state"'))
        const liveStates = owner.session.snapshotEvents().filter(event => event.type === 'workstream/state')
        expect(physicalStates).toHaveLength(liveStates.length)
      } finally { spy.mockRestore(); await ctx.sessions.flush(owner.session) }
    })
  }
})
