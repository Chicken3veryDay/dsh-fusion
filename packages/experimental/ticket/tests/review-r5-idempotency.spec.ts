/** Round-5 operation identity checks after settlement compaction and replay. */
import { expect, it } from 'vitest'
import { TicketAttemptId, TicketOperationId } from '../src/index.ts'
import { assigned, code, harness, live, shared } from './review-r5-harness.ts'

it('R5-m1 compacted operation identities still reject changed arguments after replay', async () => {
  const { ctx } = await harness()
  const { agent: root, close } = await live(ctx, 'compact-root')
  const { agent: worker } = await live(ctx, 'compact-worker')
  const ticket = await assigned(ctx, root, worker, [])
  const base = { ticketId: ticket.id, actorId: worker.id, attemptId: TicketAttemptId('compact-attempt') }
  const run = <T>(operation: () => Promise<T>) => ctx.agents.withInitiator(worker, operation)
  const revision = () => ctx.tickets.get(root.session, ticket.id).revision
  await run(() => ctx.tickets.beginAttempt(root.session, { ...base, expectedRevision: revision(),
    assignmentId: ticket.assignments[0]!.id, operationId: TicketOperationId('compact-begin'),
    workspace: shared, executor: { kind: 'in-process' } }))
  const update = { ...base, operationId: TicketOperationId('compact-update'), status: 'running' as const, diagnostics: ['original fact'] }
  await run(() => ctx.tickets.updateAttempt(root.session, { ...update, expectedRevision: revision() }))
  await run(() => ctx.tickets.settleAttempt(root.session, { ...base, expectedRevision: revision(),
    operationId: TicketOperationId('compact-settle'), outcome: 'succeeded' }))
  close()
  const { agent: reopened } = await live(ctx, 'compact-root', root.session)
  const before = ctx.tickets.get(reopened.session, ticket.id)
  const events = reopened.session.snapshotEvents().length
  await expect(run(() => ctx.tickets.updateAttempt(reopened.session, { ...update, expectedRevision: before.revision })))
    .resolves.toEqual(before)
  expect(reopened.session.snapshotEvents()).toHaveLength(events)
  const changedRetry = await run(() => ctx.tickets.updateAttempt(reopened.session, { ...update,
    expectedRevision: before.revision, diagnostics: ['a different fact never committed'],
  })).then(() => 'acknowledged', code)
  expect(changedRetry).toBe('TICKET_OPERATION_CONFLICT')
})
