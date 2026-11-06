import { ticketActor } from './ticket-actor.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import TicketService, { TicketAttemptId, TicketCandidateId, TicketOperationId, TicketExecutionService, TicketTools } from '../src/index.ts'
import type { TicketView } from '../src/types.ts'

class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create(worker: Agent) {
    await this.ctx.workingDirectory.set(worker, '/review/isolated')
    return { path: '/review/isolated', baseCommit: 'a'.repeat(40), branch: 'review', repositoryRoot: '/review/shared' }
  }
}
class Directories extends Service {
  private readonly paths = new Map<SessionId, string>()
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  get(session: Agent['session']) { return this.paths.get(session.id) ?? '/review/shared' }
  async ensure(worker: Agent) { return this.get(worker.session) }
  async set(worker: Agent, path: string) { this.paths.set(worker.id, path); return path }
}
class Subagents extends Service {
  constructor(ctx: Context) { super(ctx, 'subagents') }
  getProvider() { return undefined }
  async startActivation(): Promise<never> { throw new Error('unexpected activation') }
}
function agent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
}
async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(TicketTools)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('review-r1')
  await ctx.plugin(Worktrees)
  await ctx.plugin(Directories)
  await ctx.plugin(Subagents)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  const root = agent(ctx, 'review-root')
  const worker = agent(ctx, 'review-worker')
  await ctx.agents.register(root)
  await ctx.agents.register(worker)
  return { ctx, root, worker }
}
async function assigned(ctx: Context, root: Agent, worker: Agent) {
  let ticket = await ticketActor(ctx, (root.session).id, () =>
    ctx.tickets.create(root.session, { subject: 'Review repro', description: '' }))
  ticket = await ticketActor(ctx, root.id, () => ctx.tickets.assign(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
    actorId: root.id, ownerId: worker.id, subject: 'Contribute' }))
  return ticket
}
async function prepare(ctx: Context, root: Agent, worker: Agent, ticket: TicketView, index = 0, isolated = false) {
  return ctx.ticketExecution.prepare(worker, { rootSessionId: root.id, ticketId: ticket.id,
    assignmentId: ticket.assignments[index]!.id, expectedRevision: ticket.revision,
    attemptId: TicketAttemptId(`attempt-${index}`), operationId: TicketOperationId(`prepare-${index}`),
    workspace: { kind: isolated ? 'isolated-worktree' : 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) },
    executor: { kind: 'in-process' } })
}
async function call(ctx: Context, name: string, args: Record<string, unknown>, caller: Agent) {
  const exec = { agent: caller, signal: new AbortController().signal } as ToolRunContext
  return ctx.tools.get(name)!.execute(args, exec)
}

