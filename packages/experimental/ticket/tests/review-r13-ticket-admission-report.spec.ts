/** A preparation cancelled during its admission flush reports a failed or expired settlement write to its caller. */
import { expect, it, vi } from 'vitest'
import { assigned, code, harness, live, request } from './review-r5-harness.ts'

/**
 * The caller aborts while the admission flushes and that flush fails, so `admission-unflushed` hands `cancelled` to the
 * ledger. The ledger's `settled` flush is then held past the deadline (`held`) or fails (`failed`). The README says a
 * failed or expired settlement write of a cancelled `prepare` is reported separately from the preparation failure.
 */
it.each(['held', 'failed'] as const)('a cancelled admission whose settlement write is %s reports that write', async (mode) => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, `r13-admission-${mode}-root`)
  const { agent: worker } = await live(ctx, `r13-admission-${mode}-worker`)
  const ticket = await assigned(ctx, root, worker)
  const abort = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let settledFailures = 0
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
    if (attempt?.status === 'preparing') {
      abort.abort(new Error('admission cancelled'))
      throw new Error('admission flush failed')
    }
    if (attempt?.status === 'settled') {
      entered.resolve(undefined)
      if (mode === 'failed' && settledFailures === 0) {
        settledFailures += 1
        throw new Error('settlement flush failed')
      }
      if (mode === 'held') await release.promise
    }
    return flush(session)
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let finished = false
  const preparation = ctx.ticketExecution.prepare(worker, { ...request(root, ticket, `r13-admission-${mode}`), signal: abort.signal })
    .then(() => 'published', code).then((result) => { finished = true; return result })
  let bounded: boolean
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
    bounded = finished
  } finally {
    release.resolve(undefined)
    await preparation
    await ctx.tickets.whenIdle(root.session)
    vi.useRealTimers()
  }
  const result = await preparation
  expect({ bounded, reportsSettlement: /TICKET_SETTLEMENT_PENDING|settlement flush failed/.test(result), result })
    .toEqual({ bounded: true, reportsSettlement: true, result })
})
