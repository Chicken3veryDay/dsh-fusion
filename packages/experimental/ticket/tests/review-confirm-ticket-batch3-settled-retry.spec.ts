/** Confirmation review of the settled-retry error (round 16 m1 fix): the identical `prepare` retry of an unflushed attempt
 * reports a host settlement only from committed attempt state, and every path releases the run and its scopes. */
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TicketOperationId, type TicketView } from '../src/index.ts'
import { assigned, code, competing, harness, live, request } from './review-r5-harness.ts'

/** Fail the next `count` flushes taken while the first attempt is still preparing. */
function failPreparingFlushes(ctx: Context, root: Agent, ticket: TicketView, count: number, onFlush?: () => void) {
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let remaining = count
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    onFlush?.()
    if (remaining > 0 && ctx.tickets.get(root.session, ticket.id).attempts[0]?.status === 'preparing') {
      remaining -= 1
      throw new Error('admission flush failed')
    }
    return flush(session)
  })
}

async function hostSettle(ctx: Context, root: Agent, ticket: TicketView, attemptId: ReturnType<typeof request>['attemptId'], id: string) {
  const before = ctx.tickets.get(root.session, ticket.id)
  await ctx.agents.withInitiator(root, () => ctx.tickets.settleAttempt(root.session, {
    ticketId: ticket.id, expectedRevision: before.revision, actorId: root.id, attemptId,
    operationId: TicketOperationId(id), outcome: 'cancelled',
  }))
}

it('a retry whose repeated flush failed still holds the grant; a later retry after host settlement reports the settlement', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'b3-twice-root')
  const { agent: worker } = await live(ctx, 'b3-twice-worker')
  const ticket = await assigned(ctx, root, worker)
  const first = request(root, ticket, 'b3-twice')
  failPreparingFlushes(ctx, root, ticket, 2)
  const admission = await ctx.ticketExecution.prepare(worker, first).then(() => 'published', code)
  // The retry is granted a recorder from the operation still in the log, so its flush failure keeps the run unflushed.
  const unflushed = await ctx.ticketExecution.prepare(worker, first).then(() => 'published', code)
  await hostSettle(ctx, root, ticket, first.attemptId, 'b3-twice-host')
  const settled = await ctx.ticketExecution.prepare(worker, first).then(() => 'published', code)
  const again = await ctx.ticketExecution.prepare(worker, first).then(() => 'published', code)
  // Another root's exclusive scope on the same shared workspace is admitted once this run is released.
  const other = await competing(ctx, 'b3-twice-other')
  const current = ctx.tickets.get(root.session, ticket.id)
  const fresh = await ctx.ticketExecution.prepare(worker, request(root, current, 'b3-twice-fresh'))
    .then(async (handle) => { await handle.dispose(); return 'published' }, code)
  expect({ admission, unflushed, settled, again, other, fresh }).toEqual({
    admission: 'Error: admission flush failed', unflushed: 'Error: admission flush failed',
    settled: 'TICKET_ATTEMPT_STATE', again: 'TICKET_ATTEMPT_STATE', other: 'admitted', fresh: 'published',
  })
})

it('an identical retry of an unsettled unflushed admission continues preparation', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'b3-unsettled-root')
  const { agent: worker } = await live(ctx, 'b3-unsettled-worker')
  const ticket = await assigned(ctx, root, worker)
  const first = request(root, ticket, 'b3-unsettled')
  failPreparingFlushes(ctx, root, ticket, 1)
  const admission = await ctx.ticketExecution.prepare(worker, first).then(() => 'published', code)
  const retry = await ctx.ticketExecution.prepare(worker, first)
    .then(async (handle) => { await handle.dispose(); return 'published' }, code)
  expect({ admission, retry }).toEqual({ admission: 'Error: admission flush failed', retry: 'published' })
})

it('a caller abort during a retry that finds the host settlement still releases the run', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'b3-abort-root')
  const { agent: worker } = await live(ctx, 'b3-abort-worker')
  const ticket = await assigned(ctx, root, worker)
  const first = request(root, ticket, 'b3-abort')
  const controller = new AbortController()
  let armed = false
  failPreparingFlushes(ctx, root, ticket, 1, () => { if (armed) controller.abort(new Error('caller stopped retry')) })
  const admission = await ctx.ticketExecution.prepare(worker, first).then(() => 'published', code)
  await hostSettle(ctx, root, ticket, first.attemptId, 'b3-abort-host')
  armed = true
  // The tombstone path flushes before beginAttempt resolves, so the abort lands while the run is admitting.
  const retry = await ctx.ticketExecution.prepare(worker, { ...first, signal: controller.signal }).then(() => 'published', code)
  armed = false
  const other = await competing(ctx, 'b3-abort-other')
  const current = ctx.tickets.get(root.session, ticket.id)
  const fresh = await ctx.ticketExecution.prepare(worker, request(root, current, 'b3-abort-fresh'))
    .then(async (handle) => { await handle.dispose(); return 'published' }, code)
  expect({ admission, retry, other, fresh, attempts: current.attempts.map(item => [item.id, item.status]) }).toEqual({
    admission: 'Error: admission flush failed', retry: 'TICKET_ATTEMPT_STATE', other: 'admitted', fresh: 'published',
    attempts: [[first.attemptId, 'settled']],
  })
})

it('a host settlement queued behind an identical retry either refuses the retry or settles the granted attempt', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'b3-race-root')
  const { agent: worker } = await live(ctx, 'b3-race-worker')
  const ticket = await assigned(ctx, root, worker)
  const first = request(root, ticket, 'b3-race')
  failPreparingFlushes(ctx, root, ticket, 1)
  await ctx.ticketExecution.prepare(worker, first).then(() => 'published', code)
  const retry = ctx.ticketExecution.prepare(worker, first)
    .then(async (handle) => { await handle.dispose(); return 'published' }, code)
  const settle = hostSettle(ctx, root, ticket, first.attemptId, 'b3-race-host').then(() => 'settled', code)
  const outcome = { retry: await retry, settle: await settle }
  const current = ctx.tickets.get(root.session, ticket.id)
  const fresh = await ctx.ticketExecution.prepare(worker, request(root, current, 'b3-race-fresh'))
    .then(async (handle) => { await handle.dispose(); return 'published' }, code)
  expect(current.attempts.find(item => item.id === first.attemptId)?.status).toBe('settled')
  expect(fresh).toBe('published')
  // Record which interleaving ran; neither may surface the internal recorder refusal.
  expect(outcome.retry).not.toBe('TICKET_RECOVERY_FAILED')
})
