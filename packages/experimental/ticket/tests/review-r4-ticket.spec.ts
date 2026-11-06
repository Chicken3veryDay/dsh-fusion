/** Round-4 regressions for Ticket execution settlement ownership; each failed before the settlement ledger existed. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import TicketService, { TicketAttemptId, TicketOperationId, TicketExecutionService } from '../src/index.ts'
import type { TicketView, WorkScope } from '../src/types.ts'

class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create(): Promise<never> { throw new Error('unexpected worktree') }
}
class Directories extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  get() { return '/review/shared' }
  async ensure() { return '/review/shared' }
  async set(_worker: Agent, path: string) { return path }
}
class Subagents extends Service {
  constructor(ctx: Context) { super(ctx, 'subagents') }
  getProvider() { return undefined }
  async startActivation(): Promise<never> { throw new Error('unexpected activation') }
}

function agentFor(ctx: Context, session: Session): Agent {
  return { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
}

async function harness() {
  const ctx = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService, {})
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('review-r4')
  await ctx.plugin(Worktrees)
  await ctx.plugin(Directories)
  await ctx.plugin(Subagents)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 200 })
  return ctx
}

async function live(ctx: Context, id: string, seed?: Session): Promise<Agent> {
  const session = ctx.sessions.create(SessionId(id), seed === undefined ? undefined : { seed: seed.snapshotEvents() })
  const created = agentFor(ctx, session)
  await ctx.agents.register(created)
  return created
}

/** A root whose Agent and Session detach in the agent factory's order: `detachAgent(); detachSession()` in one step. */
async function factoryRoot(ctx: Context, id: string) {
  const session = ctx.sessions.prepare(SessionId(id))
  const detachSession = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const root = agentFor(ctx, session)
  const detachAgent = ctx.agents.enter(root, undefined)
  await ctx.agents.announce(root, 'startup')
  return { root, close: () => { detachAgent(); detachSession() } }
}

async function assigned(ctx: Context, root: Agent, worker: Agent, workScopes: WorkScope[]): Promise<TicketView> {
  const ticket = await ctx.agents.withInitiator(root, () =>
    ctx.tickets.create(root.session, { subject: 'Review repro', description: '' }))
  return ctx.agents.withInitiator(root, () => ctx.tickets.assign(root.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id, ownerId: worker.id, subject: 'Contribute', workScopes,
  }))
}

function prepare(ctx: Context, caller: Agent, root: Agent, ticket: TicketView, suffix = '0') {
  return ctx.ticketExecution.prepare(caller, { rootSessionId: root.id, ticketId: ticket.id,
    assignmentId: ticket.assignments[0]!.id, expectedRevision: ticket.revision,
    attemptId: TicketAttemptId(`attempt-${suffix}`), operationId: TicketOperationId(`prepare-${suffix}`),
    workspace: { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) },
    executor: { kind: 'in-process' } })
}

/** A producer that settles promptly when cancelled. */
function cancellableProducer() {
  const done = Promise.withResolvers<JobOutcome>()
  const state = { cancelled: false }
  return { state, run: () => ({ cancel() { state.cancelled = true; done.resolve({ status: 'killed' }) }, done: done.promise }) }
}

function code(error: unknown): string {
  if (error instanceof AggregateError) return `AggregateError(${error.errors.map(code).join(',')})`
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error)
}

async function admitted(ctx: Context, caller: Agent, root: Agent, ticket: TicketView, suffix: string): Promise<string> {
  return prepare(ctx, caller, root, ticket, suffix).then(async (handle) => { await handle.dispose(); return 'admitted' }, code)
}

const exclusive: WorkScope[] = [{ path: 'src/file.ts', access: 'write', exclusive: true }]

