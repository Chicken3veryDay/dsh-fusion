/** Round-6 preparation cancellation through the real external activation manager. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkstreamService, { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { expect, it, onTestFinished, vi } from 'vitest'
import TicketService, { TicketExecutionService } from '../src/index.ts'
import { assigned, code, competing, live, request } from './review-r5-harness.ts'

class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create(): Promise<never> { throw new Error('unexpected worktree') }
}
class Directories extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  get() { return '/review/shared' }
  async ensure() { return '/review/shared' }
}

async function externalHarness() {
  const ctx = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('review-r6-external')
  await ctx.plugin(Directories)
  await ctx.plugin(Worktrees)
  await ctx.plugin(SubagentRuntime)
  const execution = await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  return { ctx, execution }
}

it('R6-4 root disposal during external startup settles a cleanly aborted preparation after resume and teardown', async () => {
  const { ctx, execution } = await externalHarness()
  const entered = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  let producerStarted = false
  ctx.subagents.registerProvider({
    name: 'r6-external', execution: { kind: 'dedicated-process' }, inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start({ signal }) {
      entered.resolve(undefined)
      signal.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
      await cancelled.promise
      signal.throwIfAborted()
      producerStarted = true
      throw new Error('unexpected producer startup after cancellation')
    },
  })
  const root = await live(ctx, 'r6-external-root')
  const { agent: worker } = await live(ctx, 'r6-external-worker')
  const ticket = await assigned(ctx, root.agent, worker)
  const preparation = ctx.ticketExecution.prepare(root.agent, {
    ...request(root.agent, ticket, 'r6-external'), executor: { kind: 'dedicated-process', provider: 'r6-external' },
  }).then(() => 'published', code)
  await entered.promise
  root.close()
  await cancelled.promise
  const failure = await preparation
  expect(failure).toContain('TICKET_AUTHORITY')
  const { agent: resumed } = await live(ctx, 'r6-external-root', root.agent.session)
  await ctx.agents.withInitiator(resumed, () => ctx.tickets.create(resumed.session, { subject: 'Resume barrier', description: '' }))
  await execution.dispose()
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  const attempt = ctx.tickets.get(resumed.session, ticket.id).attempts[0]
  const current = ctx.tickets.get(resumed.session, ticket.id)
  const cancellation = await ctx.agents.withInitiator(resumed, () => ctx.tickets.cancel(resumed.session, {
    ticketId: ticket.id, expectedRevision: current.revision, actorId: resumed.id, summary: 'No producer started',
  })).then(value => value.status, code)
  expect({ producerStarted, status: attempt?.status, outcome: attempt?.status === 'settled' ? attempt.outcome : undefined,
    cancellation, competing: await competing(ctx, 'r6-external-competing') })
    .toEqual({ producerStarted: false, status: 'settled', outcome: 'cancelled', cancellation: 'cancelled', competing: 'admitted' })
})


it('R6-m1 direct Ticket assignment bypasses the Workstream active-member rule', async () => {
  const { ctx } = await externalHarness()
  const dir = await mkdtemp(join(tmpdir(), 'ticket-r6-authority-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await ctx.plugin(WorkstreamService)
  const { agent: root } = await live(ctx, 'r6-membership-root')
  const { agent: outsider } = await live(ctx, 'r6-membership-outsider')
  await ctx.workstreams.open(root, { operationId: WorkstreamOperationId('r6-membership-open'), title: 'Membership review' })
  const ticket = await ctx.workstreams.createTicket(root, root.id, { subject: 'Work', description: '' })
  const assignment = { ticketId: ticket.id, expectedRevision: ticket.revision, ownerId: outsider.id, subject: 'Contribute' }
  const guarded = await ctx.workstreams.assignTicket(root, root.id, assignment).then(() => 'assigned', code)
  expect(guarded).toBe('WORKSTREAM_INVALID_INPUT')
  const direct = await ctx.agents.withInitiator(root, () => ctx.tickets.assign(root.session, { ...assignment, actorId: root.id }))
    .then(() => 'assigned', code)
  expect(direct).toBe('TICKET_AUTHORITY')
})