describe('R1 Ticket review reproductions', () => {
  it('R1 supplied actor cannot impersonate the coordinator through the service API', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const mutation = ctx.agents.withInitiator(worker, () => ticketActor(ctx, root.id, () => ctx.tickets.revise(root.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id, acceptanceCriteria: [], dependencies: [],
    })))
    await expect(mutation).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  })

  it('R1 requires a live initiator even when the actor id has coordinator authority', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const request = { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id,
      acceptanceCriteria: [], dependencies: [] }
    await expect(ctx.tickets.revise(root.session, request)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
    await expect(ctx.agents.withInitiator({ ...root }, () => ctx.tickets.revise(root.session, request)))
      .rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
    expect(ctx.tickets.get(root.session, ticket.id)).toEqual(ticket)
  })

  it('R2 persists job identities in the owning attempt receipt', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, root, worker, ticket)
    const done = Promise.withResolvers<JobOutcome>()
    const observed: boolean[] = []
    const run = () => {
      observed.push((ctx.tickets.get(root.session, ticket.id).attempts[0]!.runtimeReceipt?.jobIds?.length ?? 0) > 0)
      return { cancel() { done.resolve({ status: 'killed' }) }, done: done.promise }
    }
    const id = await handle.startJob('retained job', run)
    const secondId = await handle.startJob('second retained job', run)
    const receipt = ctx.tickets.get(root.session, ticket.id).attempts[0]!.runtimeReceipt
    await handle.dispose()
    expect(receipt?.jobIds).toEqual([id, secondId])
    expect(observed).toEqual([true, true])
  })

  it('R3 a killed producer cannot settle an attempt as succeeded', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, root, worker, ticket)
    const id = await handle.startJob('cancelled operation', () => ({ cancel() {}, done: Promise.resolve({ status: 'killed' }) }))
    await ctx.jobs.wait(id, 1000, worker.id)
    await handle.settle()
    expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled' })
  })

  it('R4 separate assignments can start jobs concurrently without internal stale CAS', async () => {
    const { ctx, root, worker } = await harness()
    const other = agent(ctx, 'review-worker-2')
    await ctx.agents.register(other)
    let ticket = await assigned(ctx, root, worker)
    ticket = await ticketActor(ctx, root.id, () =>
      ctx.tickets.assign(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
        actorId: root.id, ownerId: other.id, subject: 'Independent contribution' }))
    const first = await prepare(ctx, root, worker, ticket)
    const second = await prepare(ctx, root, other, ctx.tickets.get(root.session, ticket.id), 1)
    const gate = Promise.withResolvers<undefined>()
    const hooks = () => ({ cancel() {}, done: Promise.resolve<JobOutcome>({ status: 'completed' }) })
    const operations = [first, second].map(async (handle) => { await gate.promise; return handle.startJob('independent job', hooks) })
    gate.resolve(undefined)
    const results = await Promise.allSettled(operations)
    await Promise.all([first.dispose(), second.dispose()])
    expect(results.filter(result => result.status === 'rejected')).toEqual([])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
  })

  it('R5 criteria edits allow a completed contributor to provide a new result through model tools', async () => {
    const { ctx, root, worker } = await harness()
    let ticket = await assigned(ctx, root, worker)
    ticket = await ticketActor(ctx, worker.id, () =>
      ctx.tickets.report(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
        actorId: worker.id, assignmentId: ticket.assignments[0]!.id, kind: 'result', summary: 'Original result' }))
    ticket = await ticketActor(ctx, root.id, () =>
      ctx.tickets.revise(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
        actorId: root.id, acceptanceCriteria: [], dependencies: [] }))
    await expect(call(ctx, 'ticket_report', { root_session_id: root.id, ticket_id: ticket.id,
      assignment_id: ticket.assignments[0]!.id, expected_revision: ticket.revision,
      kind: 'result', summary: 'Updated result for revised specification' }, worker)).resolves.toBeDefined()
  })

  it('R8 an unfinished legacy v1 ticket can pin its completed result on first v2 write', async () => {
    const { ctx, root, worker } = await harness()
    let source = await assigned(ctx, root, worker)
    source = await ticketActor(ctx, worker.id, () =>
      ctx.tickets.report(root.session, { ticketId: source.id, expectedRevision: source.revision,
        actorId: worker.id, assignmentId: source.assignments[0]!.id, kind: 'result', summary: 'Historical result' }))
    const session = ctx.sessions.create(SessionId('legacy-v1-root'))
    const {
      specification: _specification, attempts: _attempts, candidates: _candidates, checks: _checks,
      operations: _operations, missionPlans: _missionPlans, ...legacy
    } = source
    session.append('ticket/state', { version: 1, sessionId: session.id, ticket: {
      ...legacy, revision: 1, coordinatorId: root.id,
      assignments: legacy.assignments.map(({ contribution: _contribution, ...assignment }) => assignment),
      reports: legacy.reports.map(({ specRevision: _specRevision, ...report }) => report),
    } })
    const restored = ctx.tickets.get(session, source.id)
    expect(restored.assignments[0]!.status).toBe('completed')
    await expect(ticketActor(ctx, root.id, () =>
      ctx.tickets.submitCandidate(session, { ticketId: restored.id, expectedRevision: restored.revision,
        actorId: root.id, candidateId: TicketCandidateId('legacy-candidate'), specRevision: 1,
        content: { kind: 'commit', repository: 'origin', commit: 'a'.repeat(40) }, assignmentIds: [restored.assignments[0]!.id] })))
      .resolves.toBeDefined()
  })

  it('R6 legacy claim cannot reuse a settled attempt for a new execution interval', async () => {
    const { ctx, root, worker } = await harness()
    let ticket = await assigned(ctx, root, worker)
    const assignmentId = ticket.assignments[0]!.id
    const attemptId = TicketAttemptId('old-attempt')
    ticket = await ticketActor(ctx, worker.id, () =>
      ctx.tickets.beginAttempt(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
        actorId: worker.id, assignmentId, attemptId, operationId: TicketOperationId('old-begin'),
        workspace: { kind: 'shared-workspace', directory: '/review/shared' }, executor: { kind: 'in-process' } }))
    ticket = await ticketActor(ctx, worker.id, () =>
      ctx.tickets.settleAttempt(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
        actorId: worker.id, attemptId, operationId: TicketOperationId('old-settle'), outcome: 'succeeded' }))
    ticket = await ticketActor(ctx, worker.id, () =>
      ctx.tickets.release(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
        actorId: worker.id, assignmentId }))
    await expect(ticketActor(ctx, worker.id, () => ctx.tickets.claim(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
      actorId: worker.id, assignmentId }))).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
    ticket = await ticketActor(ctx, worker.id, () =>
      ctx.tickets.beginAttempt(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
        actorId: worker.id, assignmentId, attemptId: TicketAttemptId('fresh-attempt'), operationId: TicketOperationId('fresh-begin'),
        workspace: { kind: 'shared-workspace', directory: '/review/shared' }, executor: { kind: 'in-process' } }))
    await expect(ticketActor(ctx, worker.id, () =>
      ctx.tickets.report(root.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
        actorId: worker.id, assignmentId, attemptId, kind: 'result', summary: 'Late result from old interval' })))
      .rejects.toMatchObject({ code: 'TICKET_STALE_ATTEMPT' })
  })

  it('R7 unresolved exclusive write work excludes a second overlapping attempt', async () => {
    const { ctx, root, worker } = await harness()
    const other = agent(ctx, 'review-worker-2')
    await ctx.agents.register(other)
    let ticket = await ticketActor(ctx, (root.session).id, () =>
      ctx.tickets.create(root.session, { subject: 'Exclusive scope', description: '',
        workScopes: [{ path: 'src', access: 'write', exclusive: true }] }))
    for (const owner of [worker, other]) ticket = await ticketActor(ctx, root.id, () => ctx.tickets.assign(root.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id, ownerId: owner.id,
      subject: 'Mutate shared file', workScopes: [{ path: 'src/file.ts', access: 'write', exclusive: true }],
    }))
    const first = await prepare(ctx, root, worker, ticket)
    const next = prepare(ctx, root, other, ctx.tickets.get(root.session, ticket.id), 1)
    const result = await Promise.allSettled([next])
    await first.dispose()
    if (result[0].status === 'fulfilled') await result[0].value.dispose()
    expect(result[0].status).toBe('rejected')
    if (result[0].status === 'rejected') expect(result[0].reason).toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
    const admitted = await prepare(ctx, root, other, ctx.tickets.get(root.session, ticket.id), 1)
    await admitted.dispose()
  })
  it('M1 execution and model input refusals have typed codes', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    await expect(prepare(ctx, root, worker, { ...ticket, revision: ticket.revision - 1 }))
      .rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
    await expect(call(ctx, 'ticket_create', { subject: 'Invalid scope', description: '',
      work_scopes: [{ path: 42, access: 'write' }] }, root))
      .rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  })
  it('R9 caller cancellation remains attached while its job is still running', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, root, worker, ticket)
    const control = new AbortController()
    const done = Promise.withResolvers<JobOutcome>()
    let cancelled = false
    vi.useFakeTimers()
    let afterAbort = false
    try {
      await handle.startJob('long-running producer', () => ({
        cancel() { cancelled = true; done.resolve({ status: 'killed' }) }, done: done.promise,
      }), control.signal)
      await vi.advanceTimersByTimeAsync(1001)
      control.abort()
      afterAbort = cancelled
    } finally {
      vi.useRealTimers()
      await handle.dispose()
    }
    expect(afterAbort).toBe(true)
  })

})