describe('R4 Ticket review reproductions', () => {
  it('R4-1 closing the technical root records the settlement of its cooperatively cancelled producer', async () => {
    const ctx = await harness()
    const worker = await live(ctx, 'r4-worker')
    const { root, close } = await factoryRoot(ctx, 'r4-root')
    const held = await assigned(ctx, root, worker, exclusive)
    const handle = await prepare(ctx, worker, root, held)
    const producer = cancellableProducer()
    await handle.startJob('write src/file.ts', producer.run)
    const before = root.session
    // Agent factory teardown order (agent-loop/src/index.ts:557-558): agent/disposed, then Session removal, synchronously.
    close()
    await vi.waitFor(() => { expect(producer.state.cancelled).toBe(true) })
    // The producer outcome is known, but the closed root cannot persist it: disposal reports a retryable pending settlement.
    const explicitDispose = await handle.dispose().then(() => 'settled', code)
    // Resume the root from its log, as a restart or reopen does.
    const resumed = await live(ctx, 'r4-root', before)
    const afterResume = await handle.dispose().then(() => 'settled', code)
    const attempt = ctx.tickets.get(resumed.session, held.id).attempts[0]?.status
    const current = ctx.tickets.get(resumed.session, held.id)
    const cancel = await ctx.agents.withInitiator(resumed, () => ctx.tickets.cancel(resumed.session, {
      ticketId: held.id, expectedRevision: current.revision, actorId: resumed.id, summary: 'Root closed',
    })).then(view => view.status, code)
    const otherRoot = await live(ctx, 'r4-other-root')
    const otherWorker = await live(ctx, 'r4-other-worker')
    const competing = await admitted(ctx, otherWorker, otherRoot, await assigned(ctx, otherRoot, otherWorker, exclusive), 'competing')
    // The producer was cancelled and settled, so the durable attempt is settled and nothing stays reserved.
    expect({ producerCancelled: producer.state.cancelled, explicitDispose, afterResume, attempt, cancel, competing }).toEqual({
      producerCancelled: true, explicitDispose: 'TICKET_SETTLEMENT_PENDING', afterResume: 'settled', attempt: 'settled', cancel: 'cancelled', competing: 'admitted',
    })
    expect(ctx.tickets.get(resumed.session, held.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled' })
    // Nothing remains for TicketExecution or Ticket teardown to report.
    await expect(Promise.resolve(ctx.fiber.dispose()).then(() => 'disposed', code)).resolves.toBe('disposed')
  })

  it('R4-2 a failed admission flush does not leave an unsettleable attempt that no producer ever ran', async () => {
    const ctx = await harness()
    const root = await live(ctx, 'r4-flush-root')
    const worker = await live(ctx, 'r4-flush-worker')
    const ticket = await assigned(ctx, root, worker, exclusive)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
    const first = await prepare(ctx, worker, root, ticket).then(() => 'admitted', code)
    flush.mockRestore()
    // Storage recovered: the caller retries the identical preparation.
    const retry = await prepare(ctx, worker, root, ticket).then(async (handle) => { await handle.dispose(); return 'settled' }, code)
    const current = ctx.tickets.get(root.session, ticket.id)
    const cancel = await ctx.agents.withInitiator(root, () => ctx.tickets.cancel(root.session, {
      ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, summary: 'Storage failed',
    })).then(view => view.status, code)
    const otherRoot = await live(ctx, 'r4-flush-other-root')
    const otherWorker = await live(ctx, 'r4-flush-other-worker')
    const competing = await admitted(ctx, otherWorker, otherRoot, await assigned(ctx, otherRoot, otherWorker, exclusive), 'competing')
    expect(first).toBe('Error: disk unavailable')
    // No producer, Job or activation ever existed: either the retry completes admission or the attempt is settled, never stranded.
    expect({ retry, attempt: current.attempts[0]?.status, cancel, competing })
      .toEqual({ retry: 'settled', attempt: 'settled', cancel: 'cancelled', competing: 'admitted' })
  })

  it('R4-m1 (minor) retrying a manual attempt update after its attempt settled returns the recorded Ticket', async () => {
    const ctx = await harness()
    const root = await live(ctx, 'r4-manual-root')
    const worker = await live(ctx, 'r4-manual-worker')
    const ticket = await assigned(ctx, root, worker, [])
    const base = { ticketId: ticket.id, actorId: worker.id, attemptId: TicketAttemptId('manual') }
    const run = <T>(operation: () => Promise<T>) => ctx.agents.withInitiator(worker, operation)
    const revision = () => ctx.tickets.get(root.session, ticket.id).revision
    await run(() => ctx.tickets.beginAttempt(root.session, { ...base, expectedRevision: ticket.revision,
      assignmentId: ticket.assignments[0]!.id, operationId: TicketOperationId('manual-begin'),
      workspace: { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) }, executor: { kind: 'in-process' } }))
    const update = { ...base, operationId: TicketOperationId('manual-update'), status: 'running' as const }
    await run(() => ctx.tickets.updateAttempt(root.session, { ...update, expectedRevision: revision() }))
    await run(() => ctx.tickets.settleAttempt(root.session, { ...base, expectedRevision: revision(),
      operationId: TicketOperationId('manual-settle'), outcome: 'succeeded' }))
    // The update's response was lost; the caller retries the identical operation, as the JSDoc permits.
    const retry = await run(() => ctx.tickets.updateAttempt(root.session, { ...update, expectedRevision: revision() }))
      .then(() => 'recorded', code)
    expect(retry).toBe('recorded')
  })
})
