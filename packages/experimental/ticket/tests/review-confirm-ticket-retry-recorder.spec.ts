/** An identical retry of an unflushed admission that grants no recorder is refused and releases its run. */
import { expect, it, vi } from 'vitest'
import { TicketOperationId } from '../src/index.ts'
import { assigned, code, harness, live, request } from './review-r5-harness.ts'

/**
 * The admission flush fails, leaving the run `unflushed` with the first admission's recorder. A host then settles the
 * attempt, which retires the admission operation into the settlement tombstone. The identical retry of `prepare` finds
 * that tombstone, so `beginAttempt` resolves without granting a recorder to this admission. The retry must refuse the
 * admission (`admission-refused` releases the run and its reservation) instead of continuing with the earlier recorder,
 * and the assignment must accept a fresh attempt afterwards.
 */
it('a recorder-less retry of an unflushed admission is refused and frees the assignment', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'confirm-retry-root')
  const { agent: worker } = await live(ctx, 'confirm-retry-worker')
  const ticket = await assigned(ctx, root, worker)
  const first = request(root, ticket, 'confirm-retry')
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let failed = false
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (!failed && ctx.tickets.get(root.session, ticket.id).attempts[0]?.status === 'preparing') {
      failed = true
      throw new Error('admission flush failed')
    }
    return flush(session)
  })
  const admission = await ctx.ticketExecution.prepare(worker, first).then(() => 'published', code)
  expect(admission).toBe('Error: admission flush failed')

  const before = ctx.tickets.get(root.session, ticket.id)
  await ctx.agents.withInitiator(root, () => ctx.tickets.settleAttempt(root.session, {
    ticketId: ticket.id, expectedRevision: before.revision, actorId: root.id, attemptId: first.attemptId,
    operationId: TicketOperationId('host-settle'), outcome: 'cancelled',
  }))

  const retry = await ctx.ticketExecution.prepare(worker, first).then(() => 'published', code)
  const current = ctx.tickets.get(root.session, ticket.id)
  const fresh = await ctx.ticketExecution.prepare(worker, { ...request(root, current, 'confirm-retry-fresh') })
    .then(async (handle) => { await handle.dispose(); return 'published' }, code)
  expect({ retry, fresh }).toEqual({ retry: 'TICKET_ATTEMPT_STATE', fresh: 'published' })
})
