/** Preparation failure reporting remains bounded while its owned writes finish independently. */
import { expect, it, vi } from 'vitest'
import { assigned, code, harness, live, request } from './review-r5-harness.ts'

it.each(['cancelled-admission', 'cancelled-runtime', 'uncertain-worktree'] as const)('%s rejects while its failure record is still flushing', async (scenario) => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, `${scenario}-root`)
  const { agent: worker } = await live(ctx, `${scenario}-worker`)
  const ticket = await assigned(ctx, root, worker)
  const abort = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const written = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
    if (scenario === 'cancelled-admission' && attempt?.status === 'preparing') {
      abort.abort(new Error('admission cancelled'))
      throw new Error('admission flush failed')
    }
    if (scenario === 'cancelled-runtime' && attempt?.status === 'running' && attempt.runtimeReceipt !== undefined) {
      abort.abort(new Error('runtime receipt cancelled'))
    }
    if (attempt?.status === 'settled' || attempt?.status === 'unknown') {
      entered.resolve(undefined)
      await release.promise
      const flushed = await flush(session)
      written.resolve(undefined)
      return flushed
    }
    return flush(session)
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let finished = false
  const preparation = ctx.ticketExecution.prepare(worker, {
    ...request(root, ticket, scenario), signal: abort.signal,
    ...scenario === 'uncertain-worktree'
      ? { workspace: { kind: 'isolated-worktree', directory: '/review/shared' } as const } : {},
  }).then(() => 'published', code).then((result) => { finished = true; return result })
  let bounded: boolean
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
    bounded = finished
  } finally {
    release.resolve(undefined)
    await preparation
    await written.promise
    vi.useRealTimers()
  }
  expect(bounded).toBe(true)
  expect(await preparation).not.toBe('published')
  const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
  expect(attempt?.status).toBe(scenario === 'uncertain-worktree' ? 'unknown' : 'settled')
  if (attempt?.status === 'settled') expect(attempt.outcome).toBe('cancelled')
})
