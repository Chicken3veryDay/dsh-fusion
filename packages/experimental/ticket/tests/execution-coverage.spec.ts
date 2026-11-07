import { expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import Subagents, { type SubagentProvider, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import TicketService, { AssignmentId, TicketExecutionService, TicketOperationId } from '../src/index.ts'
import { assigned, harness, live, request } from './review-r5-harness.ts'

it('validates settlement deadlines before accepting execution configuration', () => {
  for (const settlementTimeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    expect(() => new TicketExecutionService(ctx, { settlementTimeoutMs })).toThrow('positive safe integer')
  }
})

it('rejects missing roots, missing assignments, foreign callers and disposed execution owners', async () => {
  const { ctx, execution } = await harness()
  const { agent: root } = await live(ctx, 'coverage-root')
  const { agent: worker } = await live(ctx, 'coverage-worker')
  const { agent: other } = await live(ctx, 'coverage-other')
  const ticket = await assigned(ctx, root, worker)
  const prepare = request(root, ticket, 'coverage-admission')
  await expect(ctx.ticketExecution.prepare(worker, { ...prepare, rootSessionId: SessionId('missing') })).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' })
  await expect(ctx.ticketExecution.prepare(worker, { ...prepare, assignmentId: AssignmentId('missing') })).rejects.toMatchObject({ code: 'TICKET_ASSIGNMENT_NOT_FOUND' })
  await expect(ctx.ticketExecution.prepare(other, prepare)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(ctx.ticketExecution.prepare(worker, { ...prepare, expectedRevision: 1 })).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
  const handle = await ctx.ticketExecution.prepare(worker, prepare)
  const idle = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  vi.spyOn(worker, 'whenIdle').mockImplementation(async () => { entered.resolve(undefined); await idle.promise })
  const service = ctx.ticketExecution
  const disposal = execution.dispose()
  await entered.promise
  await expect(service.prepare(worker, prepare)).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  idle.resolve(undefined)
  await disposal
  expect(handle.attempt.status).toBe('running')
})

it('rejects unregistered workers and directory mismatches before recording admission', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'coverage-admit-root')
  const worker = await live(ctx, 'coverage-admit-worker')
  const ticket = await assigned(ctx, root, worker.agent)
  worker.close()
  await expect(ctx.ticketExecution.prepare(root, request(root, ticket, 'missing-worker'))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  const { agent: resumed } = await live(ctx, 'coverage-admit-worker', worker.agent.session)
  await expect(ctx.ticketExecution.prepare(resumed, { ...request(root, ticket, 'wrong-directory'), workspace: { kind: 'shared-workspace', directory: '/other', baseCommit: 'a'.repeat(40) } })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts).toEqual([])
})

class Directories extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure() { return '/review/shared' }
}
class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create() { return { path: '/review/isolated', branch: 'coverage', baseCommit: 'a'.repeat(40), repositoryRoot: '/review/shared' } }
}
async function external() {
  const ctx = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('coverage')
  await ctx.plugin(Directories)
  await ctx.plugin(Worktrees)
  await ctx.plugin(Subagents)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  const { agent: root } = await live(ctx, 'external-coverage-root')
  const { agent: worker } = await live(ctx, 'external-coverage-worker')
  const ticket = await assigned(ctx, root, worker)
  return { ctx, root, worker, ticket }
}
const capabilities = { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }

