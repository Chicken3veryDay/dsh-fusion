/** Admission-guard and durable-command controls adjacent to the round-7 failures. */
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it, onTestFinished } from 'vitest'
import { TicketTools } from '../src/index.ts'
import { assigned, harness, live, request } from './review-r5-harness.ts'

it('a known live Job does not refuse disjoint shared-workspace admission', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'r7-guard-root')
  const { agent: worker } = await live(ctx, 'r7-guard-worker')
  const ticket = await assigned(ctx, root, worker)
  const first = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'r7-guard'))
  const done = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'killed' }) })
  await first.startJob('known live writer', () => ({ cancel() { done.resolve({ status: 'killed' }) }, done: done.promise }))
  const { agent: otherRoot } = await live(ctx, 'r7-guard-other-root')
  const { agent: otherWorker } = await live(ctx, 'r7-guard-other-worker')
  const other = await assigned(ctx, otherRoot, otherWorker, [{ path: 'other/file.ts', access: 'write', exclusive: true }])
  const second = await ctx.ticketExecution.prepare(otherWorker, request(otherRoot, other, 'r7-guard-other'))
  expect(ctx.jobs.list(worker.id).some(job => job.status === 'running')).toBe(true)
  await second.dispose()
  await first.dispose()
})

it.each(['proposed', 'ready', 'coordinating'] as const)('ticket_fail from %s survives durable replay', async (status) => {
  const { ctx } = await harness()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(TicketTools)
  const root = await live(ctx, `r7-fail-${status}-root`)
  const { agent: worker } = await live(ctx, `r7-fail-${status}-worker`)
  let ticket = await ctx.agents.withInitiator(root.agent, () => ctx.tickets.create(root.agent.session, {
    subject: 'Failure replay control', description: '',
  }))
  if (status === 'ready') {
    ticket = await ctx.agents.withInitiator(root.agent, () => ctx.tickets.assign(root.agent.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.agent.id,
      ownerId: worker.id, subject: 'Contribution',
    }))
  } else if (status === 'coordinating') {
    ticket = await ctx.agents.withInitiator(root.agent, () => ctx.tickets.handoff(root.agent.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.agent.id, newCoordinatorId: worker.id,
    }))
  }
  expect(ticket.status).toBe(status)
  const coordinator = status === 'coordinating' ? worker : root.agent
  const failed = await executeToolFixture(ctx, { agent: coordinator, name: 'ticket_fail', callId: ToolCallId(`r7-fail-${status}`),
    arguments: { root_session_id: root.agent.id, ticket_id: ticket.id, expected_revision: ticket.revision, summary: 'Abandoned' },
    signal: new AbortController().signal,
  })
  expect(failed.isError).toBe(false)
  const before = ctx.tickets.get(root.agent.session, ticket.id)
  expect(before.terminalOutcome?.kind).toBe('failed')
  root.close()
  const { agent: resumed } = await live(ctx, root.agent.id, root.agent.session)
  expect(ctx.tickets.get(resumed.session, ticket.id)).toEqual(before)
})
