/** Execution ownership, admission, and terminal-state regressions. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import TicketService, { TicketAttemptId, TicketCandidateId, TicketOperationId, TicketExecutionService } from '../src/index.ts'
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

function agent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
}

async function harness(settlementTimeoutMs = 1000, config: ConstructorParameters<typeof TicketService>[1] = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService, config)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('review-r2')
  await ctx.plugin(Worktrees)
  await ctx.plugin(Directories)
  await ctx.plugin(Subagents)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs })
  const root = agent(ctx, 'r2-root')
  const worker = agent(ctx, 'r2-worker')
  await ctx.agents.register(root)
  await ctx.agents.register(worker)
  return { ctx, root, worker }
}

async function live(ctx: Context, id: string): Promise<Agent> {
  const created = agent(ctx, id)
  await ctx.agents.register(created)
  return created
}

async function assigned(ctx: Context, root: Agent, worker: Agent, workScopes?: WorkScope[]): Promise<TicketView> {
  const ticket = await ctx.agents.withInitiator(root, () =>
    ctx.tickets.create(root.session, { subject: 'Review repro', description: '' }))
  return ctx.agents.withInitiator(root, () => ctx.tickets.assign(root.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id, ownerId: worker.id, subject: 'Contribute',
    ...workScopes === undefined ? {} : { workScopes },
  }))
}

function prepare(ctx: Context, caller: Agent, root: Agent, ticket: TicketView, suffix = '0') {
  return ctx.ticketExecution.prepare(caller, { rootSessionId: root.id, ticketId: ticket.id,
    assignmentId: ticket.assignments[0]!.id, expectedRevision: ticket.revision,
    attemptId: TicketAttemptId(`attempt-${suffix}`), operationId: TicketOperationId(`prepare-${suffix}`),
    workspace: { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) },
    executor: { kind: 'in-process' } })
}

/** A producer that runs until cancelled and records whether cancellation reached it. */
function cancellableProducer() {
  const done = Promise.withResolvers<JobOutcome>()
  const state = { cancelled: false }
  return {
    state,
    run: () => ({ cancel() { state.cancelled = true; done.resolve({ status: 'killed' }) }, done: done.promise }),
  }
}

function code(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error)
}

