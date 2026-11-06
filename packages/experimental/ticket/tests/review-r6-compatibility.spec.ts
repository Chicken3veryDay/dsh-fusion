/** Round-6 controls for result reporting, historical tombstones and replay validation. */
import { expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { TicketAttemptId, TicketOperationId, TicketTools, ticketProjectionDefinition } from '../src/index.ts'
import { assigned, harness, live, request, shared } from './review-r5-harness.ts'

it('a naturally successful attempt can report through the tools, enter a candidate and complete across replay', async () => {
  const { ctx } = await harness()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(TicketTools)
  const root = await live(ctx, 'r6-success-root')
  const { agent: worker } = await live(ctx, 'r6-success-worker')
  const ticket = await assigned(ctx, root.agent, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'r6-success'))
  await handle.startJob('successful build', () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' }) }))
  await handle.settle()
  const common = { root_session_id: root.agent.id, ticket_id: ticket.id }
  const call = (name: string, args: Record<string, unknown>) => executeToolFixture(ctx, {
    agent: root.agent, name, arguments: args, callId: ToolCallId(name), signal: new AbortController().signal,
  })
  const current = () => ctx.tickets.get(root.agent.session, ticket.id)
  const result = await call('ticket_report', { ...common, expected_revision: current().revision,
    assignment_id: ticket.assignments[0]!.id, attempt_id: handle.attempt.id, kind: 'result', summary: 'Built' })
  expect(result.isError).toBe(false)
  const candidate = await call('ticket_submit_candidate', { ...common, expected_revision: current().revision,
    candidate_id: 'r6-success-candidate', spec_revision: 1, assignment_ids: [ticket.assignments[0]!.id],
    content: { kind: 'commit', repository: '/review/shared', commit: 'b'.repeat(40) } })
  expect(candidate.isError).toBe(false)
  const completed = await call('ticket_complete', { ...common, expected_revision: current().revision, summary: 'Accepted' })
  expect(completed.isError).toBe(false)
  const before = current()
  const events = root.agent.session.snapshotEvents().length
  await handle.settle()
  await handle.dispose()
  expect(root.agent.session.snapshotEvents()).toHaveLength(events)
  root.close()
  const { agent: resumed } = await live(ctx, 'r6-success-root', root.agent.session)
  expect(ctx.tickets.get(resumed.session, ticket.id)).toEqual(before)
  expect(before.terminalOutcome?.kind).toBe('completed')
})

it('historical tombstones without retired fingerprints retain their documented same-attempt acknowledgement', async () => {
  const { ctx } = await harness()
  const root = await live(ctx, 'r6-legacy-root')
  const { agent: worker } = await live(ctx, 'r6-legacy-worker')
  const ticket = await assigned(ctx, root.agent, worker, [])
  const base = { ticketId: ticket.id, actorId: worker.id, attemptId: TicketAttemptId('r6-legacy-attempt') }
  const revision = () => ctx.tickets.get(root.agent.session, ticket.id).revision
  await ctx.agents.withInitiator(worker, () => ctx.tickets.beginAttempt(root.agent.session, {
    ...base, expectedRevision: revision(), assignmentId: ticket.assignments[0]!.id,
    operationId: TicketOperationId('r6-legacy-begin'), workspace: shared, executor: { kind: 'in-process' },
  }))
  const update = { ...base, operationId: TicketOperationId('r6-legacy-update'), status: 'running' as const, diagnostics: ['old fact'] }
  await ctx.agents.withInitiator(worker, () => ctx.tickets.updateAttempt(root.agent.session, { ...update, expectedRevision: revision() }))
  await ctx.agents.withInitiator(worker, () => ctx.tickets.settleAttempt(root.agent.session, {
    ...base, expectedRevision: revision(), operationId: TicketOperationId('r6-legacy-settle'), outcome: 'succeeded',
  }))
  const legacy = Session.create(root.agent.id, root.agent.session.snapshotEvents().map(event =>
    event.type !== 'ticket/state' || event.data.version !== 2 ? event : {
      ...event, data: { ...event.data, ticket: { ...event.data.ticket,
        operations: event.data.ticket.operations.map(({ retiredRequests: _requests, ...operation }) => operation),
      } },
    }))
  root.close()
  const { agent: resumed } = await live(ctx, 'r6-legacy-root', legacy)
  const before = ctx.tickets.get(resumed.session, ticket.id)
  const count = resumed.session.snapshotEvents().length
  await expect(ctx.agents.withInitiator(worker, () => ctx.tickets.updateAttempt(resumed.session, {
    ...update, expectedRevision: before.revision, diagnostics: ['different legacy retry'],
  }))).resolves.toEqual(before)
  expect(resumed.session.snapshotEvents()).toHaveLength(count)
  let state = ticketProjectionDefinition.init(root.agent.session.header)
  for (const event of root.agent.session.snapshotEvents()) {
    state = ticketProjectionDefinition.apply(state, event.type !== 'ticket/state' || event.data.version !== 2 ? event : {
      ...event, data: { ...event.data, ticket: { ...event.data.ticket,
        operations: event.data.ticket.operations.map(operation => operation.retiredRequests === undefined ? operation
          : { ...operation, retiredRequests: operation.retiredRequests.slice(1) }),
      } },
    })
  }
  expect(state.failure).toContain('retired operation fingerprints must match retired ids')
})
