/** Stop deadlines must include pending Job admission and uncertainty recording. */
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { TicketExecutionService } from '../src/index.ts'
import { assigned, code, harness, live, request } from './review-r5-harness.ts'

it('R7-1 stop times out while a Job admission flush remains pending', async () => {
  const { ctx, execution } = await harness()
  await execution.dispose()
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 20 })
  const { agent: root } = await live(ctx, 'r7-queue-root')
  const { agent: worker } = await live(ctx, 'r7-queue-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'r7-queue'))
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let held = false
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (!held) { held = true; entered.resolve(undefined); await release.promise }
    return flush(session)
  })
  let started = false
  const admission = handle.startJob('held durable admission', () => {
    started = true
    return { cancel() {}, done: Promise.resolve({ status: 'completed' }) }
  }).then(() => 'admitted', code)
  await entered.promise
  const stop = handle.dispose().then(() => 'settled', code)
  let observed: string
  try {
    observed = await Promise.race([stop, delay(150).then(() => 'still pending after 7.5 stop deadlines')])
  } finally {
    release.resolve(undefined)
    await admission
    await stop
  }
  expect(started).toBe(false)
  expect(observed).toBe('TICKET_ATTEMPT_STATE')
})

it('R7-1b stop times out even when recording its uncertainty cannot flush', async () => {
  const { ctx, execution } = await harness()
  await execution.dispose()
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 20 })
  const { agent: root } = await live(ctx, 'r7-unknown-root')
  const { agent: worker } = await live(ctx, 'r7-unknown-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'r7-unknown'))
  const idle = Promise.withResolvers<undefined>()
  vi.spyOn(worker, 'whenIdle').mockReturnValue(idle.promise)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let held = false
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (!held) { held = true; entered.resolve(undefined); await release.promise }
    return flush(session)
  })
  const stop = handle.dispose().then(() => 'settled', code)
  await entered.promise
  let observed: string
  try {
    observed = await Promise.race([stop, delay(150).then(() => 'still pending after 7.5 stop deadlines')])
  } finally {
    idle.resolve(undefined)
    release.resolve(undefined)
    await stop
    await handle.dispose()
  }
  expect(observed).toBe('TICKET_ATTEMPT_STATE')
})
