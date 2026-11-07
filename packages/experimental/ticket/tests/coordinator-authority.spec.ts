import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TicketService, { TicketError } from '../src/index.ts'
import type { TicketCommandKind } from '../src/index.ts'
import { ticketActor } from './ticket-actor.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService)
  return { ctx, session: ctx.sessions.create(SessionId('authority-root')) }
}

describe('Ticket coordinator authority', () => {
  it('names the replacement the authority decides, keeps requests it leaves alone, and stops after disposal', async () => {
    const { ctx, session } = await harness()
    const replacement = SessionId('replacement-coordinator')
    await ticketActor(ctx, replacement, async () => {})
    await ticketActor(ctx, SessionId('requested'), async () => {})
    const requests: SessionId[] = []
    const dispose = ctx.tickets.registerCoordinatorAuthority((candidate, requested) => {
      requests.push(requested)
      return candidate === session && requested === session.id ? replacement : undefined
    })
    const defaulted = await ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Defaulted', description: '' }))
    expect(defaulted.coordinatorId).toBe(replacement)
    const explicit = await ticketActor(ctx, session.id, () => ctx.tickets.create(session,
      { subject: 'Explicit', description: '', coordinatorId: SessionId('requested') }))
    expect(explicit.coordinatorId).toBe('requested')
    expect(requests).toEqual([session.id, SessionId('requested')])
    const other = ctx.sessions.create(SessionId('unclaimed-root'))
    const unclaimed = await ticketActor(ctx, other.id, () => ctx.tickets.create(other, { subject: 'Unclaimed', description: '' }))
    expect(unclaimed.coordinatorId).toBe(other.id)
    dispose()
    const released = await ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Released', description: '' }))
    expect(released.coordinatorId).toBe(session.id)
  })

  it('reads the authority at the append, so a creation queued before an authority change names the new coordinator', async () => {
    const { ctx, session } = await harness()
    // The authority changes its answer as soon as the first creation has consulted it.
    await ticketActor(ctx, SessionId('before'), async () => {})
    await ticketActor(ctx, SessionId('after'), async () => {})
    const answers = [SessionId('before'), SessionId('after')]
    ctx.tickets.registerCoordinatorAuthority(() => answers.shift())
    const [first, second] = await ticketActor(ctx, session.id, async () => {
      const queuedFirst = ctx.tickets.create(session, { subject: 'First', description: '' })
      const queuedSecond = ctx.tickets.create(session, { subject: 'Second', description: '' })
      return Promise.all([queuedFirst, queuedSecond])
    })
    expect(first.coordinatorId).toBe('before')
    expect(second.coordinatorId).toBe('after')
  })

  it('fails creation without appending when the authority throws', async () => {
    const { ctx, session } = await harness()
    ctx.tickets.registerCoordinatorAuthority(() => { throw new Error('authority unavailable') })
    await expect(ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Rejected', description: '' })))
      .rejects.toMatchObject({ message: 'Ticket coordinator authority failed', cause: { message: 'authority unavailable' } })
    expect(ctx.tickets.list(session)).toEqual([])
    expect(session.snapshotEvents().filter(event => event.type === 'ticket/state')).toEqual([])
  })
})

describe('Ticket assignment authority', () => {
  it('refuses inside the queue at the append, and stops refusing after disposal', async () => {
    const { ctx, session } = await harness()
    const worker = SessionId('assignment-worker')
    await ticketActor(ctx, worker, async () => {})
    const ticket = await ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Assign', description: '' }))
    const assign = (revision: number) => ticketActor(ctx, session.id, () => ctx.tickets.assign(session,
      { ticketId: ticket.id, expectedRevision: revision, actorId: session.id, ownerId: worker, subject: 'Do it' }))
    const consulted: SessionId[] = []
    let refuse = false
    const dispose = ctx.tickets.registerAssignmentAuthority((candidate, assigneeId) => {
      expect(candidate).toBe(session)
      consulted.push(assigneeId)
      if (refuse) throw new TicketError('assignee is gone', 'TICKET_AUTHORITY')
    })
    // The decision is read when the queued mutation runs, not when assign was called.
    refuse = true
    const queued = assign(ticket.revision)
    await expect(queued).rejects.toMatchObject({ code: 'TICKET_AUTHORITY', message: 'assignee is gone' })
    expect(ctx.tickets.get(session, ticket.id)).toMatchObject({ revision: ticket.revision, assignments: [] })
    refuse = false
    expect((await assign(ticket.revision)).assignments).toHaveLength(1)
    expect(consulted).toEqual([worker, worker])
    refuse = true
    dispose()
    const released = ctx.tickets.get(session, ticket.id)
    expect((await ticketActor(ctx, session.id, () => ctx.tickets.assign(session,
      { ticketId: ticket.id, expectedRevision: released.revision, actorId: session.id, ownerId: worker, subject: 'Again' }))).assignments).toHaveLength(2)
    expect(consulted).toHaveLength(2)
  })

  it('wraps a non-Ticket failure of the authority and appends nothing', async () => {
    const { ctx, session } = await harness()
    const worker = SessionId('wrapped-worker')
    await ticketActor(ctx, worker, async () => {})
    const ticket = await ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Wrap', description: '' }))
    const cause = new Error('broken authority')
    ctx.tickets.registerAssignmentAuthority(() => { throw cause })
    await expect(ticketActor(ctx, session.id, () => ctx.tickets.assign(session,
      { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, ownerId: worker, subject: 'Do it' })))
      .rejects.toMatchObject({ code: 'TICKET_RECOVERY_FAILED', cause })
    expect(ctx.tickets.get(session, ticket.id).assignments).toEqual([])
  })
})

describe('Ticket command authority', () => {
  it('refuses commands of every kind inside the queue at the append, and governs only later admissions after disposal', async () => {
    const { ctx, session } = await harness()
    const ticket = await ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Govern', description: '' }))
    const consulted: TicketCommandKind[] = []
    let revoked = false
    const dispose = ctx.tickets.registerCommandAuthority((candidate, actorId, command) => {
      expect(candidate).toBe(session)
      expect(command.ticketId).not.toBe('')
      consulted.push(command.kind)
      if (revoked && actorId === session.id) throw new TicketError('actor was revoked', 'TICKET_AUTHORITY')
    })
    // Hold one root flush so the next commands wait in the queue behind it.
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (target) => {
      entered.resolve(undefined); await release.promise; return flush(target)
    })
    const barrier = ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Barrier', description: '' }))
    await entered.promise
    const base = { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id }
    const queued = ticketActor(ctx, session.id, async () => Promise.allSettled([
      ctx.tickets.ask(session, { ...base, question: 'Which branch?' }),
      ctx.tickets.attention(session, { ...base, kind: 'decision', message: 'Pick a date' }),
      ctx.tickets.revise(session, { ...base, acceptanceCriteria: [], dependencies: [] }),
    ]))
    // Revocation and disposal both happen after admission and before the commit point.
    revoked = true
    dispose()
    release.resolve(undefined)
    await barrier
    const outcomes = await queued
    expect(outcomes.map(outcome => outcome.status === 'rejected' ? (outcome.reason as TicketError).code : 'fulfilled'))
      .toEqual(['TICKET_AUTHORITY', 'TICKET_AUTHORITY', 'TICKET_AUTHORITY'])
    expect(consulted).toEqual(['create', 'ask', 'attention', 'revise'])
    expect(ctx.tickets.get(session, ticket.id)).toEqual(ticket)
    // A command admitted after disposal is not consulted and commits under the default.
    const asked = await ticketActor(ctx, session.id, () => ctx.tickets.ask(session, { ...base, question: 'Which branch?' }))
    expect(asked.questions).toHaveLength(1)
    expect(consulted).toHaveLength(4)
  })

  it('wraps a non-Ticket failure of the authority and appends nothing', async () => {
    const { ctx, session } = await harness()
    const ticket = await ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Wrap', description: '' }))
    const cause = new Error('broken authority')
    ctx.tickets.registerCommandAuthority(() => { throw cause })
    await expect(ticketActor(ctx, session.id, () => ctx.tickets.ask(session,
      { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, question: 'Why?' })))
      .rejects.toMatchObject({ code: 'TICKET_RECOVERY_FAILED', message: 'Ticket command authority failed', cause })
    expect(ctx.tickets.get(session, ticket.id)).toEqual(ticket)
  })
})
