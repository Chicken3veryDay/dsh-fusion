/** Round-6 reservation ownership across failed teardown and service replacement. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TicketService, { TicketExecutionService } from '../src/index.ts'
import { assigned, code, competing, harness, live, request } from './review-r5-harness.ts'

it('R6-5 replacement cannot discard a deleted-root reservation while its timed-out producer still runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-r6-reload-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const { ctx, tickets, execution } = await harness(async (ctx) => {
    await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  })
  const root = await live(ctx, 'r6-reload-root')
  const { agent: worker } = await live(ctx, 'r6-reload-worker')
  const writer = await ctx.sessionPersistence.create(root.agent.session.header)
  onTestFinished(() => writer.close())
  await writer.append(root.agent.session.snapshotEvents())
  const ticket = await assigned(ctx, root.agent, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'r6-reload'))
  const done = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'killed' }) })
  let producerFinished = false
  await handle.startJob('ignores cancellation until producer exits', () => ({ cancel() {},
    done: done.promise.then((outcome) => { producerFinished = true; return outcome }) }))
  const stat = await ctx.sessionPersistence.stat(root.agent.id)
  if (stat?.location?.kind !== 'jsonl') throw new Error('expected a JSONL location')
  root.close()
  await handle.dispose().catch(() => {})
  await writer.close()
  await rm(stat.location.path)
  expect(await competing(ctx, 'r6-reload-before')).toBe('TICKET_ATTEMPT_STATE')
  await execution.dispose()
  await tickets.dispose()
  await ctx.plugin(TicketService)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  const admission = await competing(ctx, 'r6-reload-after')
  const observed = { producerFinished, admission }
  done.resolve({ status: 'killed' })
  await done.promise
  await handle.dispose().catch(code)
  expect(observed).toEqual({ producerFinished: false, admission: 'TICKET_ATTEMPT_STATE' })
})