it('rejects provider placement, world, and model capability mismatches', async () => {
  const { ctx, root, ticket } = await external()
  for (const execution of [undefined, { kind: 'dedicated-process' as const }, { kind: 'remote' as const, world: 'one' }]) {
    const name = execution?.kind ?? 'undeclared'
    ctx.subagents.registerProvider({ name, capabilities, inheritsParentContext: false, ...execution === undefined ? {} : { execution }, async start(): Promise<never> { throw new Error('must not start') } })
  }
  const prepare = request(root, ticket, 'preflight')
  await expect(ctx.ticketExecution.prepare(root, { ...prepare, executor: { kind: 'dedicated-process', provider: 'undeclared' } })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  await expect(ctx.ticketExecution.prepare(root, { ...prepare, executor: { kind: 'remote', provider: 'dedicated-process', world: 'one' } })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  await expect(ctx.ticketExecution.prepare(root, { ...prepare, executor: { kind: 'remote', provider: 'remote', world: 'two' } })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  await expect(ctx.ticketExecution.prepare(root, { ...prepare, executor: { kind: 'dedicated-process', provider: 'dedicated-process' }, modelSelection: { provider: 'model', model: 'one', settings: '{}' } })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts).toEqual([])
})

it.each(['completed', 'aborted', 'error'] as const)('records the %s outcome of a remote activation with model selection', async (stopReason) => {
  const { ctx, root, ticket } = await external()
  const provider: SubagentProvider = {
    name: 'remote', execution: { kind: 'remote', world: 'one' }, inheritsParentContext: false,
    capabilities: { ...capabilities, agentOptions: true },
    async start({ agentOptions }) {
      expect(agentOptions).toEqual({ provider: 'model', model: 'one' })
      return { id: SessionId('remote-child'), result: Promise.resolve({ output: [], stopReason }), async dispose() {} }
    },
  }
  ctx.subagents.registerProvider(provider)
  const handle = await ctx.ticketExecution.prepare(root, { ...request(root, ticket, 'remote'), executor: { kind: 'remote', provider: 'remote', world: 'one' }, modelSelection: { provider: 'model', model: 'one', settings: '{}' } })
  expect(handle.attempt.runtimeReceipt).toMatchObject({ world: 'one', childSessionId: 'remote-child', providerId: 'remote' })
  expect(await handle.result).toMatchObject({ stopReason })
  await handle.settle()
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: stopReason === 'completed' ? 'succeeded' : stopReason === 'aborted' ? 'cancelled' : 'failed' })
})

it('passes isolated checkout defaults and refuses jobs after a host reconciles the attempt', async () => {
  const { ctx, root, ticket } = await external()
  const { agent: worker } = await live(ctx, 'isolated-owner')
  const own = await assigned(ctx, root, worker)
  const create = vi.spyOn(ctx.worktrees, 'create')
  const handle = await ctx.ticketExecution.prepare(worker, { ...request(root, own, 'isolated-default'), workspace: { kind: 'isolated-worktree', directory: '/review/shared' } })
  expect(create).toHaveBeenCalledWith(worker, { name: 'attempt-isolated-default' }, expect.any(AbortSignal))
  expect(handle.workspace.directory).toBe('/review/isolated')
  const current = ctx.tickets.get(root.session, own.id)
  await ctx.agents.withInitiator(root, () => ctx.tickets.settleAttempt(root.session, { ticketId: own.id, expectedRevision: current.revision, actorId: root.id, attemptId: handle.attempt.id, operationId: TicketOperationId('host-settle'), outcome: 'cancelled' }))
  let started = false
  await expect(handle.startJob('must not start', () => { started = true; return { cancel() {}, done: Promise.resolve({ status: 'completed' }) } })).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  expect(started).toBe(false)
  await handle.dispose()
  expect(ctx.tickets.get(root.session, ticket.id).attempts).toEqual([])
})

it('contains rejected producer promises and startup exceptions in failed settlement', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'producer-errors-root')
  const { agent: worker } = await live(ctx, 'producer-errors-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'producer-errors'))
  await expect(handle.startJob('startup fails', () => { throw new Error('startup failed') })).rejects.toThrow('startup failed')
  const done = Promise.withResolvers<JobOutcome>()
  await handle.startJob('producer rejects', () => ({ cancel() { done.resolve({ status: 'killed' }) }, done: done.promise }))
  done.reject(new Error('producer failed'))
  await handle.settle()
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
})

