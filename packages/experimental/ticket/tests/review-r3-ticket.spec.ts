/** Round-3 review reproductions for Ticket execution, admission and persistence; each test states intended behavior. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { createUserMessage } from '../../../llm/llm/src/index.ts'
import { imageOffloadProjection } from '../../../compaction/compaction-image-offload/src/projection.ts'
import { validateTicketChange } from '../src/projection.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import TicketService, { TicketAttemptId, TicketOperationId, TicketExecutionService, TicketError } from '../src/index.ts'
import type { TicketView, WorkScope } from '../src/types.ts'

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

function agent(ctx: Context, id: string, options?: Parameters<Context['sessions']['create']>[1]): Agent {
  const session = ctx.sessions.create(SessionId(id), options)
  return { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
}

async function harness(settlementTimeoutMs = 1000, beforeTicket?: (ctx: Context) => Promise<void>) {
  const ctx = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await beforeTicket?.(ctx)
  await ctx.plugin(TicketService, {})
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('review-r3')
  await ctx.plugin(Worktrees)
  await ctx.plugin(Directories)
  await ctx.plugin(Subagents)
  const executionFiber = ctx.plugin(TicketExecutionService, { settlementTimeoutMs })
  await executionFiber
  const root = await live(ctx, 'r3-root')
  const worker = await live(ctx, 'r3-worker')
  return { ctx, root, worker, executionFiber }
}

async function live(ctx: Context, id: string): Promise<Agent> {
  const created = agent(ctx, id)
  await ctx.agents.register(created)
  return created
}

/** A child fiber owning one Agent and its Session, so disposing the fiber closes both. */
async function transient(ctx: Context, id: string) {
  let scope: Context | undefined
  const fiber = ctx.plugin({ name: `r3-scope-${id}`, inject: ['agents', 'sessions'], apply: (child: Context) => { scope = child } })
  await fiber
  const created = { ...agent(scope!, id), ctx: scope! }
  await scope!.agents.register(created)
  return { agent: created, fiber }
}

async function assigned(ctx: Context, root: Agent, worker: Agent, workScopes?: WorkScope[]): Promise<TicketView> {
  const ticket = await ctx.agents.withInitiator(root, () =>
    ctx.tickets.create(root.session, { subject: 'Review repro', description: '' }))
  return ctx.agents.withInitiator(root, () => ctx.tickets.assign(root.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id, ownerId: worker.id, subject: 'Contribute',
    ...workScopes === undefined ? {} : { workScopes },
  }))
}

function prepare(ctx: Context, caller: Agent, root: Agent, ticket: TicketView, suffix = '0', signal?: AbortSignal) {
  return ctx.ticketExecution.prepare(caller, { rootSessionId: root.id, ticketId: ticket.id,
    assignmentId: ticket.assignments[0]!.id, expectedRevision: ticket.revision,
    attemptId: TicketAttemptId(`attempt-${suffix}`), operationId: TicketOperationId(`prepare-${suffix}`),
    workspace: { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) },
    executor: { kind: 'in-process' }, ...signal === undefined ? {} : { signal } })
}

/** A producer that settles on cancellation and records whether cancellation reached it. */
function cancellableProducer() {
  const done = Promise.withResolvers<JobOutcome>()
  const state = { cancelled: false }
  return {
    state, finish: () => { done.resolve({ status: 'completed' }) },
    run: () => ({ cancel() { state.cancelled = true; done.resolve({ status: 'killed' }) }, done: done.promise }),
  }
}

/** A producer that observes cancellation but keeps running until the test finishes it. */
function stubbornProducer() {
  const done = Promise.withResolvers<JobOutcome>()
  const state = { cancelled: false, finished: false }
  return {
    state, finish: () => { state.finished = true; done.resolve({ status: 'completed' }) },
    run: () => ({ cancel() { state.cancelled = true }, done: done.promise }),
  }
}

