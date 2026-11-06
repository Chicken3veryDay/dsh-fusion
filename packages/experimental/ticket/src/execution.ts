/** Durable Ticket attempt ownership over managed activations and background Jobs. */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHandle, JobHooks, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import {
  type AttemptEvent, type AttemptOutcome, type AttemptState, isAborted, isTerminal, transitionAttempt,
} from './attempt-lifecycle.ts'
import { TicketError } from './errors.ts'
import {
  type AssignmentSnapshot, type BeginTicketAttemptRequest, type TicketAttemptSnapshot,
  type TicketView, type TicketWorkspaceReceipt, type TicketAttemptController,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { ticketExecution: TicketExecutionService }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { ticket: 'ticket' }
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
  /** Await natural producer completion and hand the observed outcome to the settlement ledger. */
  settle(): Promise<void>
  /** Request cancellation and await all producers before settling the attempt; a retry after a failed stop cancels again. */
  dispose(): Promise<void>
}

interface Producer {
  cancel(): void
  readonly done: Promise<JobOutcome>
  finished: boolean
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
  /** Aborted exactly when the state becomes aborted; effects of preparation observe only this signal. */
  readonly lifetime: AbortController
  state: AttemptState
  abortReason?: Error
  /** The preparation callers join; an identical retry of an `unflushed` admission replaces it. */
  preparation?: Promise<TicketExecutionHandle>
  recorder?: TicketAttemptController
  worker?: Agent
  workspace?: TicketWorkspaceReceipt
  activation?: SubagentActivation
  readonly jobs: JobId[]
  readonly producers: Map<JobId, Producer>
  readonly listeners: Set<() => void>
  /** Serializes Job admissions; a stop starts after the pending admission. */
  queue: Promise<void>
  /** The stop that entered `stopping` most recently. */
  stop?: Promise<void>
  /** Rejected by a failed cancellation request during the current stop. */
  stopFailure?: PromiseWithResolvers<never>
  /** The settlement ledger's write for the outcome handed over on entry to `handed`. */
  settlement?: Promise<unknown>
}

const runKey = (rootId: Session['id'], request: Pick<PrepareTicketExecutionRequest, 'ticketId' | 'assignmentId'>) =>
  JSON.stringify([rootId, request.ticketId, request.assignmentId])

const asError = (value: unknown, message: string): Error => value instanceof Error ? value : new Error(message, { cause: value })

/** Serializes attempt admission, retains uncertain resources, and waits for producer settlement. */
export class TicketExecutionService extends Service {
  static inject = ['tickets', 'jobs', 'worktrees', 'sessions', 'agents', 'subagents', 'workingDirectory']
  /** Execution reservations: one live run per root, Ticket and assignment, from creation until it is handed or released. */
  private readonly runs = new Map<string, AttemptRun>()
  private closing = false

  constructor(ctx: Context, private readonly config: TicketExecutionConfig) {
    super(ctx, 'ticketExecution')
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
    this.ctx.effect(() => this.ctx.tickets.registerAdmissionGuard((reserved) => { this.assertNoOrphanJobs(reserved) }),
      'ticket-execution.admission-guard()')
    this.ctx.effect(() => async () => {
      this.closing = true
      const runs = [...this.runs.values()]
      const reason = new TicketError('Ticket execution admission is closed', 'TICKET_ATTEMPT_STATE')
      for (const run of runs) this.apply(run, { type: 'teardown' }, reason)
      await Promise.allSettled(runs.flatMap(run => run.preparation === undefined ? [] : [run.preparation]))
      const results = await Promise.allSettled(runs.map(async (run) => {
        if (run.state.kind === 'stopping') await run.stop
        if (run.state.kind === 'handed') {
          await run.settlement?.catch((error: unknown) => {
            this.ctx.logger.warn(`Ticket attempt ended ${run.state.kind === 'handed' ? run.state.outcome : ''}; the settlement ledger `
              + `retains it until its root is writable: ${String(error)}`)
          })
        }
      }))
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Ticket execution teardown did not settle')
    }, 'ticket-execution.runtime()')
  }