it('observes an already-aborted Job signal before invoking its producer', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'job-abort-root')
  const { agent: worker } = await live(ctx, 'job-abort-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'job-abort'))
  const abort = new AbortController()
  abort.abort(new Error('already cancelled'))
  let started = false
  await expect(handle.startJob('aborted', () => { started = true; return { cancel() {}, done: Promise.resolve({ status: 'completed' }) } }, abort.signal)).rejects.toThrow('already cancelled')
  expect(started).toBe(false)
  await handle.dispose()
})

it('requires an absolute workspace and a shared base commit before admitting effects', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'workspace-input-root')
  const { agent: worker } = await live(ctx, 'workspace-input-worker')
  const ticket = await assigned(ctx, root, worker)
  for (const workspace of [
    { kind: 'shared-workspace' as const, directory: 'relative', baseCommit: 'a'.repeat(40) },
    { kind: 'shared-workspace' as const, directory: '/review/shared' },
  ]) await expect(ctx.ticketExecution.prepare(worker, { ...request(root, ticket, 'workspace-input'), workspace })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts).toEqual([])
})

it('requires the technical root Agent even when its Session remains live', async () => {
  const { ctx } = await harness()
  const root = await live(ctx, 'root-agent-admission')
  const { agent: worker } = await live(ctx, 'worker-agent-admission')
  const ticket = await assigned(ctx, root.agent, worker)
  root.detachAgent()
  await expect(ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'root-agent-admission'))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  expect(ctx.tickets.get(root.agent.session, ticket.id).attempts).toEqual([])
})

it('refuses background admission while its root Session is unavailable', async () => {
  const { ctx } = await harness()
  const root = await live(ctx, 'job-root-unavailable')
  const { agent: worker } = await live(ctx, 'job-worker-available')
  const ticket = await assigned(ctx, root.agent, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'job-root-unavailable'))
  root.detachSession()
  await expect(handle.startJob('root is gone', () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' }) }))).rejects.toMatchObject({ code: 'TICKET_ROOT_UNAVAILABLE' })
  root.detachAgent()
  const { agent: resumed } = await live(ctx, root.agent.id, root.agent.session)
  await handle.dispose()
  expect(ctx.tickets.get(resumed.session, ticket.id).attempts[0]!.status).toBe('settled')
})

it('does not treat a rejected external result as successful producer completion', async () => {
  const { ctx, root, ticket } = await external()
  const result = Promise.withResolvers<SubagentResult>()
  let disposed = 0
  ctx.subagents.registerProvider({ name: 'rejected', execution: { kind: 'dedicated-process' }, capabilities, inheritsParentContext: false,
    async start() { return { id: SessionId('rejecting-child'), result: result.promise, async dispose() { disposed++ } } },
  })
  const handle = await ctx.ticketExecution.prepare(root, { ...request(root, ticket, 'rejected-result'), executor: { kind: 'dedicated-process', provider: 'rejected' } })
  result.reject(new Error('external result capture failed'))
  await expect(handle.settle()).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  expect(disposed).toBeGreaterThan(0)
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]!.status).toBe('unknown')
  const current = ctx.tickets.get(root.session, ticket.id)
  await ctx.agents.withInitiator(root, () => ctx.tickets.settleAttempt(root.session, { ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, attemptId: handle.attempt.id, operationId: TicketOperationId('host-reconcile'), outcome: 'failed' }))
  const refreshed = ctx.tickets.get(root.session, ticket.id)
  const next = await ctx.ticketExecution.prepare(root, { ...request(root, refreshed, 'after-reconciliation'), executor: { kind: 'in-process' } })
  await expect(handle.settle()).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  await next.dispose()
})

