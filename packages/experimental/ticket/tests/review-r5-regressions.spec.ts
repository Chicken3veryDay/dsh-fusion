/** Round-5 attempt state machine paths beyond the review reproductions. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { TicketAttemptId, TicketOperationId } from '../src/index.ts'
import { assigned, code, competing, harness, live, request, shared } from './review-r5-harness.ts'

it('R5-2 a worker disposed while the admission flush fails ends the attempt cancelled without a retry', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'flush-dispose-root')
  const worker = await live(ctx, 'flush-dispose-worker')
  const ticket = await assigned(ctx, root, worker.agent)
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await gate.promise
    throw new Error('admission checkpoint failed')
  }).mockImplementation(flush)
  const preparation = ctx.ticketExecution.prepare(root, request(root, ticket, 'flush-dispose')).then(() => 'prepared', code)
  await entered.promise
  worker.close()
  gate.resolve(undefined)
  expect(await preparation).toBe('Error: admission checkpoint failed')
  spy.mockRestore()
  await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, { subject: 'Storage recovered', description: '' }))
  expect({ attempt: ctx.tickets.get(root.session, ticket.id).attempts[0], competing: await competing(ctx, 'flush-dispose-competing') })
    .toMatchObject({ attempt: { status: 'settled', outcome: 'cancelled' }, competing: 'admitted' })
})

it('R5-4 a deleted closed root releases its scopes once its producer has settled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-r5-delete-settled-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const { ctx } = await harness(async (ctx) => { await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' }) })
  const root = await live(ctx, 'deleted-settled-root')
  const { agent: worker } = await live(ctx, 'deleted-settled-worker')
  const writer = await ctx.sessionPersistence.create(root.agent.session.header)
  onTestFinished(() => writer.close())
  await writer.append(root.agent.session.snapshotEvents())
  const ticket = await assigned(ctx, root.agent, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'deleted-settled'))
  const done = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'killed' }) })
  await handle.startJob('slow to stop', () => ({ cancel() {}, done: done.promise }))
  const stat = await ctx.sessionPersistence.stat(root.agent.id)
  if (stat?.location?.kind !== 'jsonl') throw new Error('expected a JSONL location')
  root.close()
  const disposal = handle.dispose().then(() => 'settled', code)
  await writer.close()
  await rm(stat.location.path)
  const whileRunning = await competing(ctx, 'deleted-settled-running')
  done.resolve({ status: 'killed' })
  expect({ whileRunning, disposal: await disposal, afterSettlement: await competing(ctx, 'deleted-settled-after') })
    .toEqual({ whileRunning: 'TICKET_ATTEMPT_STATE', disposal: 'TICKET_SETTLEMENT_PENDING', afterSettlement: 'admitted' })
})

it('R5-5 restart ends an execution admission of any placement that never reached its workspace stage', async () => {
  const earlier = await harness()
  const root = await live(earlier.ctx, 'placement-root')
  const { agent: worker } = await live(earlier.ctx, 'placement-worker')
  const ticket = await assigned(earlier.ctx, root.agent, worker)
  const begin = (attempt: string, capture?: () => void) => earlier.ctx.agents.withInitiator(worker, () => earlier.ctx.tickets.beginAttempt(
    root.agent.session, {
      ticketId: ticket.id, expectedRevision: earlier.ctx.tickets.get(root.agent.session, ticket.id).revision, actorId: worker.id,
      assignmentId: ticket.assignments[0]!.id, attemptId: TicketAttemptId(attempt), operationId: TicketOperationId(`${attempt}-begin`),
      workspace: shared, executor: { kind: 'dedicated-process', provider: 'review-provider' },
    }, capture))
  await begin('dedicated-admission', () => {})
  root.close()
  const later = await harness()
  const { agent: resumed } = await live(later.ctx, 'placement-root', root.agent.session)
  await vi.waitFor(() => { expect(later.ctx.tickets.get(resumed.session, ticket.id).attempts[0]?.status).toBe('settled') })
  expect(later.ctx.tickets.get(resumed.session, ticket.id).attempts[0]).toMatchObject({ outcome: 'cancelled',
    diagnostics: ['The admission ended with the host that admitted it before any producer started; recovered as cancelled'] })
})

it('R5-5 restart leaves a manual dedicated-process attempt for host reconciliation', async () => {
  const earlier = await harness()
  const root = await live(earlier.ctx, 'manual-root')
  const { agent: worker } = await live(earlier.ctx, 'manual-worker')
  const ticket = await assigned(earlier.ctx, root.agent, worker)
  await earlier.ctx.agents.withInitiator(worker, () => earlier.ctx.tickets.beginAttempt(root.agent.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: worker.id, assignmentId: ticket.assignments[0]!.id,
    attemptId: TicketAttemptId('manual-attempt'), operationId: TicketOperationId('manual-begin'),
    workspace: shared, executor: { kind: 'dedicated-process', provider: 'review-provider' },
  }))
  root.close()
  const later = await harness()
  const { agent: resumed } = await live(later.ctx, 'manual-root', root.agent.session)
  await new Promise(resolve => setImmediate(resolve))
  expect({ attempt: later.ctx.tickets.get(resumed.session, ticket.id).attempts[0]?.status, competing: await competing(later.ctx, 'manual-competing') })
    .toEqual({ attempt: 'preparing', competing: 'TICKET_ATTEMPT_STATE' })
})

it('R5-m1 a settlement tombstone keeps one fingerprint per retired operation id', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'fingerprint-root')
  const { agent: worker } = await live(ctx, 'fingerprint-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'fingerprint'))
  await handle.settle()
  const tombstone = ctx.tickets.get(root.session, ticket.id).operations.find(item => item.retiredIds !== undefined)
  expect(tombstone?.retiredRequests?.length).toBe(tombstone?.retiredIds?.length)
  expect(tombstone?.retiredIds).toContain(`ticket-execution:${JSON.stringify(['attempt-fingerprint', 'admitted'])}`)
})
