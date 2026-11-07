/** Restart recovery leaves an attempt to a producer of an earlier service generation in this host, whatever its workspace. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TicketService, { TicketExecutionService } from '../src/index.ts'
import { assigned, code, live, request } from './review-r5-harness.ts'

class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create() {
    return { path: '/review/worktrees/isolated', branch: 'isolated', baseCommit: 'b'.repeat(40), repositoryRoot: '/review/shared' }
  }
}
class Directories extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  get() { return '/review/shared' }
  async ensure() { return '/review/shared' }
}
class Subagents extends Service {
  constructor(ctx: Context) { super(ctx, 'subagents') }
  getProvider() { return undefined }
  async startActivation(): Promise<never> { throw new Error('unexpected activation') }
}

it('a root resumed after replacement keeps an isolated-worktree attempt whose producer runs, and recovers it once that producer ends', async () => {
  const ctx = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const tickets = await ctx.plugin(TicketService, {})
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('recovery-ownership')
  await ctx.plugin(Worktrees)
  await ctx.plugin(Directories)
  await ctx.plugin(Subagents)
  const execution = await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  const root = await live(ctx, 'ownership-root')
  const { agent: worker } = await live(ctx, 'ownership-worker')
  const ticket = await assigned(ctx, root.agent, worker)
  const handle = await ctx.ticketExecution.prepare(worker, {
    ...request(root.agent, ticket, 'ownership'), workspace: { kind: 'isolated-worktree', directory: '/review/shared' },
  })
  const quiescent = Promise.withResolvers<undefined>()
  onTestFinished(() => { quiescent.resolve(undefined) })
  vi.spyOn(worker, 'whenIdle').mockImplementation(() => quiescent.promise)
  vi.spyOn(worker, 'cancel').mockImplementation(() => { throw new Error('producer refuses cancellation') })
  root.close()
  expect(await handle.dispose().then(() => 'settled', code)).toBe('TICKET_ATTEMPT_STATE')
  await execution.dispose()
  await tickets.dispose()
  await ctx.plugin(TicketService)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  const resumed = await live(ctx, root.agent.id, root.agent.session)
  await ctx.tickets.whenIdle(resumed.agent.session)
  const whileRunning = ctx.tickets.get(resumed.agent.session, ticket.id).attempts[0]?.status
  quiescent.resolve(undefined)
  await quiescent.promise
  // The reservation leaves once the producer's own signal settles, so the next resume recovers the attempt.
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  resumed.close()
  const reopened = await live(ctx, root.agent.id, resumed.agent.session)
  await ctx.tickets.whenIdle(reopened.agent.session)
  const afterQuiescence = ctx.tickets.get(reopened.agent.session, ticket.id).attempts[0]
  expect({ whileRunning, afterQuiescence: afterQuiescence?.status === 'settled' ? afterQuiescence.outcome : afterQuiescence?.status })
    .toEqual({ whileRunning: 'running', afterQuiescence: 'cancelled' })
})