it('contains a cancellation failure delivered synchronously during producer startup', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'sync-cancel-root')
  const { agent: worker } = await live(ctx, 'sync-cancel-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'sync-cancel'))
  const done = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'killed' }) })
  let cancellations = 0
  await expect(handle.startJob('cancel at startup', (job) => {
    ctx.jobs.kill(job.id, worker.id, 'startup cancellation')
    return { cancel() { cancellations++; throw new Error('synchronous cancellation refused') }, done: done.promise }
  })).rejects.toThrow('synchronous cancellation refused')
  expect(cancellations).toBe(1)
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]!.status).toBe('running')
  done.resolve({ status: 'completed' })
  await handle.settle()
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'succeeded' })
})

it('does not start queued producers when disposal overtakes receipt persistence', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'queued-jobs-root')
  const { agent: worker } = await live(ctx, 'queued-jobs-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'queued-jobs'))
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    entered.resolve(undefined)
    await release.promise
    return flush(session)
  })
  let starts = 0
  const run = () => { starts++; return { cancel() {}, done: Promise.resolve({ status: 'completed' as const }) } }
  const first = handle.startJob('first', run)
  await entered.promise
  const second = handle.startJob('second', run).then(() => 'started', (error: unknown) => error)
  const disposal = handle.dispose()
  release.resolve(undefined)
  await first
  expect(await second).toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  await disposal
  expect(starts).toBe(0)
})

it('rechecks the shared workspace receipt after asynchronous admission', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'late-workspace-root')
  const { agent: worker } = await live(ctx, 'late-workspace-worker')
  const ticket = await assigned(ctx, root, worker)
  const workspace: { kind: 'shared-workspace'; directory: string; baseCommit?: string } = {
    kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40),
  }
  vi.spyOn(ctx.workingDirectory, 'ensure').mockImplementation(async () => { delete workspace.baseCommit; return workspace.directory })
  await expect(ctx.ticketExecution.prepare(worker, { ...request(root, ticket, 'late-workspace'), workspace })).rejects.toThrow('baseCommit receipt')
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
})

it('fails a Job whose receipt cannot be persisted without starting its producer', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'job-receipt-failure-root')
  const { agent: worker } = await live(ctx, 'job-receipt-failure-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'job-receipt-failure'))
  const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('Job receipt storage failed'))
  let started = false
  await expect(handle.startJob('must persist first', () => { started = true; return { cancel() {}, done: Promise.resolve({ status: 'completed' }) } })).rejects.toThrow('Job receipt storage failed')
  flush.mockRestore()
  expect(started).toBe(false)
  await handle.settle()
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
})

it('combines a failed Worktree preparation with failure to persist its uncertainty', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'unknown-write-failure-root')
  const { agent: worker } = await live(ctx, 'unknown-write-failure-worker')
  const ticket = await assigned(ctx, root, worker)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (ctx.tickets.get(root.session, ticket.id).attempts[0]?.status === 'unknown') throw new Error('uncertainty storage failed')
    return flush(session)
  })
  const result = await ctx.ticketExecution.prepare(worker, { ...request(root, ticket, 'unknown-write-failure'), workspace: { kind: 'isolated-worktree', directory: '/review/shared' } }).catch((error: unknown) => error)
  expect(result).toBeInstanceOf(AggregateError)
  if (!(result instanceof AggregateError)) throw new Error('expected preparation failure')
  expect(result.errors).toHaveLength(2)
  expect(result.errors[1]).toMatchObject({ message: 'uncertainty storage failed' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]!.status).toBe('unknown')
})

it('retains the actual checkout receipt when cancellation overtakes Worktree creation', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'cancel-worktree-root')
  const { agent: worker } = await live(ctx, 'cancel-worktree-worker')
  const ticket = await assigned(ctx, root, worker)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  vi.spyOn(ctx.worktrees, 'create').mockImplementation(async () => {
    entered.resolve(undefined)
    await release.promise
    return { path: '/review/checkout', baseCommit: 'b'.repeat(40), branch: 'checkout', repositoryRoot: '/review/shared' }
  })
  const abort = new AbortController()
  const preparation = ctx.ticketExecution.prepare(worker, { ...request(root, ticket, 'cancel-worktree'), workspace: { kind: 'isolated-worktree', directory: '/review/shared' }, signal: abort.signal }).catch((error: unknown) => error)
  await entered.promise
  abort.abort(new Error('cancelled during checkout'))
  release.resolve(undefined)
  expect(await preparation).toMatchObject({ message: 'cancelled during checkout' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled', workspaceReceipt: { directory: '/review/checkout' } })
})