describe('Ticket execution lifecycle', () => {
  it('R2-1 execution settlement survives a concurrent Ticket command from another live writer', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    // Hold the first Session flush so one committed command is still in the per-Session queue when the
    // execution adapter reads the revision; this models ordinary persistence latency.
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let held = false
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!held) { held = true; entered.resolve(undefined); await gate.promise }
      return flush(session)
    })
    const current = ctx.tickets.get(root.session, ticket.id)
    const question = ctx.agents.withInitiator(root, () => ctx.tickets.ask(root.session, {
      ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, question: 'Which module owns this?' }))
    const progress = ctx.agents.withInitiator(worker, () => ctx.tickets.report(root.session, {
      ticketId: ticket.id, expectedRevision: current.revision + 1, actorId: worker.id, assignmentId: ticket.assignments[0]!.id,
      attemptId: handle.attempt.id, kind: 'progress', summary: 'Halfway' }))
    const settlement = handle.settle().then(() => 'settled', code)
    await entered.promise
    gate.resolve(undefined)
    await question
    await progress
    expect(held).toBe(true)
    expect({ settlement: await settlement, attempt: ctx.tickets.get(root.session, ticket.id).attempts[0]?.status })
      .toEqual({ settlement: 'settled', attempt: 'settled' })
  })

  it('R2-2 disposing a coordinator-prepared attempt after coordinator handoff still cancels its producer', async () => {
    const { ctx, root, worker } = await harness()
    const successor = await live(ctx, 'r2-successor')
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, root, root, ticket)
    const producer = cancellableProducer()
    const id: JobId = await handle.startJob('long build', producer.run)
    const current = ctx.tickets.get(root.session, ticket.id)
    await ctx.agents.withInitiator(root, () => ctx.tickets.handoff(root.session, {
      ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, newCoordinatorId: successor.id }))
    const disposal = await handle.dispose().then(() => 'settled', code)
    const observed = {
      disposal, producerCancelled: producer.state.cancelled,
      job: ctx.jobs.get(id, root.id).status,
      attempt: ctx.tickets.get(root.session, ticket.id).attempts[0]?.status,
    }
    if (!producer.state.cancelled) ctx.jobs.kill(id, root.id)
    expect(observed).toEqual({ disposal: 'settled', producerCancelled: true, job: 'killed', attempt: 'settled' })
  })

  it('R2-2b disposing the preparing Agent leaves a durable attempt that reflects its stopped producer', async () => {
    const { ctx, root } = await harness()
    let scope: Context | undefined
    const fiber = ctx.plugin({ name: 'r2-transient-scope', inject: ['agents'], apply: (child: Context) => { scope = child } })
    await fiber
    const transient = { ...agent(ctx, 'r2-transient-worker'), ctx: scope! }
    await scope!.agents.register(transient)
    const ticket = await assigned(ctx, root, transient)
    const handle = await prepare(ctx, transient, root, ticket)
    const producer = cancellableProducer()
    await handle.startJob('long build', producer.run)
    await fiber.dispose()
    const disposal = await handle.dispose().then(() => 'settled', code)
    expect({ disposal, producerCancelled: producer.state.cancelled, attempt: ctx.tickets.get(root.session, ticket.id).attempts[0]?.status })
      .toEqual({ disposal: 'settled', producerCancelled: true, attempt: 'settled' })
  })

  it('R2-3 dispose after a timed-out settle still requests producer cancellation', async () => {
    const { ctx, root, worker } = await harness(50)
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    const producer = cancellableProducer()
    const id = await handle.startJob('long build', producer.run)
    const natural = await handle.settle().then(() => 'settled', code)
    expect(natural).toBe('TICKET_ATTEMPT_STATE')
    const disposal = await handle.dispose().then(() => 'settled', code)
    const observed = { disposal, producerCancelled: producer.state.cancelled, job: ctx.jobs.get(id, worker.id).status }
    if (!producer.state.cancelled) ctx.jobs.kill(id, worker.id)
    expect(observed).toEqual({ disposal: 'settled', producerCancelled: true, job: 'killed' })
  })

  it('R2-4 a parent whose required child was cancelled can itself be cancelled', async () => {
    const { ctx, root } = await harness()
    const parent = await ctx.agents.withInitiator(root, () =>
      ctx.tickets.create(root.session, { subject: 'Parent', description: '' }))
    const child = await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, {
      subject: 'Required child', description: '', parent: { ticketId: parent.id, required: true } }))
    await ctx.agents.withInitiator(root, () => ctx.tickets.cancel(root.session, {
      ticketId: child.id, expectedRevision: child.revision, actorId: root.id, summary: 'Child abandoned' }))
    await expect(ctx.agents.withInitiator(root, () => ctx.tickets.cancel(root.session, {
      ticketId: parent.id, expectedRevision: parent.revision, actorId: root.id, summary: 'Parent abandoned' })))
      .resolves.toMatchObject({ status: 'cancelled' })
  })

  it('R2-5 every admitted attempt can settle and the Ticket can end under default limits', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    let failure: { cycle: number; code: string } | undefined
    for (let cycle = 0; cycle < 60 && failure === undefined; cycle++) {
      try {
        const handle = await prepare(ctx, worker, root, ctx.tickets.get(root.session, ticket.id), String(cycle))
        await handle.settle()
      } catch (error: unknown) {
        failure = { cycle, code: error instanceof AggregateError ? code(error.errors.at(-1)) : code(error) }
      }
    }
    const current = ctx.tickets.get(root.session, ticket.id)
    const unsettled = current.attempts.filter(attempt => attempt.status !== 'settled').map(attempt => `${attempt.id}:${attempt.status}`)
    const cancellation = await ctx.agents.withInitiator(root, () => ctx.tickets.cancel(root.session, {
      ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, summary: 'Stop retrying' }))
      .then(view => view.status, code)
    expect({ failure, unsettled, cancellation }).toEqual({ failure: undefined, unsettled: [], cancellation: 'cancelled' })
  })

  it('R2-6 exclusive write reservations exclude an overlapping attempt from another root Session', async () => {
    const { ctx, root, worker } = await harness()
    const otherRoot = await live(ctx, 'r2-other-root')
    const otherWorker = await live(ctx, 'r2-other-worker')
    const scopes: WorkScope[] = [{ path: 'src/file.ts', access: 'write', exclusive: true }]
    const first = await assigned(ctx, root, worker, scopes)
    const second = await assigned(ctx, otherRoot, otherWorker, scopes)
    const held = await prepare(ctx, worker, root, first)
    const [competing] = await Promise.allSettled([prepare(ctx, otherWorker, otherRoot, second)])
    await held.dispose()
    if (competing.status === 'fulfilled') await competing.value.dispose()
    expect(competing.status === 'rejected' ? code(competing.reason) : 'admitted').toBe('TICKET_ATTEMPT_STATE')
  })

  it('M1 rejects preparation impersonating a different initiating Agent', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const result = await ctx.agents.withInitiator(worker, () => prepare(ctx, root, root, ticket)).then(() => 'admitted', code)
    expect(result).toBe('TICKET_AUTHORITY')
  })

  it('M2 identifies the Assignment without a current result when submitting a candidate', async () => {
    const { ctx, root, worker } = await harness()
    let ticket = await assigned(ctx, root, worker)
    ticket = await ctx.agents.withInitiator(worker, () => ctx.tickets.report(root.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: worker.id,
      assignmentId: ticket.assignments[0]!.id, kind: 'progress', summary: 'Working' }))
    await expect(ctx.agents.withInitiator(root, () => ctx.tickets.submitCandidate(root.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id,
      candidateId: TicketCandidateId('candidate'), specRevision: ticket.specification.revision,
      content: { kind: 'commit', repository: '/review/shared', commit: 'a'.repeat(40) }, assignmentIds: [ticket.assignments[0]!.id],
    }))).rejects.toMatchObject({ code: 'TICKET_ACCEPTANCE', message: `Assignment "${ticket.assignments[0]!.id}" requires a current result before candidate submission` })
  })

  it('M3 refuses repeated preparation after its live reservation has settled', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    await handle.settle()
    await expect(prepare(ctx, worker, root, ticket)).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  })

  it('M4 requires a workspace-bearing attempt for an exclusive write claim', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker, [{ path: 'src/file.ts', access: 'write', exclusive: true }])
    await expect(ctx.agents.withInitiator(worker, () => ctx.tickets.claim(root.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: worker.id,
      assignmentId: ticket.assignments[0]!.id,
    }))).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  })

  it('M5 refuses handoff to an unregistered coordinator without appending', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const events = root.session.snapshotEvents()
    await expect(ctx.agents.withInitiator(root, () => ctx.tickets.handoff(root.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id,
      newCoordinatorId: SessionId('missing'),
    }))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
    expect(root.session.snapshotEvents()).toEqual(events)
  })


  it.each(['cancelled', 'failed'] as const)('R2-4 permits a %s parent with unfinished required children', async (outcome) => {
    const { ctx, root } = await harness()
    let parent = await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, { subject: 'Parent', description: '' }))
    parent = await ctx.agents.withInitiator(root, () => ctx.tickets.ask(root.session, { ticketId: parent.id, expectedRevision: parent.revision, actorId: root.id, question: 'Continue?' }))
    await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, {
      subject: 'Required child', description: '', parent: { ticketId: parent.id, required: true } }))
    const request = { ticketId: parent.id, expectedRevision: parent.revision, actorId: root.id, summary: 'Stopped' }
    const result = await ctx.agents.withInitiator(root, () => outcome === 'cancelled'
      ? ctx.tickets.cancel(root.session, request) : ctx.tickets.fail(root.session, request))
    expect(result.status).toBe(outcome)
  })

  it('R2-3 escalates a pending natural settlement and leaves a settled worker alone', async () => {
    const { ctx, root, worker } = await harness()
    const cancelled = vi.spyOn(worker, 'cancel')
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    const producer = cancellableProducer()
    await handle.startJob('build', producer.run)
    const settling = handle.settle()
    await handle.dispose()
    await settling
    expect(producer.state.cancelled).toBe(true)
    expect(cancelled).toHaveBeenCalledTimes(1)
    await handle.dispose()
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('R2-2 cancels producers before a failed durable settlement and permits reconciliation', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    const producer = cancellableProducer()
    await handle.startJob('build', producer.run)
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async () => {
      expect(producer.state.cancelled).toBe(true)
      throw new Error('disk unavailable')
    }).mockImplementation(flush)
    await expect(handle.dispose()).rejects.toThrow()
    expect(producer.state.cancelled).toBe(true)
    await handle.dispose()
    expect(ctx.tickets.get(root.session, ticket.id).attempts[0]?.status).toBe('settled')
  })

  it('R2-5 refuses new state before consuming the byte capacity needed for settlement', async () => {
    const { ctx, root, worker } = await harness(1000, { maxSnapshotBytes: 5000 })
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    let refusal: string | undefined
    for (let i = 0; i < 40; i++) {
      const current = ctx.tickets.get(root.session, ticket.id)
      const result = await ctx.agents.withInitiator(root, () => ctx.tickets.ask(root.session, {
        ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, question: 'q'.repeat(200),
      })).then(() => undefined, code)
      if (result !== undefined) { refusal = result; break }
    }
    expect(refusal).toBe('TICKET_SNAPSHOT_TOO_LARGE')
    await handle.dispose()
    const current = ctx.tickets.get(root.session, ticket.id)
    expect(current.attempts[0]?.status).toBe('settled')
    expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThanOrEqual(5000)
    await expect(ctx.agents.withInitiator(root, () => ctx.tickets.cancel(root.session, {
      ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, summary: 'Stopped',
    }))).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('R2-6 serializes competing roots and keeps unknown reservations until settlement', async () => {
    const { ctx, root, worker } = await harness(10)
    const otherRoot = await live(ctx, 'second-root')
    const otherWorker = await live(ctx, 'second-worker')
    const scopes: WorkScope[] = [{ path: 'src/file.ts', access: 'write', exclusive: true }]
    const first = await assigned(ctx, root, worker, scopes)
    const second = await assigned(ctx, otherRoot, otherWorker, scopes)
    const admitted = await Promise.allSettled([prepare(ctx, worker, root, first), prepare(ctx, otherWorker, otherRoot, second)])
    expect(admitted.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const winner = admitted.find(result => result.status === 'fulfilled')
    if (winner === undefined) throw new Error('missing admitted handle')
    const producer = cancellableProducer()
    await winner.value.startJob('build', producer.run)
    await expect(winner.value.settle()).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
    const loser = admitted[0].status === 'rejected' ? { caller: worker, root, ticket: first } : { caller: otherWorker, root: otherRoot, ticket: second }
    await expect(prepare(ctx, loser.caller, loser.root, loser.ticket)).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
    await winner.value.dispose()
    const next = await prepare(ctx, loser.caller, loser.root, loser.ticket)
    await next.dispose()
  })


  it('records a rejected producer as settled failure', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    await handle.startJob('failed build', () => ({ cancel() {}, done: Promise.reject(new Error('compiler failed')) }))
    await handle.settle()
    expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
  })


  it('R2-5 admits one fully settleable attempt at the smallest attempt-count limit', async () => {
    const { ctx, root, worker } = await harness(1000, { maxReports: 1 })
    const ticket = await assigned(ctx, root, worker)
    const handle = await prepare(ctx, worker, root, ticket)
    await handle.settle()
    const current = ctx.tickets.get(root.session, ticket.id)
    await expect(prepare(ctx, worker, root, current, 'second')).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
    expect(ctx.tickets.get(root.session, ticket.id)).toEqual(current)
    await expect(ctx.agents.withInitiator(root, () => ctx.tickets.cancel(root.session, {
      ticketId: ticket.id, expectedRevision: current.revision, actorId: root.id, summary: 'Stopped',
    }))).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('replays existing canonical JSON operation fingerprints without appending duplicates', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const request = {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: worker.id,
      assignmentId: ticket.assignments[0]!.id, attemptId: TicketAttemptId('historical-attempt'),
      operationId: TicketOperationId('historical-operation'),
      workspace: { kind: 'shared-workspace' as const, directory: '/review/shared', baseCommit: 'a'.repeat(40) },
      executor: { kind: 'in-process' as const },
    }
    await ctx.agents.withInitiator(worker, () => ctx.tickets.beginAttempt(root.session, request))
    const { expectedRevision: _revision, ...payload } = request
    const canonical = JSON.stringify({ kind: 'begin', ...payload }, (_key, value: unknown) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value)
    const replay = Session.create(root.id, root.session.snapshotEvents().map(event => event.type === 'ticket/state' && event.data.version === 2
      ? { ...event, data: { ...event.data, ticket: { ...event.data.ticket,
        operations: event.data.ticket.operations.map(operation => ({ ...operation, request: canonical })),
      } } } : event))
    const before = replay.snapshotEvents()
    await expect(ctx.agents.withInitiator(worker, () => ctx.tickets.beginAttempt(replay, request)))
      .resolves.toMatchObject({ attempts: [{ id: request.attemptId }] })
    expect(replay.snapshotEvents()).toEqual(before)
  })


  it('R2-5 separates caller operation identities from reserved execution facts before admission', async () => {
    const { ctx, root, worker } = await harness()
    const ticket = await assigned(ctx, root, worker)
    const request = {
      rootSessionId: root.id, ticketId: ticket.id, expectedRevision: ticket.revision,
      assignmentId: ticket.assignments[0]!.id, attemptId: TicketAttemptId('collision-attempt'),
      workspace: { kind: 'shared-workspace' as const, directory: '/review/shared', baseCommit: 'a'.repeat(40) },
      executor: { kind: 'in-process' as const },
    }
    await expect(ctx.ticketExecution.prepare(worker, { ...request,
      operationId: TicketOperationId('ticket-execution:["collision-attempt","settled"]'),
    })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
    expect(ctx.tickets.get(root.session, ticket.id)).toEqual(ticket)
    const handle = await ctx.ticketExecution.prepare(worker, { ...request, operationId: TicketOperationId('collision-attempt:settled') })
    await handle.dispose()
    expect(ctx.tickets.get(root.session, ticket.id).attempts[0]?.status).toBe('settled')
  })


})
