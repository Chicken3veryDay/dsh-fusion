/** Round-5 regressions for known outcomes and owner disposal during preparation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { TicketExecutionService } from '../src/index.ts'
import { assigned, code, competing, harness, live, outcomeOf, request } from './review-r5-harness.ts'

it('R5-1 preparation retains its certain outcome when the cleanup receipt flush also fails', async () => {
  const { ctx, execution } = await harness()
  const { agent: root } = await live(ctx, 'cleanup-root')
  const { agent: worker } = await live(ctx, 'cleanup-worker')
  const ticket = await assigned(ctx, root, worker)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let calls = 0
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    calls++
    // Admission succeeds; the workspace write and its cleanup write hit the same storage outage.
    if (calls === 2 || calls === 3) throw new Error('receipt storage unavailable')
    return flush(session)
  })
  await expect(ctx.ticketExecution.prepare(worker, request(root, ticket, 'cleanup'))).rejects.toThrow('Ticket preparation ended before a producer started')
  spy.mockRestore()
  // Storage recovers. A later Ticket write and execution teardown must finish the known failed attempt.
  await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, { subject: 'Storage recovered', description: '' }))
  await execution.dispose()
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  expect({ attempt: ctx.tickets.get(root.session, ticket.id).attempts[0]?.status,
    outcome: outcomeOf(ctx.tickets.get(root.session, ticket.id).attempts[0]),
    competing: await competing(ctx, 'cleanup-competing') }).toEqual({ attempt: 'settled', outcome: 'failed', competing: 'admitted' })
})

it('R5-2 a worker disposed during admission cannot acquire a live execution handle afterwards', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'dispose-root')
  const worker = await live(ctx, 'dispose-worker')
  const ticket = await assigned(ctx, root, worker.agent)
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
    entered.resolve(undefined)
    await gate.promise
    return flush(session)
  }).mockImplementation(flush)
  const preparation = ctx.ticketExecution.prepare(root, request(root, ticket, 'disposed-worker'))
  await entered.promise
  worker.close()
  gate.resolve(undefined)
  let producerStartedAfterWorkerDisposal = false
  const result = await preparation.then(async (handle) => {
    await handle.startJob('work attributed to the disposed worker', () => {
      producerStartedAfterWorkerDisposal = true
      return { cancel() {}, done: Promise.resolve({ status: 'completed' as const }) }
    })
    return 'prepared-after-worker-disposal'
  }, code)
  spy.mockRestore()
  const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
  expect({ result, status: attempt?.status, outcome: outcomeOf(attempt), producerStartedAfterWorkerDisposal }).toEqual({
    result: 'TICKET_AUTHORITY', status: 'settled', outcome: 'cancelled', producerStartedAfterWorkerDisposal: false,
  })
})

it('R5-5 restart can terminate an execution admission whose flush failed twice before any producer started', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-r5-restart-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const earlier = await harness(async (ctx) => { await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' }) })
  const { agent: root } = await live(earlier.ctx, 'twice-root')
  const { agent: worker } = await live(earlier.ctx, 'twice-worker')
  const writer = await earlier.ctx.sessionPersistence.create(root.session.header)
  onTestFinished(() => writer.close())
  await writer.append(root.session.snapshotEvents())
  const ticket = await assigned(earlier.ctx, root, worker)
  const flush = vi.spyOn(earlier.ctx.sessions, 'flush').mockRejectedValue(new Error('admission checkpoint failed'))
  const prepare = () => earlier.ctx.ticketExecution.prepare(worker, request(root, ticket, 'twice'))
  await expect(prepare()).rejects.toThrow('admission checkpoint failed')
  await expect(prepare()).rejects.toThrow('admission checkpoint failed')
  flush.mockRestore()
  // A background persistence barrier can save the prefix after storage recovers, before the host exits.
  await earlier.ctx.sessionPersistence.flush()
  await writer.close()
  await using stored = await earlier.ctx.sessionPersistence.open(root.id, 'read')
  const persisted = await stored.read()
  const seed = Session.create(root.id, persisted.events, stored.header)
  const later = await harness()
  const { agent: resumed } = await live(later.ctx, 'twice-root', seed)
  const current = later.ctx.tickets.get(resumed.session, ticket.id)
  const cancellation = await later.ctx.agents.withInitiator(resumed, () => later.ctx.tickets.cancel(resumed.session, {
    ticketId: ticket.id, expectedRevision: current.revision, actorId: resumed.id, summary: 'No producer ever started',
  })).then(view => view.status, code)
  const after = later.ctx.tickets.get(resumed.session, ticket.id)
  expect({ attempt: after.attempts[0]?.status, cancellation, competing: await competing(later.ctx, 'twice-competing') })
    .toEqual({ attempt: 'settled', cancellation: 'cancelled', competing: 'admitted' })
})

it('R5-3 a successful natural settlement still permits reporting the completed contribution', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'result-root')
  const { agent: worker } = await live(ctx, 'result-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'result'))
  await handle.startJob('successful build', () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' }) }))
  await handle.settle()
  const current = ctx.tickets.get(root.session, ticket.id)
  expect(current.attempts[0]).toMatchObject({ status: 'settled', outcome: 'succeeded' })
  await expect(ctx.agents.withInitiator(root, () => ctx.tickets.report(root.session, {
    ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id,
    assignmentId: ticket.assignments[0]!.id, attemptId: handle.attempt.id,
    kind: 'result', summary: 'The completed build produced the requested contribution',
  }))).resolves.toMatchObject({ assignments: [expect.objectContaining({ status: 'completed' })] })
})

it('R5 unloading Ticket waits for its execution consumer to persist terminal settlement', async () => {
  const { ctx, tickets } = await harness()
  const { agent: root } = await live(ctx, 'unload-root')
  const { agent: worker } = await live(ctx, 'unload-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'unload'))
  const cancelled = Promise.withResolvers<undefined>()
  const done = Promise.withResolvers<import('@deepseek-ai/dsh-jobs').JobOutcome>()
  await handle.startJob('delayed cancellation', () => ({ cancel() { cancelled.resolve(undefined) }, done: done.promise }))
  const unloading = Promise.resolve(tickets.dispose()).then(() => 'disposed', code)
  await cancelled.promise
  done.resolve({ status: 'killed' })
  const result = await unloading
  const last = root.session.snapshotEvents().filter(event => event.type === 'ticket/state').at(-1)
  if (last?.data.version !== 2) throw new Error('expected a v2 Ticket event')
  expect({ result, attempt: last.data.ticket.attempts[0]?.status, outcome: outcomeOf(last.data.ticket.attempts[0]) }).toEqual({
    result: 'disposed', attempt: 'settled', outcome: 'cancelled',
  })
})

it('R5-m2 the preparation signal ends at handle publication; a startJob signal cancels its producer', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'signal-root')
  const { agent: worker } = await live(ctx, 'signal-worker')
  const ticket = await assigned(ctx, root, worker)
  const preparation = new AbortController()
  const handle = await ctx.ticketExecution.prepare(worker, { ...request(root, ticket, 'signal'), signal: preparation.signal })
  const job = new AbortController()
  const cancelled: string[] = []
  const producer = (name: string) => {
    const done = Promise.withResolvers<import('@deepseek-ai/dsh-jobs').JobOutcome>()
    return { done, hooks: () => ({ cancel() { cancelled.push(name); done.resolve({ status: 'killed' }) }, done: done.promise }) }
  }
  const prepared = producer('prepare-signal producer')
  const attached = producer('job-signal producer')
  await ctx.agents.withInitiator(worker, () => handle.startJob('prepare-signal producer', prepared.hooks))
  await ctx.agents.withInitiator(worker, () => handle.startJob('job-signal producer', attached.hooks, job.signal))
  preparation.abort(new Error('caller cancelled its preparation'))
  job.abort(new Error('caller cancelled its Job'))
  prepared.done.resolve({ status: 'completed' })
  await handle.settle()
  expect({ cancelled, outcome: outcomeOf(ctx.tickets.get(root.session, ticket.id).attempts[0]) })
    .toEqual({ cancelled: ['job-signal producer'], outcome: 'cancelled' })
})