it('stops an activation returned just before the preparation signal aborts', async () => {
  const { ctx, root, ticket } = await external()
  const result = Promise.withResolvers<SubagentResult>()
  let disposed = 0
  ctx.subagents.registerProvider({ name: 'late-abort', execution: { kind: 'dedicated-process' }, capabilities, inheritsParentContext: false,
    async start() { return { id: SessionId('late-abort-child'), result: result.promise, async dispose() { disposed++; result.resolve({ output: [], stopReason: 'aborted' }) } } },
  })
  const abort = new AbortController()
  const activate = ctx.subagents.startActivation.bind(ctx.subagents)
  vi.spyOn(ctx.subagents, 'startActivation').mockImplementation(async (spec) => {
    const activation = await activate(spec)
    abort.abort(new Error('cancelled before publication'))
    return activation
  })
  await expect(ctx.ticketExecution.prepare(root, { ...request(root, ticket, 'late-abort'), executor: { kind: 'dedicated-process', provider: 'late-abort' }, signal: abort.signal })).rejects.toThrow('cancelled before publication')
  expect(disposed).toBe(1)
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled' })
})

it('reports teardown settlement failure after an in-flight admission has handed over its cancellation', async () => {
  const { ctx, execution } = await harness()
  const { agent: root } = await live(ctx, 'teardown-ledger-root')
  const { agent: worker } = await live(ctx, 'teardown-ledger-worker')
  const ticket = await assigned(ctx, root, worker)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const warning = vi.spyOn(ctx.logger, 'warn')
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
    if (attempt?.status === 'settled') throw new Error('teardown settlement unavailable')
    entered.resolve(undefined)
    await release.promise
    return flush(session)
  })
  const preparation = ctx.ticketExecution.prepare(worker, request(root, ticket, 'teardown-ledger')).catch((error: unknown) => error)
  await entered.promise
  const disposal = execution.dispose()
  release.resolve(undefined)
  await preparation
  await disposal
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('the settlement ledger retains it'))
})

it('detects an unpublished worker removed without a disposal event during a receipt write', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'unpublished-owner-root')
  const worker = await live(ctx, 'unpublished-owner-worker')
  worker.detachAgent()
  const detach = ctx.agents.enter(worker.agent, undefined)
  onTestFinished(detach)
  const ticket = await assigned(ctx, root, worker.agent)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
    if (attempt?.workspaceReceipt !== undefined && attempt.status !== 'settled') {
      entered.resolve(undefined)
      await release.promise
    }
    return flush(session)
  })
  const preparation = ctx.ticketExecution.prepare(root, request(root, ticket, 'unpublished-owner')).catch((error: unknown) => error)
  await entered.promise
  detach()
  release.resolve(undefined)
  expect(await preparation).toMatchObject({ code: 'TICKET_AUTHORITY' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
})

it('fails closed when Ticket admission returns without granting its recorder', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'missing-recorder-root')
  const { agent: worker } = await live(ctx, 'missing-recorder-worker')
  const ticket = await assigned(ctx, root, worker)
  const begin = ctx.tickets.beginAttempt.bind(ctx.tickets)
  vi.spyOn(ctx.tickets, 'beginAttempt').mockImplementationOnce((session, input) => begin(session, input))
  await expect(ctx.ticketExecution.prepare(worker, request(root, ticket, 'missing-recorder'))).rejects.toMatchObject({ code: 'TICKET_RECOVERY_FAILED' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]!.status).toBe('preparing')
  expect(ctx.jobs.list(worker.id)).toEqual([])
})

