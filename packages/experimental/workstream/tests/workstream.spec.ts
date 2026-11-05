import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService, { TicketCandidateId } from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'
import { WorkstreamTools } from '../src/tools.ts'

const contexts: Context[] = []
const directories: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner, fiber }
}

async function logged(ctx: Context, id: SessionId) {
  const session = ctx.sessions.get(id)
  if (session !== undefined) await ctx.sessions.flush(session)
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try { return (await handle.read(0)).events } finally { await handle.close() }
}

function request(name: string) {
  return { operationId: WorkstreamOperationId(`create-${name}`), name, description: `${name} responsibility`, provider:
    'spawn', prompt: `${name} initial`, signal }
}

describe('durable Workstream authority and delivery', () => {
  it('provisions two real members, deduplicates peer delivery and preserves parent on handoff', async () => {
    const { ctx, owner } = await setup()
    const first = await ctx.workstreams.addMember(owner, owner.id, request('first'))
    const second = await ctx.workstreams.addMember(owner, owner.id, request('second'))
    const firstAgent = ctx.agents.get(first.id)
    const secondAgent = ctx.agents.get(second.id)
    if (firstAgent === undefined || secondAgent === undefined) throw new Error('Expected resident continuable members')
    expect((await ctx.workstreams.addMember(owner, owner.id, request('first'))).id).toBe(first.id)
    const send = { operationId: WorkstreamOperationId('peer-send'), targetId: second.id, text: 'Review the result', signal }
    const accepted = await ctx.workstreams.sendMessage(firstAgent, owner.id, send)
    expect(accepted.delivery.phase).toBe('accepted')
    expect(await ctx.workstreams.sendMessage(firstAgent, owner.id, send)).toEqual(accepted)
    expect(ctx.workstreams.get(owner, owner.id).messages).toHaveLength(1)
    expect((await ctx.workstreams.acknowledge(secondAgent, owner.id, send.operationId)).delivery.phase).toBe('processed')
    await expect(ctx.workstreams.acknowledge(firstAgent, owner.id, send.operationId)).rejects.toMatchObject({ code:
      'WORKSTREAM_UNAUTHORIZED' })
    const before = ctx.workstreams.get(owner, owner.id)
    const changed = await ctx.workstreams.handoff(owner, owner.id, { expectedRevision: before.revision, coordinatorId: first.id })
    expect(changed.ownerSessionId).toBe(owner.id)
    expect(secondAgent.session.header.parentSession).toBe(owner.id)
    expect(ctx.workstreams.requireMembership(firstAgent, owner.id).owner).toBe(owner)
    ctx.workstreams.interrupt(firstAgent, owner.id, second.id)
    const ticket = await ctx.workstreams.createTicket(secondAgent, owner.id, { subject: 'Peer proposal', description: 'Shared root work' })
    expect(ctx.tickets.get(owner.session, ticket.id)).toEqual(ticket)
    await expect(ctx.workstreams.assignTicket(secondAgent, owner.id, { ticketId: ticket.id, expectedRevision:
      ticket.revision, ownerId: second.id, subject: 'Denied' })).rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
    const assigned = await ctx.workstreams.assignTicket(firstAgent, owner.id, { ticketId: ticket.id, expectedRevision:
      ticket.revision, ownerId: second.id, subject: 'Contribute' })
    expect(assigned.assignments[0]?.ownerId).toBe(second.id)
    await expect(ctx.workstreams.handoff(firstAgent, owner.id, { expectedRevision: before.revision, coordinatorId: second.id,
    })).rejects.toMatchObject({ code: 'WORKSTREAM_CONFLICT' })
    expect((await ctx.workstreams.stop(firstAgent, owner.id, second.id)).phase).toBe('stopped')
    expect(ctx.agents.get(second.id)).toBeUndefined()
  })

  it('moves Ticket coordinator authority with Workstream handoff and records the acting coordinator', async () => {
    const { ctx, owner } = await setup()
    const memberA = await ctx.workstreams.addMember(owner, owner.id, request('coord-a'))
    const memberB = await ctx.workstreams.addMember(owner, owner.id, request('coord-b'))
    const agentA = ctx.agents.get(memberA.id)
    const agentB = ctx.agents.get(memberB.id)
    if (agentA === undefined || agentB === undefined) throw new Error('Expected resident continuable members')
    const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Authority', description: 'Hand off coordination' })
    expect(ticket.coordinatorId).toBe(owner.id)
    const assigned = await ctx.workstreams.assignTicket(owner, owner.id, { ticketId: ticket.id, expectedRevision: ticket.revision,
      ownerId: memberA.id, subject: 'Initial work' })
    await ctx.workstreams.handoff(owner, owner.id, { expectedRevision: ctx.workstreams.get(owner, owner.id).revision,
      coordinatorId: memberA.id })
    await ctx.workstreams.handoff(agentA, owner.id, { expectedRevision: ctx.workstreams.get(owner, owner.id).revision,
      coordinatorId: memberB.id })
    const handed = ctx.tickets.get(owner.session, ticket.id)
    expect(handed.coordinatorId).toBe(memberB.id)
    expect(handed.revision).toBeGreaterThan(assigned.revision)
    await expect(ctx.workstreams.assignTicket(agentA, owner.id, { ticketId: ticket.id, expectedRevision: handed.revision,
      ownerId: memberA.id, subject: 'Stale coordinator' })).rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
    await expect(ctx.workstreams.endTicket(agentA, owner.id, { ticketId: ticket.id, expectedRevision: handed.revision,
      summary: 'Stale coordinator' })).rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
    const reported = await ctx.tickets.report(owner.session, { ticketId: ticket.id, expectedRevision: handed.revision,
      actorId: memberA.id, assignmentId: assigned.assignments[0]!.id, kind: 'result', summary: 'Built' })
    const candidate = await ctx.tickets.submitCandidate(owner.session, { ticketId: ticket.id, expectedRevision: reported.revision,
      actorId: memberB.id, candidateId: TicketCandidateId('candidate-1'), specRevision: reported.specification.revision,
      content: { kind: 'commit', repository: 'repo', commit: 'a'.repeat(40) }, assignmentIds: [assigned.assignments[0]!.id] })
    const ended = await ctx.workstreams.endTicket(agentB, owner.id, { ticketId: ticket.id, expectedRevision: candidate.revision,
      summary: 'Closed by the new coordinator' })
    expect(ended.terminalOutcome).toMatchObject({ kind: 'completed', actorId: memberB.id })
    const fresh = await ctx.workstreams.createTicket(agentB, owner.id, { subject: 'Created after handoff', description: '' })
    expect(fresh.coordinatorId).toBe(memberB.id)
    const second = await ctx.workstreams.assignTicket(agentB, owner.id, { ticketId: fresh.id, expectedRevision: fresh.revision,
      ownerId: memberA.id, subject: 'Follow-up work' })
    expect(second.assignments[0]?.ownerId).toBe(memberA.id)
    await expect(ctx.workstreams.assignTicket(agentA, owner.id, { ticketId: fresh.id, expectedRevision: second.revision,
      ownerId: memberA.id, subject: 'Stale coordinator' })).rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
    // The technical owner stays the runtime parent and must reclaim coordination to mutate Tickets.
    expect(agentA.session.header.parentSession).toBe(owner.id)
    expect(agentB.session.header.parentSession).toBe(owner.id)
    await expect(ctx.workstreams.assignTicket(owner, owner.id, { ticketId: fresh.id, expectedRevision: second.revision,
      ownerId: memberB.id, subject: 'Owner without role' })).rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
    await ctx.workstreams.handoff(owner, owner.id, { expectedRevision: ctx.workstreams.get(owner, owner.id).revision,
      coordinatorId: owner.id })
    expect(ctx.tickets.get(owner.session, fresh.id).coordinatorId).toBe(owner.id)
    expect(ctx.tickets.get(owner.session, ticket.id).terminalOutcome?.actorId).toBe(memberB.id)
  })

  it('reports a typed retryable partial handoff and commits the coordinator only after every Ticket moved', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('partial'))
    const first = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'First', description: '' })
    const second = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Second', description: '' })
    const before = ctx.workstreams.get(owner, owner.id)
    const original = ctx.tickets.handoff.bind(ctx.tickets)
    const move = vi.spyOn(ctx.tickets, 'handoff').mockImplementation(async (session, input) => {
      if (input.ticketId === second.id) throw new Error('append failed')
      return original(session, input)
    })
    await expect(ctx.workstreams.handoff(owner, owner.id, { expectedRevision: before.revision, coordinatorId: member.id }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_PARTIAL_HANDOFF', moved: [first.id], pending: [second.id] })
    expect(ctx.workstreams.get(owner, owner.id)).toEqual(before)
    expect(ctx.tickets.get(owner.session, first.id).coordinatorId).toBe(member.id)
    expect(ctx.tickets.get(owner.session, second.id).coordinatorId).toBe(owner.id)
    move.mockRestore()
    const done = await ctx.workstreams.handoff(owner, owner.id, { expectedRevision: before.revision, coordinatorId: member.id })
    expect(done.coordinatorId).toBe(member.id)
    expect(ctx.tickets.get(owner.session, second.id).coordinatorId).toBe(member.id)
    expect(ctx.tickets.get(owner.session, first.id).coordinatorId).toBe(member.id)
  })

  it('carries a bounded context packet through workstream_send to the recipient and the log', async () => {
    const { ctx, owner } = await setup()
    await ctx.plugin(WorkstreamTools)
    const child = await ctx.workstreams.addMember(owner, owner.id, request('packet'))
    const recipient = ctx.agents.get(child.id)
    if (recipient === undefined) throw new Error('Expected resident member')
    const send = ctx.tools.get('workstream_send')
    if (send === undefined) throw new Error('Expected workstream_send')
    const exec = { agent: owner, signal } as ToolRunContext
    const context = { requirements: 'Version 3', decisions: ['Use Tickets'], cursor: 'cursor-9', changes: 'Criteria changed',
      artifacts: [{ ref: 'artifact:7', digest: 'sha256:seven' }] }
    const result = await send.execute({ root_session_id: owner.id, operation_id: 'tool-packet', target_id: child.id,
      text: 'Read this', context }, exec)
    expect(result).toMatchObject({ context, delivery: { phase: 'accepted' } })
    expect(JSON.stringify(await logged(ctx, recipient.id))).toContain('Version 3')
    expect(JSON.stringify(await logged(ctx, owner.id))).toContain('sha256:seven')
    const oversize = { ...context, changes: 'x'.repeat(70_000) }
    await expect(send.execute({ root_session_id: owner.id, operation_id: 'tool-oversize', target_id: child.id, text: 'Too big',
      context: oversize }, exec)).rejects.toMatchObject({ code: 'WORKSTREAM_LIMIT' })
    expect(ctx.workstreams.get(owner, owner.id).messages.some(message => message.operationId === 'tool-oversize')).toBe(false)
    await expect(send.execute({ root_session_id: owner.id, operation_id: 'tool-bad-shape', target_id: child.id, text: 'Bad',
      context: { requirements: 1 } }, exec)).rejects.toThrow()
  })

  it('rejects exact-stale and foreign Agents on every root-authenticated operation', async () => {
    const { ctx, owner } = await setup()
    const foreign = await ctx.agentLoop.create(SessionId('foreign'), { provider: 'mock', model: 'mock' })
    expect(() => ctx.workstreams.get(foreign, owner.id)).toThrow(expect.objectContaining({ code: 'WORKSTREAM_UNAUTHORIZED' }))
    await expect(ctx.workstreams.createTicket(foreign, owner.id, { subject: 'No', description: '' })).rejects.toMatchObject({
      code: 'WORKSTREAM_UNAUTHORIZED' })
    const stale = { ...owner }
    expect(() => ctx.workstreams.get(stale, owner.id)).toThrow(expect.objectContaining({ code: 'WORKSTREAM_UNAUTHORIZED' }))
    await expect(ctx.workstreams.sendMessage(stale, owner.id, { operationId: WorkstreamOperationId('invalid'), targetId:
      foreign.id, text: 'No', signal })).rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
  })

  it('retains unknown provisioning through service replacement without launching again', async () => {
    const { ctx, owner, fiber } = await setup()
    const start = vi.spyOn(ctx.subagents, 'startActivation').mockRejectedValueOnce(new Error('connection lost'))
    await expect(ctx.workstreams.addMember(owner, owner.id, request('uncertain'))).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    expect(ctx.workstreams.get(owner, owner.id).members[1]?.phase).toBe('provisioning')
    await fiber.dispose()
    await ctx.plugin(WorkstreamService)
    await expect(ctx.workstreams.addMember(owner, owner.id, request('uncertain'))).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    expect(start).toHaveBeenCalledTimes(1)
    expect(ctx.workstreams.get(owner, owner.id).members[1]?.diagnostic).toContain('not yet confirmed')
  })

  it('retains uncertain delivery after interrupted target acceptance and never sends twice', async () => {
    const { ctx, owner, fiber } = await setup()
    const child = await ctx.workstreams.addMember(owner, owner.id, request('child'))
    const sender = ctx.agents.get(child.id)
    if (sender === undefined) throw new Error('Expected member')
    const steer = vi.spyOn(owner, 'steer').mockImplementationOnce(() => { throw new Error('Lost receipt') })
    const send = { operationId: WorkstreamOperationId('uncertain-send'), targetId: owner.id, text: 'Result', signal }
    await expect(ctx.workstreams.sendMessage(sender, owner.id, send)).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    await fiber.dispose()
    await ctx.plugin(WorkstreamService)
    // The technical owner may inspect this member's immutable send intent after replacement.
    const snapshot = ctx.workstreams.get(owner, owner.id)
    expect(snapshot.messages[0]?.delivery.phase).toBe('intent')
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('logs complete context before acceptance and rejects operation id input changes', async () => {
    const { ctx, owner } = await setup()
    const child = await ctx.workstreams.addMember(owner, owner.id, request('context'))
    const context = { requirements: 'Version 2', decisions: ['Use Tickets'], cursor: 'cursor-1', changes: 'New criteria',
      artifacts: [{ ref: 'artifact:1', digest: 'sha256:one' }] }
    const send = { operationId: WorkstreamOperationId('packet'), targetId: child.id, text: 'Updated context', context, signal }
    const result = await ctx.workstreams.sendMessage(owner, owner.id, send)
    expect(result.context).toEqual(context)
    const handle = await ctx.sessionPersistence.open(owner.id, 'read')
    try {
      const { events } = await handle.read(0)
      const states = events.filter(event => event.type === 'workstream/state').map(event => event.data.snapshot)
      expect(states.some(state => state.messages.some(message => message.operationId === send.operationId &&
        message.delivery.phase === 'intent' && message.context?.requirements === 'Version 2'))).toBe(true)
    } finally { await handle.close() }
    await expect(ctx.workstreams.sendMessage(owner, owner.id, { ...send, text: 'Changed' })).rejects.toMatchObject({ code:
      'WORKSTREAM_CONFLICT' })
  })

  it('waits on durable events, bounds timeout, cancels and releases waiters on shutdown', async () => {
    const { ctx, owner, fiber } = await setup()
    const revision = ctx.workstreams.get(owner, owner.id).revision
    const waiting = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, timeoutMs: 1_000, signal })
    await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Unrelated progress', description: '' })
    await expect(waiting).resolves.toEqual({ timedOut: false, revision })
    await expect(ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, timeoutMs: 1, signal,
    })).resolves.toEqual({ timedOut: true, revision })
    const abort = new AbortController()
    const cancelled = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, timeoutMs: 1_000, signal: abort.signal })
    const cancellation = expect(cancelled).rejects.toThrow('cancel wait')
    abort.abort(new Error('cancel wait'))
    await cancellation
    const disposed = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, timeoutMs: 1_000, signal })
    const rejection = expect(disposed).rejects.toMatchObject({ code: 'WORKSTREAM_DISPOSED' })
    await fiber.dispose()
    await rejection
  })

  it('rejects unsupported providers before appending a launch intent', async () => {
    const { ctx, owner } = await setup()
    const before = ctx.workstreams.get(owner, owner.id)
    await expect(ctx.workstreams.addMember(owner, owner.id, { ...request('missing'), provider: 'missing',
    })).rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT' })
    expect(ctx.workstreams.get(owner, owner.id)).toEqual(before)
  })

  it('registers and removes only workstream-prefixed model tools', async () => {
    const { ctx } = await setup()
    const register = vi.spyOn(ctx.tools, 'register')
    const fiber = await ctx.plugin(WorkstreamTools)
    expect(register.mock.calls.length).toBeGreaterThan(10)
    expect(register.mock.calls.every(([tool]) => tool.name.startsWith('workstream_'))).toBe(true)
    await fiber.dispose()
  })
})