  /** Prepare or return the exact live attempt; recovered attempts cannot replay effects.
   * @param caller - Exact registered owner or current coordinator.
   * @param request - Stable operation and attempt ids, CAS, and explicit placement.
   * @returns The single resource handle retained for this preparation.
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
          if (resumed || retained.preparation === undefined) retained.preparation = this.drive(retained, root, assignment, request)
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
      const run: AttemptRun = {
        key, caller, rootId: root.id, ownerId: assignment.ownerId, ticketId: request.ticketId, attemptId: request.attemptId,
        fingerprint, lifetime: new AbortController(), state: { kind: 'admitting', aborted: false },
        jobs: [], producers: new Map(), listeners: new Set(), queue: Promise.resolve(),
      }
      this.runs.set(key, run)
      const preparation = this.drive(run, root, assignment, request)
      run.preparation = preparation
      return preparation
    } catch (error: unknown) {
      return Promise.reject(asError(error, 'Ticket execution preparation failed'))
    }
  }

  /** The only writer of attempt state: applies one event through {@link transitionAttempt} and runs the entry actions of
   * the new state. Reservation release, the ledger hand-off and each cancellation request happen here and nowhere else. */
  private apply(run: AttemptRun, event: AttemptEvent, reason?: Error): AttemptState {
    const previous = run.state
    const next = transitionAttempt(previous, event)
    if ('reason' in next) throw new TicketError(next.reason, 'TICKET_ATTEMPT_STATE')
    run.state = next
    if (isAborted(next) && !isAborted(previous)) {
      run.abortReason ??= reason ?? new TicketError('Ticket execution preparation was cancelled', 'TICKET_ATTEMPT_STATE')
      run.lifetime.abort(run.abortReason)
    }
    if (next.kind === 'stopping') {
      if (previous.kind !== 'stopping') {
        run.stopFailure = Promise.withResolvers()
        void run.stopFailure.promise.catch(() => {})
        run.stop = this.stopRun(run)
        void run.stop.catch(() => {})
      }
      // Each entry to the cancel intent sends a fresh cancellation request to every producer that has not finished.
      if (next.cancel && !(previous.kind === 'stopping' && previous.cancel)) this.cancelProducers(run)
    }
    if (isTerminal(next) && !isTerminal(previous)) {
      if (this.runs.get(run.key) === run) this.runs.delete(run.key)
      for (const cleanup of run.listeners) cleanup()
      if (next.kind === 'handed') run.settlement = this.handOff(run, next.outcome)
    }
    return next
  }

  /** Apply an event raised outside any caller and report a stop or hand-off it starts. */
  private raise(run: AttemptRun, event: AttemptEvent, warning: string, reason: Error): void {
    const previous = run.state
    const next = this.apply(run, event, reason)
    const report = (error: unknown) => { this.ctx.logger.warn(`${warning}: ${String(error)}`) }
    if (next.kind === 'stopping' && previous.kind !== 'stopping') void run.stop?.catch(report)
    if (next.kind === 'handed' && previous.kind !== 'handed') void run.settlement?.catch(report)
  }

  /** The ledger takes the outcome synchronously, before any write that can fail, with the known workspace receipt. */
  private handOff(run: AttemptRun, outcome: AttemptOutcome): Promise<unknown> {
    const recorder = run.recorder
    if (recorder === undefined) return Promise.reject(new TicketError('Ticket attempt reached the ledger without an admission', 'TICKET_RECOVERY_FAILED'))
    const settlement = recorder.settle(outcome, run.workspace === undefined ? undefined : { workspaceReceipt: run.workspace })
    void settlement.catch(() => {})
    return settlement
  }