it('rejects an unavailable provider before recording execution admission', async () => {
  const { ctx, root, ticket } = await external()
  await expect(ctx.ticketExecution.prepare(root, { ...request(root, ticket, 'absent-provider'), executor: { kind: 'dedicated-process', provider: 'absent' } })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts).toEqual([])
})

it('normalizes a non-Error failure during provider preflight', async () => {
  const { ctx, root, ticket } = await external()
  vi.spyOn(ctx.subagents, 'getProvider').mockImplementationOnce(() => { throw 'provider catalog failed' })
  await expect(ctx.ticketExecution.prepare(root, {
    ...request(root, ticket, 'non-error'), executor: { kind: 'dedicated-process', provider: 'unavailable' },
  })).rejects.toMatchObject({ message: 'Ticket execution preparation failed', cause: 'provider catalog failed' })
})

it('observes cancellation while the directory provider is still resolving', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'directory-abort-root')
  const { agent: worker } = await live(ctx, 'directory-abort-worker')
  const ticket = await assigned(ctx, root, worker)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  vi.spyOn(ctx.workingDirectory, 'ensure').mockImplementation(async () => { entered.resolve(undefined); await release.promise; return '/review/shared' })
  const abort = new AbortController()
  const preparation = ctx.ticketExecution.prepare(worker, { ...request(root, ticket, 'directory-abort'), signal: abort.signal }).catch((error: unknown) => error)
  await entered.promise
  abort.abort(new Error('directory resolution cancelled'))
  release.resolve(undefined)
  expect(await preparation).toMatchObject({ message: 'directory resolution cancelled' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts).toEqual([])
})

it('uses the technical root for isolated external execution and preserves the Assignment revision', async () => {
  const { ctx, root, ticket } = await external()
  ctx.subagents.registerProvider({ name: 'isolated-external', execution: { kind: 'dedicated-process' }, capabilities, inheritsParentContext: false,
    async start() { return { id: SessionId('isolated-external-child'), result: Promise.resolve({ output: [], stopReason: 'completed' }), async dispose() {} } },
  })
  const handle = await ctx.ticketExecution.prepare(root, { ...request(root, ticket, 'isolated-external'), assignmentRevision: ticket.assignments[0]!.revision, workspace: { kind: 'isolated-worktree', directory: '/review/shared' }, executor: { kind: 'dedicated-process', provider: 'isolated-external' } })
  expect(handle.workspace.directory).toBe('/review/isolated')
  await handle.settle()
  await expect(handle.startJob('after settlement', () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' }) }))).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
})

it('cancels a Job signal aborted inside producer startup and forwards an absent cancellation reason', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'startup-signal-root')
  const { agent: worker } = await live(ctx, 'startup-signal-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'startup-signal'))
  const done = Promise.withResolvers<JobOutcome>()
  const abort = new AbortController()
  let cancellations = 0
  await handle.startJob('startup abort', (job) => {
    ctx.jobs.kill(job.id, worker.id)
    abort.abort(new Error('cancel at startup'))
    return { cancel() { cancellations++; done.resolve({ status: 'killed' }) }, done: done.promise }
  }, abort.signal)
  await handle.settle()
  expect(cancellations).toBeGreaterThan(0)
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled' })
})

it('fails closed when Job registration omits its producer callback', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'missing-job-callback-root')
  const { agent: worker } = await live(ctx, 'missing-job-callback-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'missing-job-callback'))
  vi.spyOn(ctx.jobs, 'start').mockReturnValueOnce(JobId('missing-producer-handle'))
  let started = false
  await expect(handle.startJob('missing callback', () => { started = true; return { cancel() {}, done: Promise.resolve({ status: 'completed' }) } })).rejects.toMatchObject({ code: 'TICKET_RECOVERY_FAILED' })
  expect(started).toBe(false)
  await handle.settle()
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
})

