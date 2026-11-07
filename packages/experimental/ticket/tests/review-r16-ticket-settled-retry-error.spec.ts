/** Review round 16 evidence (minor m1): the caller-visible error of an identical `prepare` retry after a host settled the
 * unflushed attempt. The README says repeating a settled preparation returns `TICKET_ATTEMPT_STATE`; this asserts that. */
import { expect, it, vi } from 'vitest'
import { TicketError, TicketOperationId } from '../src/index.ts'
import { assigned, harness, live, request } from './review-r5-harness.ts'

it('an identical retry of an attempt a host settled reports the settled attempt', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'r16-settled-retry-root')
  const { agent: worker } = await live(ctx, 'r16-settled-retry-worker')
  const ticket = await assigned(ctx, root, worker)
  const first = request(root, ticket, 'r16-settled-retry')
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let failed = false
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (!failed && ctx.tickets.get(root.session, ticket.id).attempts[0]?.status === 'preparing') {
      failed = true
      throw new Error('admission flush failed')
    }
    return flush(session)
  })
  await expect(ctx.ticketExecution.prepare(worker, first)).rejects.toThrow('admission flush failed')
  const before = ctx.tickets.get(root.session, ticket.id)
  await ctx.agents.withInitiator(root, () => ctx.tickets.settleAttempt(root.session, {
    ticketId: ticket.id, expectedRevision: before.revision, actorId: root.id, attemptId: first.attemptId,
    operationId: TicketOperationId('r16-host-settle'), outcome: 'cancelled',
  }))
  const retry = await ctx.ticketExecution.prepare(worker, first).then(() => undefined, (error: unknown) => error)
  expect(retry).toBeInstanceOf(TicketError)
  expect({ code: (retry as TicketError).code, message: (retry as TicketError).message })
    .toEqual({ code: 'TICKET_ATTEMPT_STATE', message: expect.stringMatching(/settled/) as string })
})
