/** Exercise Ticket startup against the real Subagent activation/rollback owner. */
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime, { type SubagentResult } from '@deepseek-ai/dsh-subagent'
import { expect, it, onTestFinished } from 'vitest'
import TicketService, { TicketExecutionService } from '../src/index.ts'
import { assigned, code, competing, live, request } from './review-r5-harness.ts'

class Directories extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure() { return '/review/shared' }
}
class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create(): Promise<never> { throw new Error('unexpected Worktree creation') }
}

async function externalHarness(before?: (ctx: Context) => Promise<void>) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await before?.(ctx)
  const tickets = await ctx.plugin(TicketService)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('r7-external')
  await ctx.plugin(Directories)
  await ctx.plugin(Worktrees)
  await ctx.plugin(SubagentRuntime)
  const execution = await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 20 })
  return { ctx, tickets, execution }
}

it('R7-4 a rejected Subagent admission with failed rollback cannot release its live producer', async () => {
  const { ctx } = await externalHarness()
  const { agent: root } = await live(ctx, 'r7-rollback-root')
  const { agent: worker } = await live(ctx, 'r7-rollback-worker')
  const ticket = await assigned(ctx, root, worker)
  const entered = Promise.withResolvers<undefined>()
  const publish = Promise.withResolvers<undefined>()
  const done = Promise.withResolvers<SubagentResult>()
  let producerFinished = false
  let disposals = 0
  const completion = done.promise.then((result) => { producerFinished = true; return result })
  ctx.subagents.registerProvider({
    name: 'r7-rollback', execution: { kind: 'dedicated-process' }, inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start() {
      entered.resolve(undefined)
      await publish.promise
      return { id: SessionId('r7-external-producer'), result: completion,
        async dispose() { disposals++; throw new Error('external cancellation failed before producer exited') } }
    },
  })
  const abort = new AbortController()
  const preparation = ctx.ticketExecution.prepare(root, {
    ...request(root, ticket, 'r7-rollback'), executor: { kind: 'dedicated-process', provider: 'r7-rollback' },
    signal: abort.signal,
  }).then(() => 'published', code)
  await entered.promise
  abort.abort(new Error('caller cancelled overlapping provider startup'))
  publish.resolve(undefined)
  const result = await preparation
  expect(result).not.toBe('published')
  expect(disposals).toBe(1)
  const observed = { producerFinished, attempt: ctx.tickets.get(root.session, ticket.id).attempts[0]?.status,
    competing: await competing(ctx, 'r7-rollback-conflict') }
  done.resolve({ output: [], stopReason: 'aborted' })
  await completion
  expect(observed).toEqual({ producerFinished: false, attempt: 'unknown', competing: 'TICKET_ATTEMPT_STATE' })
})

it('R7-5 a captured external result cannot hide failed cleanup and release an unfinished producer', async () => {
  const { ctx } = await externalHarness()
  const { agent: root } = await live(ctx, 'r7-result-root')
  const { agent: worker } = await live(ctx, 'r7-result-worker')
  const ticket = await assigned(ctx, root, worker)
  const result = Promise.withResolvers<SubagentResult>()
  const exited = Promise.withResolvers<undefined>()
  let producerQuiescent = false
  const quiescence = exited.promise.then(() => { producerQuiescent = true })
  onTestFinished(async () => { exited.resolve(undefined); await quiescence })
  let cleanupAttempts = 0
  ctx.subagents.registerProvider({
    name: 'r7-result', execution: { kind: 'dedicated-process' }, inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start() {
      return { id: SessionId('r7-result-producer'), result: result.promise,
        async dispose() { cleanupAttempts++; throw new Error('failed to stop retained child process') } }
    },
  })
  const handle = await ctx.ticketExecution.prepare(root, {
    ...request(root, ticket, 'r7-result'), executor: { kind: 'dedicated-process', provider: 'r7-result' },
  })
  // SubagentRun explicitly allows a captured result before resource release.
  result.resolve({ output: [], stopReason: 'completed' })
  const stopped = await handle.settle().then(() => 'settled', code)
  expect(cleanupAttempts).toBe(1)
  const observed = { stopped, producerQuiescent, attempt: ctx.tickets.get(root.session, ticket.id).attempts[0]?.status,
    competing: await competing(ctx, 'r7-result-conflict') }
  exited.resolve(undefined)
  await quiescence
  expect(observed).toEqual({ stopped: 'TICKET_ATTEMPT_STATE', producerQuiescent: false,
    attempt: 'unknown', competing: 'TICKET_ATTEMPT_STATE' })
})

it('R7-2b replacement retains a deleted root reservation for a real Subagent activation without a Job', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-r7-activation-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const { ctx, tickets, execution } = await externalHarness(async (context) => {
    await context.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  })
  const root = await live(ctx, 'r7-activation-root')
  const { agent: worker } = await live(ctx, 'r7-activation-worker')
  const writer = await ctx.sessionPersistence.create(root.agent.session.header)
  onTestFinished(() => writer.close())
  await writer.append(root.agent.session.snapshotEvents())
  const ticket = await assigned(ctx, root.agent, worker)
  const done = Promise.withResolvers<SubagentResult>()
  let producerFinished = false
  const completion = done.promise.then((result) => { producerFinished = true; return result })
  onTestFinished(() => { done.resolve({ output: [], stopReason: 'aborted' }) })
  ctx.subagents.registerProvider({
    name: 'r7-activation', execution: { kind: 'dedicated-process' }, inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start() {
      return { id: SessionId('r7-activation-producer'), result: completion, async dispose() { await completion } }
    },
  })
  const handle = await ctx.ticketExecution.prepare(root.agent, {
    ...request(root.agent, ticket, 'r7-activation'), executor: { kind: 'dedicated-process', provider: 'r7-activation' },
  })
  const stat = await ctx.sessionPersistence.stat(root.agent.id)
  if (stat?.location?.kind !== 'jsonl') throw new Error('expected JSONL storage')
  root.close()
  await handle.dispose().catch(code)
  await writer.close()
  await rm(stat.location.path)
  expect(await competing(ctx, 'r7-activation-before')).toBe('TICKET_ATTEMPT_STATE')
  await execution.dispose()
  await tickets.dispose()
  await ctx.plugin(TicketService)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 20 })
  const observed = { producerFinished, admission: await competing(ctx, 'r7-activation-after') }
  done.resolve({ output: [], stopReason: 'aborted' })
  await completion
  await handle.dispose().catch(code)
  expect(observed).toEqual({ producerFinished: false, admission: 'TICKET_ATTEMPT_STATE' })
})
