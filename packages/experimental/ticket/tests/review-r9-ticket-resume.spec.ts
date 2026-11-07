/** Recovery must distinguish a host restart from replacement while a producer survives. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it, onTestFinished, vi } from 'vitest'
import TicketService, { TicketExecutionService } from '../src/index.ts'
import { assigned, code, competing, harness, live, request } from './review-r5-harness.ts'

it('M1 reopening a closed root after service replacement cannot cancel a surviving producer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticket-r9-resume-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const { ctx, tickets, execution } = await harness(async (context) => {
    await context.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' })
  })
  const root = await live(ctx, 'r9-resume-root')
  const { agent: worker } = await live(ctx, 'r9-resume-worker')
  const writer = await ctx.sessionPersistence.create(root.agent.session.header)
  onTestFinished(() => writer.close())
  await writer.append(root.agent.session.snapshotEvents())
  const ticket = await assigned(ctx, root.agent, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'r9-resume'))
  const quiescent = Promise.withResolvers<undefined>()
  let producerFinished = false
  const completion = quiescent.promise.then(() => { producerFinished = true })
  onTestFinished(() => { quiescent.resolve(undefined) })
  vi.spyOn(worker, 'whenIdle').mockImplementation(() => completion)
  vi.spyOn(worker, 'cancel').mockImplementation(() => { throw new Error('producer refuses cancellation') })
  root.close()
  expect(await handle.dispose().then(() => 'settled', code)).toBe('TICKET_ATTEMPT_STATE')
  await ctx.sessionPersistence.flush()
  await writer.close()
  await using stored = await ctx.sessionPersistence.open(root.agent.id, 'read')
  const saved = await stored.read()
  const seed = Session.create(root.agent.id, saved.events, stored.header)
  expect(await competing(ctx, 'r9-resume-before')).toBe('TICKET_ATTEMPT_STATE')
  await execution.dispose()
  await tickets.dispose()
  await ctx.plugin(TicketService)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  expect(await competing(ctx, 'r9-resume-replaced')).toBe('TICKET_ATTEMPT_STATE')
  const resumed = await live(ctx, root.agent.id, seed)
  await ctx.tickets.whenIdle(resumed.agent.session)
  const attempt = ctx.tickets.get(resumed.agent.session, ticket.id).attempts[0]!
  const observed = { producerFinished, settled: attempt.status === 'settled', admission: await competing(ctx, 'r9-resume-after') }
  quiescent.resolve(undefined)
  await completion
  await handle.dispose().catch(code)
  expect(observed).toEqual({ producerFinished: false, settled: false, admission: 'TICKET_ATTEMPT_STATE' })
})

it('control a fresh host recovers its predecessor in-process producer as cancelled', async () => {
  const first = await harness()
  const root = await live(first.ctx, 'r9-restart-root')
  const { agent: worker } = await live(first.ctx, 'r9-restart-worker')
  const ticket = await assigned(first.ctx, root.agent, worker)
  const handle = await first.ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'r9-restart'))
  const second = await harness()
  const resumed = await live(second.ctx, root.agent.id, root.agent.session)
  await second.ctx.tickets.whenIdle(resumed.agent.session)
  expect(second.ctx.tickets.get(resumed.agent.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled' })
  await handle.dispose()
})