it('refuses a Job when the recovered running attempt has no runtime receipt', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'missing-runtime-root')
  const { agent: worker } = await live(ctx, 'missing-runtime-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'missing-runtime'))
  const { runtimeReceipt: _receipt, ...withoutReceipt } = handle.attempt
  const current = ctx.tickets.get(root.session, ticket.id)
  const get = vi.spyOn(ctx.tickets, 'get').mockReturnValueOnce(current).mockReturnValueOnce({ ...current, attempts: [withoutReceipt] })
  let started = false
  await expect(handle.startJob('missing receipt', () => { started = true; return { cancel() {}, done: Promise.resolve({ status: 'completed' }) } })).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  get.mockRestore()
  expect(started).toBe(false)
  await handle.settle()
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
})

it.each([false, true])('contains an undefined activation failure with cancellation=%s', async (cancelled) => {
  const { ctx, root, ticket } = await external()
  ctx.subagents.registerProvider({ name: 'undefined-failure', execution: { kind: 'dedicated-process' }, capabilities, inheritsParentContext: false,
    async start(): Promise<never> { throw new Error('must be intercepted') },
  })
  const abort = new AbortController()
  vi.spyOn(ctx.subagents, 'startActivation').mockImplementationOnce(async () => {
    if (cancelled) abort.abort(new Error('activation cancelled'))
    throw undefined
  })
  const error = await ctx.ticketExecution.prepare(root, { ...request(root, ticket, 'undefined-failure'), executor: { kind: 'dedicated-process', provider: 'undefined-failure' }, signal: abort.signal }).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ message: cancelled ? 'activation cancelled' : 'Ticket execution preparation was cancelled' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: cancelled ? 'cancelled' : 'failed' })
})

it('joins an uncertainty write already pending from a failed cancellation request', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'repeat-unknown-root')
  const { agent: worker } = await live(ctx, 'repeat-unknown-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'repeat-unknown'))
  const done = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'killed' }) })
  await handle.startJob('refuses cancellation', () => ({ cancel() { throw new Error('cancel refused') }, done: done.promise }))
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flushed = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (ctx.tickets.get(root.session, ticket.id).attempts[0]?.status === 'unknown') {
      entered.resolve(undefined)
      await release.promise
      const result = await flush(session)
      flushed.resolve(undefined)
      return result
    }
    return flush(session)
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const failure = (error: unknown) => error
  try {
    const first = handle.dispose().catch(failure)
    await entered.promise
    await vi.advanceTimersByTimeAsync(2000)
    expect(await first).toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
    const repeated = handle.dispose().catch(failure)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await repeated).toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  } finally {
    release.resolve(undefined)
    vi.useRealTimers()
    done.resolve({ status: 'killed' })
  }
  await flushed.promise
  await handle.settle()
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]!.status).toBe('settled')
})

it('requires the technical root to remain registered between admission and workspace preparation', async () => {
  const { ctx } = await harness()
  const root = await live(ctx, 'unpublished-root')
  root.detachAgent()
  const detach = ctx.agents.enter(root.agent, undefined)
  onTestFinished(detach)
  const { agent: worker } = await live(ctx, 'unpublished-root-worker')
  const ticket = await assigned(ctx, root.agent, worker)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => { entered.resolve(undefined); await release.promise; return flush(session) })
  const preparation = ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'unpublished-root')).catch((error: unknown) => error)
  await entered.promise
  detach()
  release.resolve(undefined)
  expect(await preparation).toMatchObject({ code: 'TICKET_AUTHORITY' })
  expect(ctx.tickets.get(root.agent.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
})

it('refuses to publish when the post-runtime projection loses the committed attempt', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'lost-attempt-root')
  const { agent: worker } = await live(ctx, 'lost-attempt-worker')
  const ticket = await assigned(ctx, root, worker)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    const current = ctx.tickets.get(root.session, ticket.id)
    const result = await flush(session)
    if (current.attempts[0]?.runtimeReceipt !== undefined && current.attempts[0].status === 'running') {
      vi.spyOn(ctx.tickets, 'get').mockReturnValueOnce(ticket)
    }
    return result
  })
  await expect(ctx.ticketExecution.prepare(worker, request(root, ticket, 'lost-attempt'))).rejects.toMatchObject({ code: 'TICKET_RECOVERY_FAILED' })
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
})