function code(error: unknown): string {
  if (error instanceof AggregateError) return `AggregateError(${error.errors.map(code).join(',')})`
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error)
}

const exclusive: WorkScope[] = [{ path: 'src/file.ts', access: 'write', exclusive: true }]

describe('Ticket execution recovery regressions', () => {
  it('R3-1 disposal retries a naturally settled outcome after its flush failed', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValue(new Error('disk unavailable'))
    await expect(handle.settle()).rejects.toThrow('disk unavailable')
    expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'succeeded' })
    await expect(handle.dispose()).rejects.toThrow('disk unavailable')
    flush.mockRestore()
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'succeeded' })
  })

  it('R3-2 shutdown during admission settles cancellation before any producer starts', async () => {
    const { ctx, root, worker, executionFiber } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let first = true
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (first) { first = false; entered.resolve(undefined); await release.promise }
      return flush(session)
    })
    const preparing = prepare(ctx, worker, root, ticket).catch(code)
    await entered.promise
    const shutdown = executionFiber.dispose()
    release.resolve(undefined)
    expect(await preparing).not.toBe('admitted')
    await shutdown
    const current = ctx.tickets.get(root.session, ticket.id)
    expect(current.attempts).toMatchObject([{ status: 'settled', outcome: 'cancelled' }])
    await expect(ctx.agents.withInitiator(root, () => ctx.tickets.cancel(root.session, {
      ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, summary: 'Shutdown',
    }))).resolves.toHaveProperty('status', 'cancelled')
  })

  it.each(['begin', 'update', 'settle'] as const)('R3-1 manual %s retries flush appended state before success', async (stage) => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const begin = { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: worker.id,
      assignmentId: ticket.assignments[0]!.id, attemptId: TicketAttemptId('manual'), operationId: TicketOperationId('manual-begin'),
      workspace: { kind: 'shared-workspace' as const, directory: '/review/shared', baseCommit: 'a'.repeat(40) },
      executor: { kind: 'in-process' as const } }
    if (stage !== 'begin') await ctx.agents.withInitiator(worker, () => ctx.tickets.beginAttempt(root.session, begin))
    const request = { ...begin, expectedRevision: ctx.tickets.get(root.session, ticket.id).revision,
      operationId: TicketOperationId('manual-' + stage), status: 'running' as const, outcome: 'cancelled' as const }
    const operation = () => ctx.agents.withInitiator(worker, () => stage === 'begin'
      ? ctx.tickets.beginAttempt(root.session, begin) : stage === 'update'
        ? ctx.tickets.updateAttempt(root.session, request) : ctx.tickets.settleAttempt(root.session, request))
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValue(new Error('disk unavailable'))
    await expect(operation()).rejects.toThrow('disk unavailable')
    flush.mockClear()
    const retry = await operation().then(() => 'success', () => 'storage failure')
    const retryFlushes = flush.mock.calls.length
    flush.mockRestore()
    await operation()
    expect({ retry, retryFlushes }).toEqual({ retry: 'storage failure', retryFlushes: 1 })
  })

  it.each([false, true])('R3-3 recovers unloaded root reservations with required message projections: %s', async (projected) => {
    const source = await harness(1000, async (ctx) => {
      if (projected) ctx.sessions.registerMessageProjection(imageOffloadProjection)
    })
    const storedRoot = await live(source.ctx, 'unloaded-root')
    if (projected) {
      const image = storedRoot.session.append('user/message', createUserMessage({
        content: [{ type: 'image', attachment: {
          attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
        } }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      storedRoot.session.append('image/offload', { targets: [{ seq: image.seq, imageIndexes: [0] }] })
    }
    const held = await assigned(source.ctx, storedRoot, source.worker, exclusive)
    await source.ctx.agents.withInitiator(source.worker, () => source.ctx.tickets.beginAttempt(storedRoot.session, {
      ticketId: held.id, expectedRevision: held.revision, actorId: source.worker.id,
      assignmentId: held.assignments[0]!.id, attemptId: TicketAttemptId('unloaded'), operationId: TicketOperationId('unloaded-begin'),
      workspace: { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) }, executor: { kind: 'in-process' },
    }))
    const dir = await mkdtemp(join(tmpdir(), 'ticket-unloaded-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const recovered = await harness(1000, async (ctx) => {
      await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
      if (projected) ctx.sessions.registerMessageProjection(imageOffloadProjection)
      await using writer = await ctx.sessionPersistence.create(storedRoot.session.header)
      await writer.append(storedRoot.session.snapshotEvents())
      await writer.flush()
    })
    const ticket = await assigned(recovered.ctx, recovered.root, recovered.worker, exclusive)
    const admission = await prepare(recovered.ctx, recovered.worker, recovered.root, ticket).then(async (handle) => {
      await handle.dispose(); return 'admitted'
    }, code)
    expect(admission).toBe('TICKET_ATTEMPT_STATE')
  })

  it('R3-4 retains a failed root’s known scopes and reports the failure against that root only', async () => {
    const { ctx, root, worker } = await harness()
    const other = await live(ctx, 'broken-owner')
    const held = await assigned(ctx, other, worker, exclusive)
    await ctx.agents.withInitiator(worker, () => ctx.tickets.beginAttempt(other.session, {
      ticketId: held.id, expectedRevision: held.revision, actorId: worker.id,
      assignmentId: held.assignments[0]!.id, attemptId: TicketAttemptId('broken'), operationId: TicketOperationId('broken-begin'),
      workspace: { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) }, executor: { kind: 'in-process' },
    }))
    const warning = vi.spyOn(ctx.logger, 'warn')
    other.session.append('ticket/state', { version: 2, sessionId: other.id, ticket: { id: 'broken' } } as never)
    const competing = await assigned(ctx, root, worker, exclusive)
    expect(await prepare(ctx, worker, root, competing, 'conflict').then(() => 'admitted', code)).toBe('TICKET_ATTEMPT_STATE')
    const independent = await assigned(ctx, root, worker, [{ path: 'unrelated/file.ts', access: 'write', exclusive: true }])
    const admitted = await prepare(ctx, worker, root, independent, 'independent')
    await admitted.dispose()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Session "broken-owner"'))
    expect(() => ctx.tickets.list(other.session)).toThrow()
  })

  it.each(['requested', 'authority'])('M1 refuses a missing %s coordinator before append', async (source) => {
    const { ctx, root } = await harness()
    if (source === 'authority') ctx.tickets.registerCoordinatorAuthority(() => SessionId('missing'))
    await expect(ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, {
      subject: 'Missing coordinator', description: '',
      ...source === 'requested' ? { coordinatorId: SessionId('missing') } : {},
    }))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
    expect(ctx.tickets.list(root.session)).toEqual([])
  })

  it('M2 wraps an authority failure with its original cause and appends nothing', async () => {
    const { ctx, root } = await harness()
    const cause = new Error('authority unavailable')
    ctx.tickets.registerCoordinatorAuthority(() => { throw cause })
    const failure = await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, {
      subject: 'Authority', description: '',
    })).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TicketError)
    expect(failure).toMatchObject({ code: 'TICKET_RECOVERY_FAILED', cause })
    expect(ctx.tickets.list(root.session)).toEqual([])
  })

  it('M3 admits unrelated roots before a blocked root flush finishes', async () => {
    const { ctx, root, worker } = await harness()
    const otherRoot = await live(ctx, 'independent-root')
    const otherWorker = await live(ctx, 'independent-worker')
    const first = await assigned(ctx, root, worker)
    const second = await assigned(ctx, otherRoot, otherWorker)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === root.session) { entered.resolve(undefined); await release.promise }
      return flush(session)
    })
    const pending = prepare(ctx, worker, root, first)
    await entered.promise
    let admitted = false
    const other = prepare(ctx, otherWorker, otherRoot, second).then((handle) => { admitted = true; return handle })
    try {
      await vi.waitFor(() => { expect(admitted).toBe(true) }, { timeout: 1000 })
    } finally {
      release.resolve(undefined)
      vi.restoreAllMocks()
      await Promise.all([pending, other]).then(handles => Promise.all(handles.map(handle => handle.dispose())))
    }
  }, 10000)

  it('M4 owner disposal does not retry an already failed stop', async () => {
    const { ctx, root } = await harness(20)
    const member = await transient(ctx, 'failed-stop-worker')
    const ticket = await assigned(ctx, root, member.agent)
    const handle = await prepare(ctx, member.agent, root, ticket)
    const producer = stubbornProducer()
    await handle.startJob('stubborn', producer.run)
    await expect(handle.dispose()).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
    const idle = vi.spyOn(member.agent, 'whenIdle')
    ctx.emit('agent/disposed', { agent: member.agent })
    // A later Session command drains any queued uncertainty record from the disposal listener.
    await ctx.agents.withInitiator(root, () => ctx.tickets.ask(root.session, {
      ticketId: ticket.id, expectedRevision: ctx.tickets.get(root.session, ticket.id).revision,
      actorId: root.id, question: 'Continue?',
    }))
    const repeatedStops = idle.mock.calls.length
    producer.finish()
    await handle.dispose()
    expect(repeatedStops).toBe(0)
  })

  it('M5 compacts settled execution operations while retaining replay and settlement retries', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    const producer = cancellableProducer()
    await handle.startJob('build', producer.run)
    const before = ctx.tickets.get(root.session, ticket.id)
    await handle.dispose()
    const current = ctx.tickets.get(root.session, ticket.id)
    expect(current.operations).toHaveLength(1)
    expect(() => {
      validateTicketChange(before, {
        ...current, operations: current.operations.map(({ retiredIds: _ids, ...operation }) => operation),
      })
    }).toThrow()
    expect(() => {
      validateTicketChange(current, { ...current, revision: current.revision + 1, operations: current.operations.map(operation => ({
        ...operation, id: TicketOperationId('rewritten-settlement'), retiredIds: [operation.id, ...operation.retiredIds ?? []],
      })) })
    }).toThrow()
    const restored = ctx.sessions.create(SessionId('replay-copy'), { seed: root.session.snapshotEvents() })
    // Ticket selectors name the original root; restore without changing durable events.
    const replay = Session.fromRestore(root.id, root.session.snapshotEvents(), root.session.header, SessionLogOffset(0), 'shared-frozen')
    expect(ctx.tickets.get(replay, ticket.id)).toEqual(current)
    expect(ctx.tickets.list(restored)).toEqual([])
    await expect(ctx.agents.withInitiator(worker, () => ctx.tickets.beginAttempt(replay, {
      ticketId: ticket.id, expectedRevision: current.revision, actorId: worker.id,
      assignmentId: ticket.assignments[0]!.id, attemptId: TicketAttemptId('replacement'), operationId: TicketOperationId('prepare-0'),
      workspace: { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) }, executor: { kind: 'in-process' },
    }))).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
    await expect(handle.dispose()).resolves.toBeUndefined()
  })

  it('R3-1 a retried execution settlement does not report success while the Session write is still failing', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    let flushes = 0
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => { flushes++; throw new Error('disk unavailable') })
    const first = await handle.dispose().then(() => 'settled', code)
    const flushesAfterFirst = flushes
    const second = await handle.dispose().then(() => 'settled', () => 'storage failure')
    vi.restoreAllMocks()
    expect(first).not.toBe('settled')
    // The retry must not resolve while the Session write it reports is still failing, and it must retry that write.
    expect({ second, retryFlushed: flushes > flushesAfterFirst }).toEqual({ second: 'storage failure', retryFlushed: true })
  })

  it('R3-2 an aborted preparation that started no producer does not leave a permanently unsettled attempt', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const abort = new AbortController()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    // The caller cancels while the admitted attempt is being persisted, before any producer exists.
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => { abort.abort(); return flush(session) })
    const preparation = await prepare(ctx, worker, root, ticket, '0', abort.signal).then(() => 'admitted', code)
    vi.restoreAllMocks()
    const current = ctx.tickets.get(root.session, ticket.id)
    const cancellation = await ctx.agents.withInitiator(root, () => ctx.tickets.cancel(root.session, {
      ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, summary: 'Caller cancelled' }))
      .then(view => view.status, code)
    expect({ preparation: preparation === 'admitted' ? 'admitted' : 'rejected', attempt: current.attempts[0]?.status, cancellation })
      .toEqual({ preparation: 'rejected', attempt: 'settled', cancellation: 'cancelled' })
  })

  it('R3-3 closing a root Session does not release an exclusive reservation whose producer has not settled', async () => {
    const { ctx, worker } = await harness(50)
    const first = await transient(ctx, 'r3-closing-root')
    const otherRoot = await live(ctx, 'r3-other-root')
    const otherWorker = await live(ctx, 'r3-other-worker')
    const held = await assigned(ctx, first.agent, worker, exclusive)
    const competing = await assigned(ctx, otherRoot, otherWorker, exclusive)
    const handle = await prepare(ctx, worker, first.agent, held)
    const producer = stubbornProducer()
    await handle.startJob('long write', producer.run)
    // Cancellation was requested but the producer did not settle: the attempt is durably `unknown`.
    expect(await handle.dispose().then(() => 'settled', code)).toBe('TICKET_ATTEMPT_STATE')
    expect(ctx.tickets.get(first.agent.session, held.id).attempts[0]?.status).toBe('unknown')
    await first.fiber.dispose()
    const admission = await prepare(ctx, otherWorker, otherRoot, competing).then(async (next) => {
      await next.dispose()
      return 'admitted'
    }, code)
    const producerState = { ...producer.state }
    producer.finish()
    const detach = ctx.sessions.enter(first.agent.session)
    ctx.sessions.announce(first.agent.session)
    await handle.dispose()
    detach()
    // Cancellation reached the producer, which is still writing src/file.ts when the competing root is admitted.
    expect({ producer: producerState, admission }).toEqual({ producer: { cancelled: true, finished: false }, admission: 'TICKET_ATTEMPT_STATE' })
  })

  it('R3-4 a Session whose Ticket log failed recovery does not block shared-workspace admission for other roots', async () => {
    const { ctx, root, worker } = await harness()
    const corrupt = agent(ctx, 'r3-corrupt')
    corrupt.session.append('ticket/state', { version: 2, sessionId: corrupt.id, ticket: { id: 'broken' } } as never)
    expect(() => ctx.tickets.list(corrupt.session)).toThrow()
    const ticket = await assigned(ctx, root, worker, exclusive)
    const admission = await prepare(ctx, worker, root, ticket).then(async (handle) => {
      await handle.dispose()
      return 'admitted'
    }, code)
    expect(admission).toBe('admitted')
  })

  it('R3-5 disposing the preparing Agent alone settles its attempt without an explicit handle dispose', async () => {
    const { ctx, root } = await harness()
    const member = await transient(ctx, 'r3-transient-worker')
    const ticket = await assigned(ctx, root, member.agent)
    const handle = await prepare(ctx, member.agent, root, ticket)
    const producer = cancellableProducer()
    await handle.startJob('long build', producer.run)
    await member.fiber.dispose()
    await vi.waitFor(() => {
      expect({ cancelled: producer.state.cancelled, attempt: ctx.tickets.get(root.session, ticket.id).attempts[0]?.status })
        .toEqual({ cancelled: true, attempt: 'settled' })
    }, { timeout: 2000 })
  })
})
