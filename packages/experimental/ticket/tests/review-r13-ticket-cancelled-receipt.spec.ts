/** A cancelled preparation regains control within settlementTimeoutMs whichever of its own writes the storage stall holds. */
import { expect, it, vi } from 'vitest'
import { assigned, code, harness, live, request } from './review-r5-harness.ts'

/**
 * The caller aborts while one flush of the preparation is held. `settled` is the R12-M1 case the round-12 fix bounds and is
 * the control. `admission`, `workspace` and `runtime` hold an earlier write of the same preparation: the abort lands in
 * `admitting(aborted)` or `preparing(aborted)`, and nothing bounds the wait for that write.
 */
it.each(['settled', 'admission', 'workspace', 'runtime'] as const)('a preparation cancelled while its %s flush is held rejects within the deadline', async (held) => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, `r13-${held}-root`)
  const { agent: worker } = await live(ctx, `r13-${held}-worker`)
  const ticket = await assigned(ctx, root, worker)
  const abort = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const stageOf = (): string | undefined => {
    const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
    if (attempt === undefined) return undefined
    if (attempt.status === 'settled') return 'settled'
    if (attempt.runtimeReceipt !== undefined) return 'runtime'
    if (attempt.workspaceReceipt !== undefined) return 'workspace'
    return 'admission'
  }
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    const stage = stageOf()
    // The control aborts while the runtime receipt flushes, then holds only the final settlement flush.
    if (held === 'settled' && stage === 'runtime') abort.abort(new Error('caller cancelled preparation'))
    if (stage === held) {
      if (held !== 'settled') abort.abort(new Error('caller cancelled preparation'))
      entered.resolve(undefined)
      await release.promise
    }
    return flush(session)
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let finished = false
  const preparation = ctx.ticketExecution.prepare(worker, { ...request(root, ticket, `r13-${held}`), signal: abort.signal })
    .then(() => 'published', code).then((result) => { finished = true; return result })
  let bounded: boolean
  try {
    await entered.promise
    // Five times the configured 1000 ms settlementTimeoutMs.
    await vi.advanceTimersByTimeAsync(5000)
    bounded = finished
  } finally {
    release.resolve(undefined)
    await preparation
    await ctx.tickets.whenIdle(root.session)
    vi.useRealTimers()
  }
  const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
  const result = await preparation
  expect({ bounded, published: result === 'published', status: attempt?.status, outcome: attempt?.status === 'settled' ? attempt.outcome : undefined, result })
    .toEqual({ bounded: true, published: false, status: 'settled', outcome: 'cancelled', result })
})
