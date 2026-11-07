/** A stop whose known outcome cannot be flushed rejects as pending at its deadline, and the ledger still completes the write. */
import { expect, it, vi } from 'vitest'
import { assigned, code, harness, live, outcomeOf, request } from './review-r5-harness.ts'

async function heldFlush(suffix: string) {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, `${suffix}-root`)
  const { agent: worker } = await live(ctx, `${suffix}-worker`)
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, suffix))
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const flushed = Promise.withResolvers<undefined>()
  let held = true
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    entered.resolve(undefined)
    if (held) await release.promise
    const result = await flush(session)
    if (!held) flushed.resolve(undefined)
    return result
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const stopped = (promise: Promise<void>) => promise.then(() => 'settled', code)
  const releaseFlush = () => { held = false; release.resolve(undefined) }
  const attempt = () => ctx.tickets.get(root.session, ticket.id).attempts[0]
  return { handle, entered, flushed, stopped, releaseFlush, attempt }
}

it('a repeated stop on the handed attempt also rejects as pending at its deadline', async () => {
  const { handle, entered, stopped, releaseFlush } = await heldFlush('r10-repeat')
  let first: string
  let repeated: string
  try {
    const stopping = stopped(handle.settle())
    await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
    first = await stopping
    const again = stopped(handle.dispose())
    await vi.advanceTimersByTimeAsync(5000)
    repeated = await again
  } finally {
    releaseFlush()
    vi.useRealTimers()
  }
  expect(first).toBe('TICKET_SETTLEMENT_PENDING')
  expect(repeated).toBe('TICKET_SETTLEMENT_PENDING')
})

it('the held write completes once storage recovers, and the outcome is durable', async () => {
  const { handle, entered, flushed, stopped, releaseFlush, attempt } = await heldFlush('r10-recover')
  let pending: string
  try {
    const stopping = stopped(handle.dispose())
    await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
    pending = await stopping
  } finally {
    vi.useRealTimers()
  }
  expect(pending).toBe('TICKET_SETTLEMENT_PENDING')
  // The known outcome is kept, not rewritten as unknown, while the write is held.
  expect(outcomeOf(attempt())).toBe('cancelled')
  releaseFlush()
  // The ledger's own held write completes without another request, so the outcome is durable.
  await flushed.promise
  await expect(handle.dispose()).resolves.toBeUndefined()
  expect(outcomeOf(attempt())).toBe('cancelled')
})
