/** Durable Ticket attempt ownership over managed activations and background Jobs. */

import { isAbsolute } from 'node:path'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHandle, JobHooks, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import { type SubagentActivation, SubagentError, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import {
  type AttemptEvent, type AttemptOutcome, type AttemptState, type UncertaintyStage, isAborted, isTerminal, transitionAttempt,
  uncertaintyDiagnostic,
} from './attempt-lifecycle.ts'
import { TicketError } from './errors.ts'
import {
  type AssignmentSnapshot, type BeginTicketAttemptRequest, type TicketAttemptSnapshot, type TicketProducerReservation,
  type TicketView, type TicketWorkspaceReceipt, type TicketAttemptController,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { ticketExecution: TicketExecutionService }
  interface Events {
    /**
     * Collects the reservations of execution-owned attempts whose producers may still run in this host. Each reservation is
     * registered on the root context when its admission is recorded, so a replaced Ticket or execution service still sees it;
     * it leaves when its attempt is handed to the settlement ledger or released, when its root Session log records the attempt
     * settled, or, once the attempt is `unknown`, when its producers' own signals prove they stopped, including after the
     * service that admitted them was torn down. Admission excludes the work scopes of shared-workspace reservations, and
     * restart recovery of a resumed root leaves every collected attempt to the producers that hold it.
     * @param collect - Receives each reservation synchronously.
     * @mode emit
     */
    'ticket/collect-reservations'(collect: (reservation: TicketProducerReservation) => void): void
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { ticket: 'ticket' }
}

/** One `settlementTimeoutMs` deadline. Its timer starts at `arm()`, or at creation for an armed deadline; `expired` rejects
 * with `reason` once it passes, and `clear` stops the timer. */
interface Deadline {
  readonly expired: Promise<never>
  readonly reason: TicketError
  /** Start the timer; later calls, and calls after `clear()`, do nothing. */
  arm(): void
  clear(): void
}

/** Runtime settlement bound; expiry retains the durable reservation. */
export interface TicketExecutionConfig {
  readonly settlementTimeoutMs: number
}

/** Explicit attempt identity and placement selected before resource acquisition. */
export interface PrepareTicketExecutionRequest extends Omit<BeginTicketAttemptRequest, 'actorId'> {
  readonly rootSessionId: Session['id']
  readonly worktreeName?: string
  /** Cancels preparation until the handle is published and is not retained afterwards; cancel running work with a
   * `startJob` signal or `dispose()`. */
  readonly signal?: AbortSignal
}

/** Actual retained checkout facts, independent from executor placement. */
export type TicketExecutionWorkspace = TicketWorkspaceReceipt

/** One admitted attempt; results do not release its assignment. */
export interface TicketExecutionHandle {
  readonly ticket: TicketView
  readonly assignment: AssignmentSnapshot
  readonly attempt: TicketAttemptSnapshot
  readonly workspace: TicketExecutionWorkspace
  readonly activation?: SubagentActivation
  readonly result?: Promise<SubagentResult>
  readonly jobs: readonly JobId[]
  /** Persist Job admission before starting attached background work.
   * @param label - Human-readable operation name.
   * @param run - Job producer with a settlement promise.
   * @param signal - Optional cancellation request.
   * @returns Registered Job identity after its receipt is persisted.
   */
  startJob(label: string, run: (job: JobHandle) => JobHooks, signal?: AbortSignal): Promise<JobId>
  /** Await natural producer completion and resource release, then hand the observed outcome to the settlement ledger. */
  settle(): Promise<void>
  /** Request cancellation and await all producers before settling the attempt; a retry after a failed stop cancels again. */
  dispose(): Promise<void>
}

/** One Ticket Job producer. Once Ticket started the producer, only the producer's own `done` settles `done`; Ticket settles
 * it itself only when it never started the producer. */
interface Producer {
  /** Deliver a cancellation request unless the producer has finished; a throwing cancel hook propagates.
   * @param reason - Text forwarded to the producer's cancel hook.
   */
  cancel(reason: string): void
  readonly done: Promise<JobOutcome>
  finished: boolean
}

/** A reservation registered on the root context; `release` is idempotent. */
interface RetainedReservation {
  release(): void
}

/** One execution-owned attempt. Only {@link TicketExecutionService.apply} assigns `state`. */
interface AttemptRun {
  readonly key: string
  readonly caller: Agent
  readonly rootId: Session['id']
  readonly ownerId: Session['id']
  readonly ticketId: TicketView['id']
  readonly attemptId: TicketAttemptSnapshot['id']
  readonly fingerprint: string
  /** The attempt's ownership record and work scopes, read from the Ticket revision the admission checks. */
  readonly reservation: TicketProducerReservation
  /** Aborted exactly when the state becomes aborted; effects of preparation observe only this signal. */
  readonly lifetime: AbortController
  state: AttemptState
  abortReason?: Error
  /** The preparation callers join: `work` bounded by `bound`. An identical retry of an `unflushed` admission replaces it. */
  preparation?: Promise<TicketExecutionHandle>
  /** The preparation itself. It runs to a terminal or `uncertain` state after its callers stop waiting; teardown joins it. */
  work?: Promise<TicketExecutionHandle>
  /** Bounds the callers' wait for `work`; armed when preparation is aborted or enters its failure report. */
  bound?: Deadline
  /** The failure `work` reports, once known; a caller whose bound expires first receives it with the pending step. */
  failure?: Error
  recorder?: TicketAttemptController
  /** Registered when the admission is recorded; released on entry to `handed` or `released`, or as described by the
   * `ticket/collect-reservations` event. */
  retained?: RetainedReservation
  /** Set when the first entry to `unknown` attached the producers' own settlement signals to the retained reservation. */
  joined?: true
  worker?: Agent
  workspace?: TicketWorkspaceReceipt
  activation?: SubagentActivation
  readonly jobs: JobId[]
  readonly producers: Map<JobId, Producer>
  readonly listeners: Set<() => void>
  /** Serializes Job admissions; a stop joins the pending admission inside its deadline. */
  queue: Promise<void>
  /** The stop that entered `stopping` most recently. */
  stop?: Promise<void>
  /** Rejected by a failed cancellation request during the current stop. */
  stopFailure?: PromiseWithResolvers<never>
  /** The settlement ledger's write for the outcome handed over on entry to `handed`. */
  settlement?: Promise<unknown>
  /** In-flight uncertainty writes; a failure while one is pending joins it instead of writing again. */
  readonly recordings: Map<UncertaintyStage, Promise<void>>
}

type CancellationEvent = Extract<AttemptEvent, { type: 'caller-abort' | 'owner-disposed' | 'teardown' }>
type ExecutionEvent = Exclude<AttemptEvent, CancellationEvent> | (CancellationEvent & { readonly reason: Error })

const runKey = (rootId: Session['id'], request: Pick<PrepareTicketExecutionRequest, 'ticketId' | 'assignmentId'>) =>
  JSON.stringify([rootId, request.ticketId, request.assignmentId])

const asError = (value: unknown, message: string): Error => value instanceof Error ? value : new Error(message, { cause: value })

/** Whether a rejected Subagent start reports that releasing an execution it created failed, so that execution may still run. */
const rollbackFailed = (error: unknown): boolean => error instanceof SubagentError && error.code === 'ACTIVATION_TEARDOWN_FAILED'

/** Serializes attempt admission, retains uncertain resources, and waits for producer settlement. */
export class TicketExecutionService extends Service {
  static inject = ['tickets', 'jobs', 'worktrees', 'sessions', 'agents', 'subagents', 'workingDirectory']
  /** Execution reservations: one live run per root, Ticket and assignment, from creation until it is handed or released. */
  private readonly runs = new Map<string, AttemptRun>()
  private closing = false
  /** Captured at construction: a run of a torn-down generation still reports through it. */
  private readonly logger: Context['logger']

  constructor(ctx: Context, private readonly config: TicketExecutionConfig) {
    super(ctx, 'ticketExecution')
    this.logger = ctx.logger
    if (!Number.isSafeInteger(config.settlementTimeoutMs) || config.settlementTimeoutMs <= 0) {
      throw new TicketError('Ticket execution settlementTimeoutMs must be a positive safe integer', 'TICKET_INVALID_INPUT')
    }
  }

  protected [Service.init](): void {
    this.ctx.on('agent/disposed', ({ agent }) => {
      for (const run of [...this.runs.values()]) {
        const published = run.state.kind === 'running' || run.state.kind === 'stopping' || run.state.kind === 'unknown'
        const owner = published ? run.worker?.id : run.ownerId
        if (run.caller !== agent && owner !== agent.id && run.rootId !== agent.session.id) continue
        this.raise(run, { type: 'owner-disposed' }, 'Ticket execution owner disposal did not settle; reservation retained for reconciliation',
          new TicketError(`Ticket execution owner "${agent.id}" was disposed during preparation`, 'TICKET_AUTHORITY'))
      }
    })
    this.ctx.effect(() => async () => {
      this.closing = true
      const runs = [...this.runs.values()]
      const reason = new TicketError('Ticket execution admission is closed', 'TICKET_ATTEMPT_STATE')
      const deadline = this.deadline('Ticket execution teardown timed out')
      for (const run of runs) this.apply(run, { type: 'teardown', reason })
      const drain = (async () => {
        await Promise.allSettled(runs.map(run => run.work).filter(work => work !== undefined))
        const results = await Promise.allSettled(runs.map(async (run) => {
          if (run.state.kind === 'stopping') await run.stop
          if (run.state.kind === 'handed') {
            const { outcome } = run.state
            await run.settlement?.catch((error: unknown) => {
              this.logger.warn(`Ticket attempt ended ${outcome}; the settlement ledger `
                + `retains it until its root is writable: ${String(error)}`)
            })
          }
        }))
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result): unknown => result.reason)
        if (failures.length > 0) throw new AggregateError(failures, 'Ticket execution teardown did not settle')
      })()
      try {
        await this.within(drain, deadline, () => new TicketError('Ticket execution teardown stopped waiting after settlementTimeoutMs; '
          + 'its attempts keep their reservations and finish their writes in the settlement ledger', 'TICKET_SETTLEMENT_PENDING'),
        this.warn('Ticket execution teardown failed after its deadline'))
      } finally { deadline.clear() }
    }, 'ticket-execution.runtime()')
  }

  /** Prepare or return the exact live attempt; recovered attempts cannot replay effects.
   * @param caller - Exact registered owner or current coordinator.
   * @param request - Stable operation and attempt ids, CAS, and explicit placement.
   * @returns The single resource handle retained for this preparation. Once preparation is aborted (by `request.signal`,
   * owner disposal or teardown) or fails, the promise settles within settlementTimeoutMs; the attempt still reaches its
   * terminal or uncertain durable state afterwards, and an expired wait rejects with `TICKET_SETTLEMENT_PENDING`.
   */
  prepare(caller: Agent, request: PrepareTicketExecutionRequest): Promise<TicketExecutionHandle> {
    try {
      this.assertCaller(caller)
      if (this.closing) throw new TicketError('Ticket execution admission is closed', 'TICKET_ATTEMPT_STATE')
      request.signal?.throwIfAborted()
      const root = this.ctx.sessions.get(request.rootSessionId)
      if (root === undefined) throw new TicketError('Ticket technical root Session is not live', 'TICKET_NOT_FOUND')
      const current = this.ctx.tickets.get(root, request.ticketId)
      const assignment = current.assignments.find(item => item.id === request.assignmentId)
      if (assignment === undefined) throw new TicketError('Ticket assignment was not found', 'TICKET_ASSIGNMENT_NOT_FOUND')
      if (caller.id !== assignment.ownerId && caller.id !== current.coordinatorId) throw new TicketError('Ticket execution requires the assigned owner or coordinator', 'TICKET_AUTHORITY')
      const { signal: _signal, ...facts } = request
      const fingerprint = JSON.stringify(facts)
      const key = runKey(root.id, request)
      const unsettled = current.attempts.some(item => item.assignmentId === assignment.id && item.status !== 'settled')
      const retained = this.runs.get(key)
      if (retained !== undefined) {
        if (retained.caller === caller && retained.fingerprint === fingerprint) {
          const resumed = retained.state.kind === 'unflushed'
          this.apply(retained, { type: 'retry' })
          // The admission is in the in-memory log; the retry repeats its flush and continues preparation.
          if (resumed || retained.preparation === undefined) return this.launch(retained, root, assignment, request)
          return retained.preparation
        }
        if (unsettled) throw new TicketError('Ticket assignment already has a different execution reservation', 'TICKET_ATTEMPT_STATE')
        this.apply(retained, { type: 'reconciled' })
      }
      if (current.attempts.some(item => item.id === request.attemptId)) throw new TicketError('Recovered or settled attempt cannot prepare another live handle', 'TICKET_ATTEMPT_STATE')
      if (current.revision !== request.expectedRevision) throw new TicketError('Ticket execution revision is stale', 'TICKET_STALE_REVISION')
      if (current.terminalOutcome !== undefined) throw new TicketError('Terminal Ticket cannot execute', 'TICKET_TERMINAL')
      if (unsettled) throw new TicketError('Recovered Ticket attempt requires settlement reconciliation before execution', 'TICKET_ATTEMPT_STATE')
      this.preflight(request)
      // The admission's compare-and-set requires this revision, so these are the scopes it reserves.
      const reservation: TicketProducerReservation = {
        rootId: root.id, ticketId: request.ticketId, attemptId: request.attemptId, workspace: request.workspace,
        executor: request.executor, scopes: assignment.workScopes,
      }
      const run: AttemptRun = {
        key, caller, rootId: root.id, ownerId: assignment.ownerId, ticketId: request.ticketId, attemptId: request.attemptId,
        fingerprint, reservation, lifetime: new AbortController(), state: { kind: 'admitting', aborted: false },
        jobs: [], producers: new Map(), listeners: new Set(), queue: Promise.resolve(), recordings: new Map(),
      }
      this.runs.set(key, run)
      return this.launch(run, root, assignment, request)
    } catch (error: unknown) {
      return Promise.reject(asError(error, 'Ticket execution preparation failed'))
    }
  }

  /** Start one preparation and return the callers' bounded wait for it. */
  private launch(
    run: AttemptRun, root: Session, assignment: AssignmentSnapshot, request: PrepareTicketExecutionRequest,
  ): Promise<TicketExecutionHandle> {
    const bound = this.deadline('Ticket preparation stop timed out', false)
    run.bound = bound
    delete run.failure
    const work = this.drive(run, root, assignment, request)
    run.work = work
    void work.then(() => { bound.clear() }, () => { bound.clear() })
    const late = this.warn(`Ticket preparation of attempt "${run.attemptId}" failed after its callers stopped waiting`)
    // A cancellation whose writes succeeded rejects with only the preparation's own cause, which its callers already received.
    run.preparation = this.within(work, bound, () => this.unfinished(run), (failure) => {
      if (failure !== run.failure && failure !== run.abortReason) late(failure)
    })
    return run.preparation
  }

  /** The only writer of attempt state: applies one event through {@link transitionAttempt} and runs the entry actions of
   * the new state. Reservation release, the ledger hand-off and each cancellation request happen here and nowhere else. */
  private apply(run: AttemptRun, event: Extract<AttemptEvent, { type: 'settle' | 'dispose' }>):
  Extract<AttemptState, { kind: 'stopping' | 'handed' }>
  private apply(run: AttemptRun, event: Extract<AttemptEvent, { type: 'producers-settled' }>):
  Extract<AttemptState, { kind: 'handed' }>
  private apply(run: AttemptRun, event: Extract<AttemptEvent, { type: 'stop-failed' | 'cleanup-failed' }>):
  Extract<AttemptState, { kind: 'unknown' }>
  private apply(run: AttemptRun, event: ExecutionEvent): AttemptState
  private apply(run: AttemptRun, event: ExecutionEvent): AttemptState {
    const previous = run.state
    const next = transitionAttempt(previous, event)
    if ('reason' in next) throw new TicketError(next.reason, 'TICKET_ATTEMPT_STATE')
    run.state = next
    const stopped = event.type === 'caller-abort' || event.type === 'owner-disposed' || event.type === 'teardown'
    // Becoming aborted, or an abort that hands a `preparing` attempt over, ends the preparation.
    if (stopped && ((isAborted(next) && !isAborted(previous)) || previous.kind === 'preparing')) {
      run.abortReason ??= event.reason
      run.lifetime.abort(run.abortReason)
      run.bound?.arm()
    }
    if (next.kind === 'stopping') {
      if (previous.kind !== 'stopping') {
        run.stopFailure = Promise.withResolvers()
        void run.stopFailure.promise.catch(() => {})
        run.stop = this.stopRun(run, run.stopFailure.promise)
        void run.stop.catch(() => {})
      }
      // Each entry to the cancel intent sends a fresh cancellation request to every producer that has not finished.
      if (next.cancel && !(previous.kind === 'stopping' && previous.cancel)) this.cancelProducers(run)
    }
    if (next.kind === 'unknown') this.releaseOnQuiescence(run)
    if (isTerminal(next) && !isTerminal(previous)) {
      this.runs.delete(run.key)
      for (const cleanup of run.listeners) cleanup()
      run.retained?.release()
      if (next.kind === 'handed') run.settlement = this.handOff(run, next.outcome)
    }
    return next
  }

  /** Apply an event raised outside any caller and report a stop or hand-off it starts. */
  private raise(run: AttemptRun, event: Extract<AttemptEvent, { type: 'owner-disposed' }>, warning: string, reason: Error): void {
    const previous = run.state
    const next = this.apply(run, { ...event, reason })
    const report = (error: unknown) => { this.logger.warn(`${warning}: ${String(error)}`) }
    if (next.kind === 'stopping' && previous.kind !== 'stopping') void run.stop?.catch(report)
    if (next.kind === 'handed' && previous.kind !== 'handed') void run.settlement?.catch(report)
  }

  private withRecorder<T>(
    recorder: TicketAttemptController | undefined, message: string, operation: (recorder: TicketAttemptController) => Promise<T>,
  ): Promise<T> {
    if (recorder === undefined) return Promise.reject(new TicketError(message, 'TICKET_RECOVERY_FAILED'))
    return operation(recorder)
  }

  /** The ledger takes the outcome synchronously, before any write that can fail, with the known workspace receipt. */
  private handOff(run: AttemptRun, outcome: AttemptOutcome): Promise<unknown> {
    return this.withRecorder(run.recorder, 'Ticket attempt reached the ledger without an admission', (recorder) => {
      const settlement = recorder.settle(outcome, run.workspace === undefined ? undefined : { workspaceReceipt: run.workspace })
      void settlement.catch(() => {})
      return settlement
    })
  }

  /** Register the run's reservation on the root context, in the step that records its admission. */
  private retain(run: AttemptRun): void {
    const { reservation } = run
    const { root } = this.ctx
    // An unloading host admits nothing afterwards, and its exit ends the producers it ran.
    if (run.retained !== undefined || root.fiber.state === FiberState.UNLOADING || root.fiber.state === FiberState.DISPOSED) return
    const disposers: (() => boolean)[] = []
    let released = false
    const retained: RetainedReservation = {
      release: () => {
        if (released) return
        released = true
        for (const dispose of disposers) dispose()
      },
    }
    disposers.push(root.on('ticket/collect-reservations', (collect) => { collect(reservation) }))
    // A host that settles the attempt declares its producers ended or abandoned.
    disposers.push(root.on('session/event', (session, event) => {
      if (session.id !== reservation.rootId || event.type !== 'ticket/state') return
      const attempt = event.data.ticket.id === reservation.ticketId && 'attempts' in event.data.ticket
        ? event.data.ticket.attempts.find(item => item.id === reservation.attemptId) : undefined
      if (attempt?.status === 'settled') retained.release()
    }))
    run.retained = retained
  }

  /** Release an `unknown` run's root-scoped reservation once its producers' own signals prove they stopped, even after its
   * service is gone: a later service generation waits for this rather than adopting the run. An `uncertain` run has no
   * producer handle to join, so only a host settlement or host exit releases it. */
  private releaseOnQuiescence(run: AttemptRun): void {
    const retained = run.retained
    if (retained === undefined || run.joined !== undefined) return
    run.joined = true
    const { logger } = this
    const { attemptId } = run
    const activation = run.activation
    const joins: Promise<unknown>[] = [...run.producers.values()].map(producer => producer.done)
    // Only a resolved dispose() proves the release. It is read after the result, when the activation is already closing, so
    // joining never cancels an activation whose natural settlement merely timed out.
    if (activation !== undefined) joins.push(activation.result.then(() => activation.dispose(), () => activation.dispose()))
    if (run.worker !== undefined) joins.push(run.worker.whenIdle())
    void Promise.all(joins).then(() => { retained.release() }, (error: unknown) => {
      logger.warn(`Ticket attempt "${attemptId}" is unknown and its producers did not confirm releasing their resources; its work `
        + `scopes stay reserved until a host settles the attempt or this host exits: ${String(error)}`)
    })
  }

  private assertOwners(caller: Agent, root: Agent, worker: Agent | undefined): void {
    this.assertCaller(caller)
    if (this.ctx.agents.get(root.id) !== root || (worker !== undefined && this.ctx.agents.get(worker.id) !== worker)) {
      throw new TicketError('Ticket execution owner was disposed during preparation', 'TICKET_AUTHORITY')
    }
  }

  private assertCaller(caller: Agent): void {
    const initiating = this.ctx.agents.currentInitiator()
    if ((initiating !== undefined && initiating !== caller) || this.ctx.agents.get(caller.id) !== caller
      || this.ctx.sessions.get(caller.id) !== caller.session) {
      throw new TicketError('Ticket execution requires the exact live caller Agent', 'TICKET_AUTHORITY')
    }
  }

  private preflight(request: PrepareTicketExecutionRequest): void {
    if (!isAbsolute(request.workspace.directory)) throw new TicketError('Ticket workspace directory must be absolute', 'TICKET_INVALID_INPUT')
    if (request.workspace.kind === 'shared-workspace' && request.workspace.baseCommit === undefined) throw new TicketError('Shared Ticket workspace requires its immutable base commit', 'TICKET_INVALID_INPUT')
    if (request.executor.kind === 'in-process') return
    const provider = this.ctx.subagents.getProvider(request.executor.provider)
    if (provider === undefined) throw new TicketError('Ticket execution provider is not registered', 'TICKET_INVALID_INPUT')
    if (provider.execution?.kind !== request.executor.kind) throw new TicketError('Ticket execution provider does not support the requested placement', 'TICKET_INVALID_INPUT')
    if (request.executor.kind === 'remote' && (provider.execution.kind !== 'remote' || provider.execution.world !== request.executor.world)) {
      throw new TicketError('Ticket execution provider does not match the requested remote world', 'TICKET_INVALID_INPUT')
    }
    if (request.modelSelection !== undefined && !provider.capabilities.agentOptions) throw new TicketError('Ticket execution provider cannot select agent model options', 'TICKET_INVALID_INPUT')
  }

  /** Run one preparation with the caller signal attached until it publishes or rejects. */
  private async drive(
    run: AttemptRun, root: Session, assignment: AssignmentSnapshot, request: PrepareTicketExecutionRequest,
  ): Promise<TicketExecutionHandle> {
    const signal = request.signal
    const abort = () => { this.apply(run, { type: 'caller-abort', reason: asError(signal?.reason, 'Ticket execution preparation was cancelled') }) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const recorder = await this.admit(run, root, assignment, request)
      let handle: TicketExecutionHandle | undefined
      try { handle = await this.advance(run, root, assignment, request, recorder) } catch (error: unknown) {
        // The phase names the stage that failed.
        switch (run.state.kind) {
          case 'worktree': this.apply(run, { type: 'effect-failed' }); return await this.uncertain(run, error, recorder)
          case 'activating':
            if (rollbackFailed(error)) {
              this.apply(run, { type: 'effect-failed' })
              return await this.uncertain(run, error, recorder)
            }
            this.apply(run, { type: 'effect-refused' })
            break
          case 'preparing':
          case 'launched': this.apply(run, { type: 'stage-failed' }); break
          default: break
        }
        return await this.ended(run, error)
      }
      return handle ?? await this.ended(run)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  /** Admit the durable attempt; an admission whose flush failed stays `unflushed` for an identical retry. The run enters
   * `preparing` when the admission is appended, but nothing after it starts before the admission is durable.
   * Each retry must receive a recorder from its own beginAttempt call before preparation continues. */
  private async admit(
    run: AttemptRun, root: Session, assignment: AssignmentSnapshot, request: PrepareTicketExecutionRequest,
  ): Promise<TicketAttemptController> {
    let recorder: TicketAttemptController | undefined
    try {
      const technicalRoot = this.ctx.agents.get(root.id)
      if (technicalRoot === undefined) throw new TicketError('Ticket technical root Agent is not live', 'TICKET_AUTHORITY')
      if (request.executor.kind === 'in-process') {
        const worker = this.ctx.agents.get(assignment.ownerId)
        if (worker === undefined) throw new TicketError('In-process Ticket execution requires a live assigned worker', 'TICKET_AUTHORITY')
        run.worker = worker
      }
      if (request.workspace.kind === 'isolated-worktree' || run.worker !== undefined) {
        const directory = await this.ctx.workingDirectory.ensure(run.worker ?? run.caller, run.lifetime.signal)
        if (directory !== request.workspace.directory) throw new TicketError('Ticket workspace differs from the live worker directory', 'TICKET_INVALID_INPUT')
      }
      this.assertCaller(run.caller)
      if (isAborted(run.state)) throw run.abortReason as Error
      await this.ctx.agents.withInitiator(run.caller, () => this.ctx.tickets.beginAttempt(this.liveRoot(request.rootSessionId), {
        ticketId: request.ticketId, expectedRevision: request.expectedRevision, actorId: run.caller.id,
        assignmentId: request.assignmentId, attemptId: request.attemptId, operationId: request.operationId,
        workspace: request.workspace, executor: request.executor,
        ...request.assignmentRevision === undefined ? {} : { assignmentRevision: request.assignmentRevision },
        ...request.modelSelection === undefined ? {} : { modelSelection: request.modelSelection },
      }, (controller) => {
        // The admission is in the in-memory log: from here an abort hands the attempt to the ledger, behind this write.
        recorder = controller
        run.recorder = controller
        this.retain(run)
        this.apply(run, { type: 'admitted' })
      }))
    } catch (error: unknown) {
      if (recorder === undefined) {
        this.apply(run, { type: 'admission-refused' })
        throw error
      }
      if (this.apply(run, { type: 'admission-unflushed' }).kind === 'handed') return await this.ended(run, error)
      throw error
    }
    return this.withRecorder(recorder, 'Ticket admission did not grant an execution recorder', controller => Promise.resolve(controller))
      .catch((error: unknown) => { this.apply(run, { type: 'admission-refused' }); throw error })
  }

  /** Record workspace and runtime facts, then publish; returns undefined when a transition ended the preparation. */
  private async advance(
    run: AttemptRun, root: Session, assignment: AssignmentSnapshot, request: PrepareTicketExecutionRequest,
    recorder: TicketAttemptController,
  ): Promise<TicketExecutionHandle | undefined> {
    if (run.state.kind !== 'preparing') return undefined
    const technicalRoot = this.ctx.agents.get(root.id)
    if (technicalRoot === undefined) throw new TicketError('Ticket technical root Agent is not live', 'TICKET_AUTHORITY')
    if (request.workspace.kind === 'isolated-worktree') {
      this.apply(run, { type: 'worktree-start' })
      const worktree = await this.ctx.worktrees.create(run.worker ?? run.caller, {
        name: request.worktreeName ?? request.attemptId,
        ...request.workspace.baseCommit === undefined ? {} : { from: request.workspace.baseCommit },
      }, run.lifetime.signal)
      run.workspace = { directory: worktree.path, baseCommit: worktree.baseCommit, worktree }
      if (this.apply(run, { type: 'effect-established' }).kind !== 'preparing') return undefined
    } else {
      if (request.workspace.baseCommit === undefined) throw new TicketError('Ticket shared workspace requires a baseCommit receipt', 'TICKET_INVALID_INPUT')
      run.workspace = { directory: request.workspace.directory, baseCommit: request.workspace.baseCommit }
    }
    const workspace = run.workspace
    await recorder.update('workspace', { status: 'running', workspaceReceipt: workspace })
    // An abort during a receipt write handed the attempt to the ledger.
    if (isTerminal(run.state)) return undefined
    this.assertOwners(run.caller, technicalRoot, run.worker)
    if (request.executor.kind !== 'in-process') {
      this.apply(run, { type: 'activation-start' })
      const activation = await this.ctx.subagents.startActivation({
        provider: request.executor.provider,
        label: assignment.subject,
        request: {
          parent: technicalRoot,
          cwd: workspace.directory,
          prompt: [{ type: 'text', text: assignment.instructions || assignment.subject }],
          ...request.modelSelection === undefined ? {}
            : { agentOptions: { provider: request.modelSelection.provider, model: request.modelSelection.model } },
        },
        delivery: 'caller',
        signal: run.lifetime.signal,
      })
      run.activation = activation
      // A rejected capture remains observable through the returned result without an unhandled rejection.
      void activation.result.catch(() => {})
      if (this.apply(run, { type: 'effect-established' }).kind !== 'launched') return undefined
    }
    await recorder.update('runtime', { status: 'running', runtimeReceipt: {
      runtimeId: run.activation?.childId ?? assignment.ownerId,
      providerId: request.executor.kind === 'in-process' ? 'in-process' : request.executor.provider,
      childSessionId: run.activation?.childId ?? assignment.ownerId,
      ...request.executor.kind === 'remote' ? { world: request.executor.world } : {},
    } })
    if (isTerminal(run.state)) return undefined
    const ticket = this.ctx.tickets.get(this.liveRoot(root.id), request.ticketId)
    const attempt = ticket.attempts.find(item => item.id === request.attemptId)
    const nextAssignment = ticket.assignments.find(item => item.id === assignment.id)
    if (attempt === undefined || nextAssignment === undefined) throw new TicketError('Ticket execution lost its committed attempt', 'TICKET_RECOVERY_FAILED')
    if (this.apply(run, { type: 'publish' }).kind !== 'running') return undefined
    const activation = run.activation
    return {
      ticket, assignment: nextAssignment, attempt, workspace,
      ...activation === undefined ? {} : { activation, result: activation.result },
      get jobs() { return [...run.jobs] },
      startJob: (label, producer, jobSignal) => this.startJob(run, recorder, label, producer, jobSignal),
      settle: () => this.request(run, { type: 'settle' }),
      dispose: () => this.request(run, { type: 'dispose' }),
    }
  }

  /** Reject a preparation the state machine ended, once its stop and the ledger's write have finished. Entry starts the
   * callers' bound; a rejection after that bound passes reaches the late-failure log instead. */
  private async ended(run: AttemptRun, error?: unknown): Promise<never> {
    const cause = asError(error ?? run.abortReason ?? new TicketError('Ticket execution preparation was cancelled', 'TICKET_ATTEMPT_STATE'), 'Ticket preparation failed')
    run.failure = cause
    run.bound?.arm()
    const failures: unknown[] = [cause]
    // A stop that hands the outcome over rejects only with the ledger write's own failure or its deadline; the write's result,
    // awaited below, reports the former and supersedes the latter.
    if (run.stop !== undefined) await run.stop.catch((stop: unknown) => { if (run.state.kind !== 'handed') failures.push(stop) })
    const state = run.state
    if (state.kind !== 'handed') throw new AggregateError(failures, 'Ticket execution preparation is unknown; reservation retained')
    try { await run.settlement } catch (recording: unknown) {
      const started = run.activation === undefined ? 'before a producer started' : 'after stopping its activation'
      throw new AggregateError([cause, recording], `Ticket preparation ended ${started}; its ${state.outcome} settlement write failed `
        + 'and is completed by the next write to its root, a resume of that root, or Ticket teardown')
    }
    throw cause
  }

  /** A provider failed after it may have left a checkout or a live child: the attempt stays reserved for host reconciliation. */
  private async uncertain(run: AttemptRun, error: unknown, recorder: TicketAttemptController): Promise<never> {
    run.failure = asError(error, 'Ticket preparation failed')
    run.bound?.arm()
    const failures: unknown[] = [error]
    try {
      await recorder.update('preparation-unknown', {
        status: 'unknown', ...run.workspace === undefined ? {} : { workspaceReceipt: run.workspace },
        diagnostics: ['Preparation did not establish a recoverable live execution handle; retained resources require reconciliation'],
      })
    } catch (failure: unknown) { failures.push(failure) }
    throw new AggregateError(failures, 'Ticket execution preparation is unknown; reservation retained')
  }

  /** `settle()` and `dispose()` of a published handle. */
  private request(run: AttemptRun, event: Extract<AttemptEvent, { type: 'settle' | 'dispose' }>): Promise<void> {
    let next: Extract<AttemptState, { kind: 'stopping' | 'handed' }>
    try { next = this.apply(run, event) } catch (error: unknown) { return Promise.reject(asError(error, 'Ticket attempt request failed')) }
    if (next.kind === 'stopping') return run.stop as Promise<void>
    // A repeated request asks the ledger to write the outcome it holds again.
    const settlement = this.handOff(run, next.outcome)
    const deadline = this.deadline()
    return this.awaitDurable(run, settlement, deadline, next.outcome).finally(() => { deadline.clear() })
  }

  private startJob(
    run: AttemptRun, recorder: TicketAttemptController, label: string, start: (job: JobHandle) => JobHooks, signal?: AbortSignal,
  ): Promise<JobId> {
    if (run.state.kind !== 'running' || this.closing) return Promise.reject(new TicketError('Ticket execution handle is closing', 'TICKET_ATTEMPT_STATE'))
    const operation = run.queue.then(async () => {
      if (run.state.kind !== 'running') throw new TicketError('Ticket execution handle is closing', 'TICKET_ATTEMPT_STATE')
      this.assertCaller(run.caller)
      signal?.throwIfAborted()
      const { ticketId, attemptId } = run
      const ticket = this.ctx.tickets.get(this.liveRoot(run.rootId), ticketId)
      const attempt = ticket.attempts.find(item => item.id === attemptId)
      if (ticket.terminalOutcome !== undefined || attempt?.status !== 'running') throw new TicketError('Ticket attempt cannot start background work', 'TICKET_ATTEMPT_STATE')
      const done = Promise.withResolvers<JobOutcome>()
      const producer: { hooks?: JobHooks; job?: JobHandle; cancelled: boolean; reason?: string } = { cancelled: false }
      const id = this.ctx.jobs.start({ kind: 'ticket', label, owner: run.caller.id,
        run: (job) => {
          producer.job = job
          return {
            cancel(message) {
              producer.cancelled = true
              if (message !== undefined) producer.reason = message
              producer.hooks?.cancel(message)
            },
            done: done.promise,
          }
        },
      })
      run.jobs.push(id)
      const entry: Producer = {
        finished: false,
        cancel: (reason) => {
          if (entry.finished) return
          // A terminal or removed registry record says nothing about the producer, so the request then goes to it directly.
          const record = this.ctx.jobs.list(run.caller.id).find(job => job.id === id)
          if (record?.status === 'running' || record?.status === 'stopping') this.ctx.jobs.kill(id, run.caller.id, reason)
          else {
            producer.cancelled = true
            producer.hooks?.cancel(reason)
          }
        },
        done: done.promise.then((result) => { entry.finished = true; return result }, (): JobOutcome => {
          entry.finished = true
          return { status: 'failed', detail: 'Ticket producer rejected' }
        }),
      }
      run.producers.set(id, entry)
      // Producer failure is awaited by stop even if its owner has already removed the Job record.
      void done.promise.catch(() => {})
      try {
        const current = this.ctx.tickets.get(this.liveRoot(run.rootId), ticketId)
        const receipt = current.attempts.find(item => item.id === attemptId)?.runtimeReceipt
        if (receipt === undefined) throw new TicketError('Job admission requires a runtime receipt', 'TICKET_ATTEMPT_STATE')
        await recorder.update('job-' + id, { status: 'running', runtimeReceipt: { ...receipt, jobIds: [...receipt.jobIds ?? [], id] } })
      } catch (error: unknown) {
        done.resolve({ status: 'failed', detail: 'Ticket job admission failed before its producer started' })
        throw error
      }
      // A stop that began while the receipt was being written starts no producer.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the receipt write awaits, during which a stop can begin.
      if (run.state.kind !== 'running' || signal?.aborted || producer.cancelled) {
        done.resolve({ status: 'killed' })
        return id
      }
      let hooks: JobHooks
      try {
        if (producer.job === undefined) throw new TicketError('Job registration did not supply its producer handle', 'TICKET_RECOVERY_FAILED')
        hooks = start(producer.job)
      } catch (error: unknown) {
        // Startup returned no hooks, so no producer handle exists to cancel or join.
        done.resolve({ status: 'failed', detail: 'Ticket producer startup failed' })
        throw error
      }
      producer.hooks = hooks
      // From here only the producer's own settlement settles this Job.
      void hooks.done.then(done.resolve, done.reject)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- producer startup can synchronously request cancellation.
      if (producer.cancelled) {
        try { hooks.cancel(producer.reason) } catch (error: unknown) {
          this.cancelFailed(run, error)
          throw error
        }
      }
      if (signal !== undefined) {
        // An AbortSignal listener has no caller to receive a throw, so a refused request becomes the attempt's `cancel-failed`.
        const cancel = () => {
          try { entry.cancel('Ticket execution caller cancelled') } catch (error: unknown) { this.cancelFailed(run, error) }
        }
        const cleanup = () => { signal.removeEventListener('abort', cancel); run.listeners.delete(cleanup) }
        run.listeners.add(cleanup)
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
        void done.promise.then(cleanup, cleanup)
      }
      return id
    })
    run.queue = operation.then(() => {}, () => {})
    return operation
  }

  /** A cancellation request that throws is a failed cancel, which never settles a producer. The attempt consumes it as
   * `cancel-failed`: inside a stop it fails that stop; otherwise the producer may keep running, and only its own settlement
   * signal, which `settle()`, `dispose()` and the retained reservation await, ends it. */
  private cancelFailed(run: AttemptRun, error: unknown): void {
    const failure = new TicketError(`A producer of Ticket attempt "${run.attemptId}" refused a cancellation request`,
      'TICKET_ATTEMPT_STATE', { cause: error })
    const next = this.apply(run, { type: 'cancel-failed' })
    if (next.kind === 'stopping') {
      run.stopFailure?.reject(failure)
      return
    }
    const disposition = 'the producer may still be running, so the attempt keeps its reservation until the producer settles; dispose() on its '
      + 'execution handle requests cancellation again'
    this.logger.warn(`${failure.message}; ${disposition}: ${String(error)}`)
  }

  /** Send one cancellation request to every unfinished producer. */
  private cancelProducers(run: AttemptRun): void {
    for (const producer of run.producers.values()) {
      try { producer.cancel('Ticket execution released') } catch (error: unknown) { this.cancelFailed(run, error) }
    }
    // The stop's observation reads the activation's release verdict from the same memoized disposal.
    if (run.activation !== undefined) void run.activation.dispose().catch(() => {})
    if (run.worker !== undefined) {
      const worker = run.worker
      void Promise.resolve().then(() => { worker.cancel({ kind: 'parent' }) }).catch((error: unknown) => { this.cancelFailed(run, error) })
    }
  }

  /** Observe every producer, then hand the outcome to the ledger. One deadline bounds the pending Job admission, the
   * observation and the uncertainty write; a failure applies `stop-failed` or `cleanup-failed` before that write starts. */
  private async stopRun(run: AttemptRun, failure: Promise<never>): Promise<void> {
    const deadline = this.deadline()
    try {
      const observation = this.observe(run)
      let outcome: AttemptOutcome
      try {
        outcome = await Promise.race([observation.settled, failure, deadline.expired])
      } catch (error: unknown) {
        const captured = observation.captured()
        const next = this.apply(run, captured === undefined ? { type: 'stop-failed' } : { type: 'cleanup-failed', outcome: captured })
        const stage: UncertaintyStage = captured === undefined ? 'stop-unknown' : 'cleanup-unknown'
        let recording: unknown
        try {
          await Promise.race([this.recordUncertainty(run, stage, next.captured), deadline.expired])
        } catch (cause: unknown) {
          if (cause !== deadline.reason) recording = cause
        }
        const message = captured === undefined
          ? 'Ticket producer settlement was not established; reservation retained'
          : `Ticket producers reported ${captured}, but releasing their resources was not confirmed; reservation retained`
        throw new TicketError(message, 'TICKET_ATTEMPT_STATE', {
          cause: recording === undefined ? error : new AggregateError([error, recording], 'The uncertainty record failed as well'),
        })
      }
      const handed = this.apply(run, { type: 'producers-settled', outcome })
      await this.awaitDurable(run, run.settlement, deadline, handed.outcome)
    } finally { deadline.clear() }
  }

  /** Wait for the ledger's write of a handed outcome within `deadline`, as {@link within} describes.
   * @param run - Attempt in `handed`.
   * @param settlement - The ledger write started by the hand-off.
   * @param deadline - The calling `settle()` or `dispose()` deadline.
   * @param outcome - Outcome handed to the settlement ledger.
   * @throws TicketError `TICKET_SETTLEMENT_PENDING` when the deadline passes first. */
  private async awaitDurable(
    run: AttemptRun, settlement: Promise<unknown> | undefined, deadline: Deadline, outcome: AttemptOutcome,
  ): Promise<void> {
    await this.within(Promise.resolve(settlement), deadline, () => {
      return new TicketError(`Ticket attempt "${run.attemptId}" ended ${outcome}, but its settlement record is not durable yet; `
        + 'the ledger keeps writing it, so retry settle() or dispose() once storage recovers', 'TICKET_SETTLEMENT_PENDING', {
        cause: new Error('Ticket settlement write did not become durable within settlementTimeoutMs'),
      })
    }, this.warn(`Ticket attempt "${run.attemptId}" outcome is known, but its settlement write failed after its deadline; the `
      + 'ledger retains it until its root is writable'))
  }

  /** The single bound on a caller-facing wait. At the deadline `work` keeps running under its owner: it is neither discarded
   * nor repeated here, and its late failure is logged.
   * @param work - Owned operation the caller waits on.
   * @param deadline - The caller's deadline; its creator clears it.
   * @param expired - Builds the rejection for a wait that reached the deadline.
   * @param late - Reports a failure of `work` after the deadline.
   * @returns The result of `work` when it settles before the deadline. */
  private async within<T>(work: Promise<T>, deadline: Deadline, expired: () => Error, late: (failure: unknown) => void): Promise<T> {
    try {
      return await Promise.race([work, deadline.expired])
    } catch (error: unknown) {
      if (error !== deadline.reason) throw error
      void work.catch(late)
      throw expired()
    }
  }

  /** A logger callback for {@link within}.
   * @param message - Text before the failure. */
  private warn(message: string): (failure: unknown) => void {
    const { logger } = this
    return (failure) => { logger.warn(`${message}: ${String(failure)}`) }
  }

  /** The rejection of a preparation whose callers' bound passed before it finished. The step still running holds the
   * reservation, and nothing the caller can retry would finish it sooner. */
  private unfinished(run: AttemptRun): AggregateError {
    // The bound is armed only by an abort or a failure, which set one of these before it can expire.
    const cause = run.failure ?? run.abortReason
    const state = run.state
    const step = state.kind === 'handed'
      ? `ended ${state.outcome}; the settlement ledger is still writing its record and keeps its work scopes reserved until that write completes`
      : `is still in its ${state.kind} step, which holds the reservation until the attempt is recorded as settled or unknown`
    const pending = new TicketError(`Ticket attempt "${run.attemptId}" ${step}`, 'TICKET_SETTLEMENT_PENDING', {
      cause: new Error('Ticket preparation did not finish within settlementTimeoutMs'),
    })
    return new AggregateError([cause, pending].filter(item => item !== undefined), 'Ticket preparation was stopped and did not finish within settlementTimeoutMs; '
      + 'Ticket completes its remaining write without a retry')
  }

  /** Each producer's own signals: results first, then the activation's release, which may follow its captured result. */
  private observe(run: AttemptRun): { readonly settled: Promise<AttemptOutcome>; captured(): AttemptOutcome | undefined } {
    let captured: AttemptOutcome | undefined
    const settled = (async () => {
      await run.queue
      let outcome: AttemptOutcome = 'succeeded'
      const activation = run.activation
      if (activation !== undefined) {
        const result = await activation.result
        if (result.stopReason !== 'completed') outcome = result.stopReason === 'aborted' ? 'cancelled' : 'failed'
      }
      if (run.worker !== undefined) await run.worker.whenIdle()
      for (const producer of run.producers.values()) {
        const result = await producer.done
        if (result.status === 'failed') outcome = 'failed'
        else if (result.status === 'killed' && outcome !== 'failed') outcome = 'cancelled'
      }
      captured = outcome
      if (activation !== undefined) await activation.dispose()
      return outcome
    })()
    void settled.catch(() => {})
    return { settled, captured: () => captured }
  }

  /** Write one uncertainty stage; a failure while the same write is pending joins it. A failed write is logged here because
   * a stop past its deadline no longer awaits it. */
  private recordUncertainty(run: AttemptRun, stage: UncertaintyStage, captured: AttemptOutcome | undefined): Promise<void> {
    const pending = run.recordings.get(stage)
    if (pending !== undefined) return pending
    return this.withRecorder(run.recorder, 'Ticket attempt has no admission to record', (recorder) => {
      const write = recorder.update(stage, { status: 'unknown', diagnostics: [uncertaintyDiagnostic(stage, captured)] }).then(() => {})
      run.recordings.set(stage, write)
      const { logger } = this
      void write.then(() => { run.recordings.delete(stage) }, (error: unknown) => {
        run.recordings.delete(stage)
        logger.warn(`Ticket attempt "${run.attemptId}" is unknown in memory, but recording it failed; the reservation is retained: ${String(error)}`)
      })
      return write
    })
  }

  private liveRoot(id: Session['id']): Session {
    const root = this.ctx.sessions.get(id)
    if (root === undefined) throw new TicketError(`Ticket root Session "${id}" is not live; resume it, then retry`, 'TICKET_ROOT_UNAVAILABLE')
    return root
  }

  /** One settlement deadline; `expired` rejects with `reason` once `settlementTimeoutMs` passes after it is armed.
   * @param message - Text of `reason`.
   * @param armed - Whether the timer starts now rather than at `arm()`. */
  private deadline(message = 'Ticket producer settlement timed out', armed = true): Deadline {
    const reason = new TicketError(message, 'TICKET_ATTEMPT_STATE')
    const expiry = Promise.withResolvers<never>()
    void expiry.promise.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    // Set by the first `arm()` or by `clear()`; a cleared deadline never starts.
    let started = false
    const deadline: Deadline = {
      expired: expiry.promise,
      reason,
      arm: () => {
        if (started) return
        started = true
        timer = setTimeout(() => { expiry.reject(reason) }, this.config.settlementTimeoutMs)
      },
      clear: () => {
        started = true
        clearTimeout(timer)
      },
    }
    if (armed) deadline.arm()
    return deadline
  }
}

export default TicketExecutionService
