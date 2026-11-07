/** The execution deadline also bounds a stop waiting to persist its known outcome. */
import { expect, it, vi } from 'vitest'
import { assigned, code, harness, live, request } from './review-r5-harness.ts'

it.each([
  { method: 'settle', holdFlush: false },
  { method: 'settle', holdFlush: true },
  { method: 'dispose', holdFlush: false },
  { method: 'dispose', holdFlush: true },
] as const)('$method finishes within its deadline when final flush is held: $holdFlush', async ({ method, holdFlush }) => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, `r10-deadline-${holdFlush}-root`)
  const { agent: worker } = await live(ctx, `r10-deadline-${holdFlush}-worker`)
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, `r10-deadline-${holdFlush}`))
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    entered.resolve(undefined)
    if (holdFlush) await release.promise
    return flush(session)
  })
  let finished = false
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const stopping = handle[method]().then(() => 'settled', code).then((result) => { finished = true; return result })
  let beforeRelease: boolean
  try {
    await entered.promise
    expect(ctx.tickets.get(root.session, ticket.id).attempts[0]?.status).toBe('settled')
    // The fixture's timeout is 1000 ms. Advancing its clock cannot release the independently held flush.
    await vi.advanceTimersByTimeAsync(5000)
    beforeRelease = finished
  } finally {
    release.resolve(undefined)
    await stopping
    vi.useRealTimers()
    spy.mockRestore()
  }
  expect(beforeRelease, `${method}() must finish within settlementTimeoutMs even while its settlement cannot flush`).toBe(true)
})