  /** A shared-workspace admission is refused while a live Ticket Job has no reservation that accounts for it. */
  private assertNoOrphanJobs(reserved: readonly TicketAttemptSnapshot[]): void {
    const accounted = new Set<string>(reserved.flatMap(attempt => attempt.runtimeReceipt?.jobIds ?? []))
    for (const run of this.runs.values()) for (const id of run.jobs) accounted.add(id)
    const live = new Map<string, string>()
    for (const owner of [undefined, ...this.ctx.sessions.list().map(session => session.id)]) {
      for (const job of this.ctx.jobs.list(owner)) {
        if (job.kind === 'ticket' && (job.status === 'running' || job.status === 'stopping') && !accounted.has(job.id)) live.set(job.id, job.label)
      }
    }
    if (live.size === 0) return
    const jobs = [...live.keys()].map(id => `"${id}"`).join(', ')
    throw new TicketError(`Ticket Job ${jobs} is still running without a known work-scope reservation, so shared-workspace admission `
      + 'cannot exclude its writes; wait for it to finish or stop it, then retry', 'TICKET_ATTEMPT_STATE')
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
    const abort = () => { this.apply(run, { type: 'caller-abort' }, asError(signal?.reason, 'Ticket execution preparation was cancelled')) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.admit(run, root, assignment, request)
      let handle: TicketExecutionHandle | undefined
      try { handle = await this.advance(run, root, assignment, request) } catch (error: unknown) {
        // The phase names the stage that failed.
        switch (run.state.kind) {
          case 'worktree': this.apply(run, { type: 'effect-failed' }); return await this.uncertain(run, error)
          case 'activating': this.apply(run, { type: 'effect-failed' }); break
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

  /** Admit the durable attempt; an admission whose flush failed stays `unflushed` for an identical retry. */
  private async admit(
    run: AttemptRun, root: Session, assignment: AssignmentSnapshot, request: PrepareTicketExecutionRequest,
  ): Promise<void> {
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
      if (isAborted(run.state)) throw run.abortReason ?? new TicketError('Ticket execution preparation was cancelled', 'TICKET_ATTEMPT_STATE')
      await this.ctx.agents.withInitiator(run.caller, () => this.ctx.tickets.beginAttempt(this.liveRoot(request.rootSessionId), {
        ticketId: request.ticketId, expectedRevision: request.expectedRevision, actorId: run.caller.id,
        assignmentId: request.assignmentId, attemptId: request.attemptId, operationId: request.operationId,
        workspace: request.workspace, executor: request.executor,
        ...request.assignmentRevision === undefined ? {} : { assignmentRevision: request.assignmentRevision },
        ...request.modelSelection === undefined ? {} : { modelSelection: request.modelSelection },
      }, (controller) => { recorder = controller }))
    } catch (error: unknown) {
      if (recorder === undefined) {
        this.apply(run, { type: 'admission-refused' })
        throw error
      }
      run.recorder = recorder
      if (this.apply(run, { type: 'admission-unflushed' }).kind === 'handed') {
        await run.settlement?.catch((recording: unknown) => {
          this.ctx.logger.warn(`Ticket admission without a producer was ended as cancelled, but its settlement is not durable yet: ${String(recording)}`)
        })
      }
      throw error
    }
    if (recorder === undefined) {
      this.apply(run, { type: 'admission-refused' })
      throw new TicketError('Ticket admission did not grant an execution recorder', 'TICKET_RECOVERY_FAILED')
    }
    run.recorder = recorder
    this.apply(run, { type: 'admitted' })
  }

  /** Record workspace and runtime facts, then publish; returns undefined when a transition ended the preparation. */
  private async advance(
    run: AttemptRun, root: Session, assignment: AssignmentSnapshot, request: PrepareTicketExecutionRequest,
  ): Promise<TicketExecutionHandle | undefined> {
    const recorder = run.recorder
    if (run.state.kind !== 'preparing' || recorder === undefined) return undefined
    const technicalRoot = this.ctx.agents.get(root.id)
    if (technicalRoot === undefined) throw new TicketError('Ticket technical root Agent is not live', 'TICKET_AUTHORITY')
    if (request.workspace.kind === 'isolated-worktree') {
      if (this.apply(run, { type: 'worktree-start' }).kind !== 'worktree') return undefined
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
    this.assertOwners(run.caller, technicalRoot, run.worker)
    if (request.executor.kind !== 'in-process') {
      if (this.apply(run, { type: 'activation-start' }).kind !== 'activating') return undefined
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
      startJob: (label, producer, jobSignal) => this.startJob(run, label, producer, jobSignal),
      settle: () => this.request(run, { type: 'settle' }),
      dispose: () => this.request(run, { type: 'dispose' }),
    }
  }

  /** Reject a preparation the state machine ended, once its stop and ledger hand-off have run. */
  private async ended(run: AttemptRun, error?: unknown): Promise<never> {
    const cause = asError(error ?? run.abortReason ?? new TicketError('Ticket execution preparation was cancelled', 'TICKET_ATTEMPT_STATE'), 'Ticket preparation failed')
    const failures: unknown[] = [cause]
    if (run.state.kind === 'stopping') {
      try { await run.stop } catch (stop: unknown) { failures.push(stop) }
    }
    const state = run.state
    if (state.kind === 'handed') {
      try { await run.settlement } catch (recording: unknown) { failures.push(recording) }
      if (failures.length === 1) throw cause
      const started = run.activation === undefined ? 'before a producer started' : 'after stopping its activation'
      throw new AggregateError(failures, `Ticket preparation ended ${started}; its ${state.outcome} settlement is not durable yet and is `
        + 'completed by the next write to its root, a resume of that root, or Ticket teardown')
    }
    throw new AggregateError(failures, 'Ticket execution preparation is unknown; reservation retained')
  }

  /** A Worktree provider failed after it may have created the checkout: the attempt stays reserved for host reconciliation. */
  private async uncertain(run: AttemptRun, error: unknown): Promise<never> {
    const failures: unknown[] = [error]
    try {
      await run.recorder?.update('preparation-unknown', {
        status: 'unknown', ...run.workspace === undefined ? {} : { workspaceReceipt: run.workspace },
        diagnostics: ['Preparation did not establish a recoverable live execution handle; retained resources require reconciliation'],
      })
    } catch (recording: unknown) { failures.push(recording) }
    throw new AggregateError(failures, 'Ticket execution preparation is unknown; reservation retained')
  }

  /** `settle()` and `dispose()` of a published handle. */
  private request(run: AttemptRun, event: Extract<AttemptEvent, { type: 'settle' | 'dispose' }>): Promise<void> {
    const previous = run.state
    let next: AttemptState
    try { next = this.apply(run, event) } catch (error: unknown) { return Promise.reject(asError(error, 'Ticket attempt request failed')) }
    if (next.kind === 'stopping') return run.stop ?? Promise.reject(new TicketError('Ticket attempt stop was not started', 'TICKET_RECOVERY_FAILED'))
    if (next.kind === 'handed') {
      // A repeated request asks the ledger to write the outcome it holds again.
      const settlement = previous.kind === 'handed' ? this.handOff(run, next.outcome) : run.settlement
      return (settlement ?? Promise.resolve()).then(() => {})
    }
    return Promise.reject(new TicketError(`Ticket attempt in ${next.kind} has no stop to await`, 'TICKET_ATTEMPT_STATE'))
  }

  private startJob(run: AttemptRun, label: string, start: (job: JobHandle) => JobHooks, signal?: AbortSignal): Promise<JobId> {
    if (run.state.kind !== 'running' || this.closing) return Promise.reject(new TicketError('Ticket execution handle is closing', 'TICKET_ATTEMPT_STATE'))
    const recorder = run.recorder
    if (recorder === undefined) return Promise.reject(new TicketError('Ticket execution handle has no recorder', 'TICKET_RECOVERY_FAILED'))
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
        cancel: () => {
          if (entry.finished) return
          if (this.ctx.jobs.list(run.caller.id).some(job => job.id === id)) this.ctx.jobs.kill(id, run.caller.id, 'Ticket execution released')
          else {
            producer.cancelled = true
            producer.hooks?.cancel('Ticket execution released')
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
        if (signal?.aborted || producer.cancelled) {
          done.resolve({ status: 'killed' })
        } else {
          if (producer.job === undefined) throw new TicketError('Job registration did not supply its producer handle', 'TICKET_RECOVERY_FAILED')
          producer.hooks = start(producer.job)
          void producer.hooks.done.then(done.resolve, done.reject)
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- producer startup can synchronously request cancellation.
          if (producer.cancelled) producer.hooks.cancel(producer.reason)
        }
      } catch (error: unknown) {
        done.resolve({ status: 'failed', detail: 'Ticket job admission or producer startup failed' })
        throw error
      }
      if (signal !== undefined) {
        const cancel = () => this.ctx.jobs.kill(id, run.caller.id, 'Ticket execution caller cancelled')
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

  /** Send one cancellation request to every unfinished producer; a failed request fails the current stop. */
  private cancelProducers(run: AttemptRun): void {
    const fail = (error: unknown) => { run.stopFailure?.reject(asError(error, 'Ticket producer cancellation failed')) }
    for (const producer of run.producers.values()) {
      if (producer.finished) continue
      try { producer.cancel() } catch (error: unknown) { fail(error) }
    }
    if (run.activation !== undefined) run.activation.dispose().catch(fail)
    else if (run.worker !== undefined) {
      const worker = run.worker
      void Promise.resolve().then(() => { worker.cancel({ kind: 'parent' }) }).catch(fail)
    }
  }

  /** Observe every producer, then hand the outcome to the ledger; a failed observation records `unknown` and keeps the run. */
  private async stopRun(run: AttemptRun): Promise<void> {
    await run.queue
    const failure = run.stopFailure?.promise ?? new Promise<never>(() => {})
    let outcome: AttemptOutcome
    try {
      outcome = await this.bounded(Promise.race([this.observeProducers(run), failure]))
    } catch (error: unknown) {
      let recording: unknown
      try {
        await run.recorder?.update('stop-unknown', {
          status: 'unknown', diagnostics: ['Cancellation did not establish producer settlement; reservation retained'],
        })
      } catch (cause: unknown) { recording = cause }
      this.apply(run, { type: 'stop-failed' })
      if (recording !== undefined) throw new AggregateError([error, recording], 'Ticket producer settlement and uncertainty recording failed; reservation retained')
      throw error
    }
    this.apply(run, { type: 'producers-settled', outcome })
    await run.settlement
  }

  private async observeProducers(run: AttemptRun): Promise<AttemptOutcome> {
    let outcome: AttemptOutcome = 'succeeded'
    if (run.activation !== undefined) {
      const result = await run.activation.result
      if (result.stopReason !== 'completed') outcome = result.stopReason === 'aborted' ? 'cancelled' : 'failed'
    } else if (run.worker !== undefined) await run.worker.whenIdle()
    for (const producer of run.producers.values()) {
      const result = await producer.done
      if (result.status === 'failed') outcome = 'failed'
      else if (result.status === 'killed' && outcome !== 'failed') outcome = 'cancelled'
    }
    return outcome
  }

  private liveRoot(id: Session['id']): Session {
    const root = this.ctx.sessions.get(id)
    if (root === undefined) throw new TicketError(`Ticket root Session "${id}" is not live; resume it, then retry`, 'TICKET_ROOT_UNAVAILABLE')
    return root
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new TicketError('Ticket producer settlement timed out', 'TICKET_ATTEMPT_STATE')) }, this.config.settlementTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
}

export default TicketExecutionService
