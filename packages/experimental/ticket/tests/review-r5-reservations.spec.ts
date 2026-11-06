/** Round-5 shared scope reservations while a closed root still has a live producer. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { assigned, code, competing, harness, live, request } from './review-r5-harness.ts'

it('R5-4 deleting a closed root log cannot release scopes while its producer is still running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-r5-delete-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const { ctx } = await harness(async (ctx) => { await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' }) })
  const root = await live(ctx, 'deleted-root')
  const { agent: worker } = await live(ctx, 'deleted-worker')
  const writer = await ctx.sessionPersistence.create(root.agent.session.header)
  onTestFinished(() => writer.close())
  await writer.append(root.agent.session.snapshotEvents())
  const ticket = await assigned(ctx, root.agent, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'deleted'))
  const cancelled = Promise.withResolvers<undefined>()
  const done = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'killed' }) })
  let finished = false
  await handle.startJob('continues writing until shutdown finishes', () => ({ cancel() { cancelled.resolve(undefined) }, done: done.promise }))
  const stat = await ctx.sessionPersistence.stat(root.agent.id)
  if (stat?.location?.kind !== 'jsonl') throw new Error('expected a JSONL location')
  root.close()
  await cancelled.promise
  const disposal = handle.dispose().then(() => 'settled', code)
  await writer.close()
  await rm(stat.location.path)
  const admission = await competing(ctx, 'deleted-competing')
  const observed = { finished, admission }
  finished = true
  done.resolve({ status: 'killed' })
  await disposal
  expect(observed).toEqual({ finished: false, admission: 'TICKET_ATTEMPT_STATE' })
})
