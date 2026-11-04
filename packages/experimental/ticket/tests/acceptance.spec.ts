import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TicketService from '../src/index.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TicketService)
  return { ctx, session: ctx.sessions.create(SessionId('acceptance-root')) }
}

it('requires a pinned candidate before accepting a reported contribution', async () => {
  const { ctx, session } = await harness()
  let ticket = await ctx.tickets.create(session, { subject: 'Accept', description: '' })
  ticket = await ctx.tickets.assign(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, ownerId: session.id, subject: 'Build' })
  ticket = await ctx.tickets.report(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, assignmentId: ticket.assignments[0]!.id, kind: 'result', summary: 'Built' })
  const before = session.snapshotEvents()
  await expect(ctx.tickets.complete(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, summary: 'Accepted' })).rejects.toMatchObject({ code: 'TICKET_ACCEPTANCE' })
  expect(session.snapshotEvents()).toEqual(before)
})