it.each(['cleanup', 'settlement'] as const)('reports a failed activation %s after cancellation before publication', async (failure) => {
  const { ctx, root, ticket } = await external()
  const result = Promise.withResolvers<SubagentResult>()
  ctx.subagents.registerProvider({ name: 'failed-release', execution: { kind: 'dedicated-process' }, capabilities, inheritsParentContext: false,
    async start() { return { id: SessionId('failed-release-child'), result: result.promise,
      async dispose() { result.resolve({ output: [], stopReason: 'aborted' }); if (failure === 'cleanup') throw new Error('activation cleanup failed') },
    } },
  })
  const abort = new AbortController()
  const activate = ctx.subagents.startActivation.bind(ctx.subagents)
  vi.spyOn(ctx.subagents, 'startActivation').mockImplementation(async (spec) => { const activation = await activate(spec); abort.abort(new Error('publication cancelled')); return activation })
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (failure === 'settlement' && ctx.tickets.get(root.session, ticket.id).attempts[0]?.status === 'settled') throw new Error('settlement storage failed')
    return flush(session)
  })
  const error = await ctx.ticketExecution.prepare(root, { ...request(root, ticket, 'failed-release'), executor: { kind: 'dedicated-process', provider: 'failed-release' }, signal: abort.signal }).catch((caught: unknown) => caught)
  spy.mockRestore()
  expect(error).toBeInstanceOf(AggregateError)
  if (!(error instanceof AggregateError)) throw new Error('expected activation failure')
  expect(error.message).toContain(failure === 'cleanup' ? 'preparation is unknown' : 'after stopping its activation')
  expect(ctx.tickets.get(root.session, ticket.id).attempts[0]!.status).toBe(failure === 'cleanup' ? 'unknown' : 'settled')
})

it('does not cancel a completed producer while cancelling another producer', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'finished-producer-root')
  const { agent: worker } = await live(ctx, 'finished-producer-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'finished-producer'))
  let completedCancels = 0
  const completed = await handle.startJob('completed', () => ({ cancel() { completedCancels++ }, done: Promise.resolve({ status: 'completed' }) }))
  await ctx.jobs.wait(completed, 1000, worker.id)
  const done = Promise.withResolvers<JobOutcome>()
  await handle.startJob('pending', () => ({ cancel() { done.resolve({ status: 'killed' }) }, done: done.promise }))
  await handle.dispose()
  expect(completedCancels).toBe(0)
})

it('detaches a reconciled attempt signal while its producer completion notification is delayed', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'reconciled-listener-root')
  const { agent: worker } = await live(ctx, 'reconciled-listener-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'reconciled-listener'))
  const signal = new AbortController()
  const notification = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { notification.resolve({ status: 'killed' }) })
  let requests = 0
  const job = await handle.startJob('delayed notification', () => ({ cancel() { requests++; throw new Error('stop not confirmed') }, done: notification.promise }), signal.signal)
  await expect(handle.dispose()).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  const current = ctx.tickets.get(root.session, ticket.id)
  await ctx.agents.withInitiator(root, () => ctx.tickets.settleAttempt(root.session, {
    ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, attemptId: handle.attempt.id,
    operationId: TicketOperationId('reconciled-by-host'), outcome: 'cancelled',
  }))
  const reconciled = ctx.tickets.get(root.session, ticket.id)
  const replacement = await ctx.ticketExecution.prepare(worker, request(root, reconciled, 'replacement-listener'))
  const before = requests
  signal.abort(new Error('stale signal'))
  expect(requests).toBe(before)
  notification.resolve({ status: 'killed' })
  await ctx.jobs.wait(job, 1000, worker.id)
  await replacement.dispose()
})
