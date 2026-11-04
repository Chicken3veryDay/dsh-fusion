import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TicketService, { TicketId, ticketProjectionDefinition } from '../src/index.ts'
import type { TicketProjectionState } from '../src/projection.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TicketService)
  return { ctx, session: ctx.sessions.create(SessionId('ticket-root')) }
}

function project(session: Session): TicketProjectionState {
  let state = ticketProjectionDefinition.init(session.header)
  for (const event of session.snapshotEvents()) state = ticketProjectionDefinition.apply(state, event)
  return state
}

describe('Ticket service', () => {
  it('creates, assigns, claims, releases, reports, blocks, requests attention, hands off, and ends with CAS revisions', async () => {
    const { ctx, session } = await harness()
    const root = session.id
    const worker = SessionId('worker-a')
    const ticket = await ctx.tickets.create(session, {
      id: TicketId('ticket-1'),
      subject: 'Implement the change',
      description: 'A direct-worker responsibility',
      workScopes: [{ path: 'packages/ticket', access: 'write', exclusive: true }],
    })
    expect(ticket).toMatchObject({ id: 'ticket-1', revision: 1, status: 'proposed', coordinatorId: root })

    const assigned = await ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: root,
      ownerId: worker,
      subject: 'Build the domain',
      workScopes: [{ path: 'packages/ticket/src', access: 'write' }],
      executionMode: 'isolated-worktree',
    })
    expect(assigned).toMatchObject({ revision: 2, status: 'ready', assignments: [{ ownerId: worker, status: 'assigned' }] })
    const assignmentId = assigned.assignments[0]!.id

    const claimed = await ctx.tickets.claim(session, {
      ticketId: assigned.id,
      expectedRevision: 2,
      assignmentId,
      actorId: worker,
    })
    expect(claimed).toMatchObject({ revision: 3, status: 'executing', assignments: [{ status: 'running', attempts: 1 }], executionSlots: [{ status: 'running', holderId: worker }] })

    const released = await ctx.tickets.release(session, {
      ticketId: claimed.id,
      expectedRevision: 3,
      assignmentId,
      actorId: worker,
    })
    expect(released).toMatchObject({ revision: 4, status: 'ready', assignments: [{ ownerId: worker, status: 'released' }], executionSlots: [{ status: 'released' }] })

    const claimedAgain = await ctx.tickets.claim(session, {
      ticketId: released.id,
      expectedRevision: 4,
      assignmentId,
      actorId: worker,
    })
    const reported = await ctx.tickets.report(session, {
      ticketId: claimedAgain.id,
      expectedRevision: 5,
      assignmentId,
      actorId: worker,
      kind: 'result',
      summary: 'Worker finished',
      evidence: ['tests passed'],
      nextSteps: ['review'],
    })
    expect(reported).toMatchObject({ revision: 6, status: 'integrating', assignments: [{ status: 'completed', latestReportId: 'report-ticket-1-1' }] })

    const waiting = await ctx.tickets.attention(session, {
      ticketId: reported.id,
      expectedRevision: 6,
      actorId: root,
      kind: 'review',
      message: 'Coordinator review is required',
    })
    expect(waiting).toMatchObject({ revision: 7, status: 'waiting', attentions: [{ status: 'open', kind: 'review' }] })

    const handedOff = await ctx.tickets.handoff(session, {
      ticketId: waiting.id,
      expectedRevision: 7,
      actorId: root,
      newCoordinatorId: SessionId('reviewer'),
    })
    expect(handedOff).toMatchObject({ revision: 8, coordinatorId: 'reviewer' })

    const blocked = await ctx.tickets.block(session, {
      ticketId: handedOff.id,
      expectedRevision: 8,
      actorId: SessionId('reviewer'),
      reason: 'Waiting on a human decision',
    })
    expect(blocked).toMatchObject({ revision: 9, status: 'blocked' })

    const completed = await ctx.tickets.complete(session, {
      ticketId: blocked.id,
      expectedRevision: 9,
      actorId: SessionId('reviewer'),
      summary: 'Accepted after review',
    })
    expect(completed).toMatchObject({ revision: 10, status: 'completed', terminalOutcome: { kind: 'completed' } })
    await expect(ctx.tickets.block(session, {
      ticketId: completed.id,
      expectedRevision: 10,
      actorId: SessionId('reviewer'),
      reason: 'too late',
    })).rejects.toMatchObject({ code: 'TICKET_TERMINAL' })
    await expect(ctx.tickets.handoff(session, {
      ticketId: completed.id,
      expectedRevision: 1,
      actorId: root,
      newCoordinatorId: worker,
    })).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
  })

  it('recovers the same state from the Session event log and rejects stale concurrent writes', async () => {
    const { ctx, session } = await harness()
    const ticket = await ctx.tickets.create(session, { subject: 'Recovery', description: 'replay me' })
    const assigned = await ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: session.id,
      ownerId: SessionId('worker'),
      subject: 'Assignment',
    })
    await expect(ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: session.id,
      ownerId: SessionId('worker-2'),
      subject: 'Stale assignment',
    })).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })

    const recovered = ctx.tickets.recover(session)
    expect(recovered).toEqual([assigned])
    const projected = project(session)
    expect(projected.failure).toBeUndefined()
    expect(projected.tickets).toEqual([assigned])
    const events = session.snapshotEvents().filter(event => event.type === 'ticket/state')
    expect(events).toHaveLength(2)
    expect(events.every(event => event.data.ticket !== undefined && event.data.ticket.revision > 0)).toBe(true)
  })

  it('keeps worker ownership across release and asks durable questions', async () => {
    const { ctx, session } = await harness()
    const worker = SessionId('worker')
    const ticket = await ctx.tickets.create(session, { subject: 'Question', description: 'ask' })
    const assigned = await ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: session.id,
      ownerId: worker,
      subject: 'Ask',
    })
    const asked = await ctx.tickets.ask(session, {
      ticketId: assigned.id,
      expectedRevision: 2,
      assignmentId: assigned.assignments[0]!.id,
      actorId: worker,
      question: 'Which API should I use?',
    })
    expect(asked).toMatchObject({ status: 'waiting', questions: [{ status: 'open', authorId: worker }] })
    const released = await ctx.tickets.release(session, {
      ticketId: asked.id,
      expectedRevision: 3,
      assignmentId: assigned.assignments[0]!.id,
      actorId: session.id,
    })
    expect(released.assignments[0]).toMatchObject({ ownerId: worker, status: 'released' })
  })
})
