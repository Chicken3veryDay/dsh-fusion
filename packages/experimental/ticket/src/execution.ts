/** Durable Ticket attempt ownership over managed activations and background Jobs. */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHandle, JobHooks, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { TicketError } from './errors.ts'
import {
  type AssignmentSnapshot, type BeginTicketAttemptRequest, type TicketAttemptSnapshot,
  type TicketView, type TicketWorkspaceReceipt, type UpdateTicketAttemptRequest, type TicketAttemptController,
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
  /** Await natural producer completion and retain its observed outcome. */
  settle(): Promise<void>
  /** Request cancellation and await all producers before settling the attempt. */
  dispose(): Promise<void>
}

interface Reservation {
  readonly caller: Agent
  readonly fingerprint: string
  readonly preparation: Promise<TicketExecutionHandle>
}

interface LiveHandle {
  readonly root: Session
  readonly caller: Agent
  readonly worker: Agent | undefined
  readonly request: PrepareTicketExecutionRequest
  readonly workspace: TicketExecutionWorkspace
  readonly activation: SubagentActivation | undefined
  readonly controller: TicketAttemptController
  readonly jobs: JobId[]
  readonly producers: Map<JobId, { cancel(): void; done: Promise<JobOutcome> }>
  cancelRequested: boolean
  cancellation?: Promise<void>
  readonly listeners: Set<() => void>
  queue: Promise<void>
  closing: boolean
  disposal?: Promise<void>
  stopFailed?: boolean
}

/** Serializes attempt admission, retains uncertain resources, and waits for producer settlement. */
export class TicketExecutionService extends Service {
  static inject = ['tickets', 'jobs', 'worktrees', 'sessions', 'agents', 'subagents', 'workingDirectory']
  private readonly reservations = new Map<string, Reservation>()
  private readonly handles = new Set<LiveHandle>()
  private closing = false

  constructor(ctx: Context, private readonly config: TicketExecutionConfig) {
    super(ctx, 'ticketExecution')
    if (!Number.isSafeInteger(config.settlementTimeoutMs) || config.settlementTimeoutMs <= 0) {
      throw new TicketError('Ticket execution settlementTimeoutMs must be a positive safe integer', 'TICKET_INVALID_INPUT')
    }
  }

  protected [Service.init](): void {
    this.ctx.on('agent/disposed', ({ agent }) => {
      const handles = [...this.handles].filter(handle => !handle.stopFailed
        && (handle.caller === agent || handle.worker === agent || handle.root === agent.session))
      void Promise.all(handles.map(handle => this.disposeHandle(handle))).catch((error: unknown) => {
        this.ctx.logger.warn(`Ticket execution owner disposal did not settle; reservation retained for reconciliation: ${String(error)}`)
      })
    })
    this.ctx.effect(() => async () => {
      this.closing = true
      await Promise.allSettled([...this.reservations.values()].map(entry => entry.preparation))
      const results = await Promise.allSettled([...this.handles].map(handle => this.disposeHandle(handle)))
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
      const key = JSON.stringify([root.id, current.id, assignment.id])
      const retained = this.reservations.get(key)
      if (retained !== undefined) {
        if (retained.caller === caller && retained.fingerprint === fingerprint) return retained.preparation
        if (current.attempts.some(item => item.assignmentId === assignment.id && item.status !== 'settled')) throw new TicketError('Ticket assignment already has a different execution reservation', 'TICKET_ATTEMPT_STATE')
        this.reservations.delete(key)
      }
      if (current.attempts.some(item => item.id === request.attemptId)) throw new TicketError('Recovered or settled attempt cannot prepare another live handle', 'TICKET_ATTEMPT_STATE')
      if (current.revision !== request.expectedRevision) throw new TicketError('Ticket execution revision is stale', 'TICKET_STALE_REVISION')
      if (current.terminalOutcome !== undefined) throw new TicketError('Terminal Ticket cannot execute', 'TICKET_TERMINAL')
      if (current.attempts.some(item => item.assignmentId === assignment.id && item.status !== 'settled')) {
        throw new TicketError('Recovered Ticket attempt requires settlement reconciliation before execution', 'TICKET_ATTEMPT_STATE')
      }
      this.preflight(request)
      const preparation = this.prepareHandle(caller, root, assignment, request).catch((error: unknown) => {
        if (this.reservations.get(key)?.preparation === preparation
          && !this.ctx.tickets.get(root, request.ticketId).attempts.some(item => item.id === request.attemptId)) {
          this.reservations.delete(key)
        }
        throw error
      })
      this.reservations.set(key, { caller, fingerprint, preparation })
      return preparation
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error('Ticket execution preparation failed', { cause: error }))
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

  private async prepareHandle(
    caller: Agent, root: Session, assignment: AssignmentSnapshot,
    request: PrepareTicketExecutionRequest,
  ): Promise<TicketExecutionHandle> {
    const signal = request.signal ?? new AbortController().signal
    const technicalRoot = this.ctx.agents.get(root.id)
    if (technicalRoot === undefined) throw new TicketError('Ticket technical root Agent is not live', 'TICKET_AUTHORITY')
    const worker = request.executor.kind === 'in-process' ? this.ctx.agents.get(assignment.ownerId) : undefined
    if (request.executor.kind === 'in-process' && worker === undefined) throw new TicketError('In-process Ticket execution requires a live assigned worker', 'TICKET_AUTHORITY')
    const workspaceAgent = worker ?? caller
    if (request.workspace.kind === 'isolated-worktree' || worker !== undefined) {
      const directory = await this.ctx.workingDirectory.ensure(workspaceAgent, signal)
      if (directory !== request.workspace.directory) throw new TicketError('Ticket workspace differs from the live worker directory', 'TICKET_INVALID_INPUT')
    }
    this.assertCaller(caller)
    if (this.closing) throw new TicketError('Ticket execution admission is closed', 'TICKET_ATTEMPT_STATE')
    let recorder: TicketAttemptController | undefined
    await this.ctx.agents.withInitiator(caller, () => this.ctx.tickets.beginAttempt(root, {
      ticketId: request.ticketId, expectedRevision: request.expectedRevision, actorId: caller.id,
      assignmentId: request.assignmentId, attemptId: request.attemptId, operationId: request.operationId,
      workspace: request.workspace, executor: request.executor,
      ...request.assignmentRevision === undefined ? {} : { assignmentRevision: request.assignmentRevision },
      ...request.modelSelection === undefined ? {} : { modelSelection: request.modelSelection },
    }, (controller) => { recorder = controller }))
    if (recorder === undefined) throw new TicketError('Ticket admission did not grant an execution recorder', 'TICKET_RECOVERY_FAILED')
    const controller = recorder
    let workspace: TicketWorkspaceReceipt | undefined
    let activation: SubagentActivation | undefined
    let retainedHandle: LiveHandle | undefined
    let effectInFlight = false
    try {
      signal.throwIfAborted()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- admission awaited persistence since the preceding shutdown check.
      if (this.closing) throw new TicketError('Ticket execution admission is closed', 'TICKET_ATTEMPT_STATE')
      if (request.workspace.kind === 'isolated-worktree') {
        effectInFlight = true
        const worktree = await this.ctx.worktrees.create(workspaceAgent, {
          name: request.worktreeName ?? request.attemptId,
          ...request.workspace.baseCommit === undefined ? {} : { from: request.workspace.baseCommit },
        }, signal)
        workspace = { directory: worktree.path, baseCommit: worktree.baseCommit, worktree }
        effectInFlight = false
      } else {
        if (request.workspace.baseCommit === undefined) throw new TicketError('Ticket shared workspace requires a baseCommit receipt', 'TICKET_INVALID_INPUT')
        workspace = { directory: request.workspace.directory, baseCommit: request.workspace.baseCommit }
      }
      await this.update(controller, 'workspace', { status: 'running', workspaceReceipt: workspace })
      signal.throwIfAborted()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- shutdown can set `closing` during the awaited workspace update.
      if (this.closing) throw new TicketError('Ticket execution admission is closed', 'TICKET_ATTEMPT_STATE')
      if (request.executor.kind !== 'in-process') {
        effectInFlight = true
        activation = await this.ctx.subagents.startActivation({
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
          signal,
        })
        effectInFlight = false
        // A rejected capture remains observable through the returned result without an unhandled rejection.
        void activation.result.catch(() => {})
      }
      const runtimeReceipt = {
        runtimeId: activation?.childId ?? assignment.ownerId,
        providerId: request.executor.kind === 'in-process' ? 'in-process' : request.executor.provider,
        childSessionId: activation?.childId ?? assignment.ownerId,
        ...request.executor.kind === 'remote' ? { world: request.executor.world } : {},
      }
      const handle: LiveHandle = {
        root, caller, worker, request, workspace, activation, controller,
        jobs: [], producers: new Map(), cancelRequested: false, listeners: new Set(), queue: Promise.resolve(), closing: false,
      }
      retainedHandle = handle
      this.handles.add(handle)
      await this.update(controller, 'runtime', { status: 'running', runtimeReceipt })
      const ticket = this.ctx.tickets.get(root, request.ticketId)
      const attempt = ticket.attempts.find(item => item.id === request.attemptId)
      const nextAssignment = ticket.assignments.find(item => item.id === assignment.id)
      if (attempt === undefined || nextAssignment === undefined) throw new TicketError('Ticket execution lost its committed attempt', 'TICKET_RECOVERY_FAILED')
      return {
        ticket, assignment: nextAssignment, attempt, workspace,
        ...activation === undefined ? {} : { activation, result: activation.result },
        get jobs() { return [...handle.jobs] },
        startJob: (label, run, jobSignal) => this.startJob(handle, label, run, jobSignal),
        settle: () => this.disposeHandle(handle, false),
        dispose: () => this.disposeHandle(handle),
      }
    } catch (error: unknown) {
      const failures: unknown[] = [error]
      if (retainedHandle !== undefined) retainedHandle.closing = true
      if (activation !== undefined) {
        try { await this.bounded(activation.dispose()) } catch (cleanup: unknown) { failures.push(cleanup) }
      }
      if (!effectInFlight && activation === undefined) {
        try {
          if (workspace !== undefined) await this.update(controller, 'preparation-workspace', { status: 'stopping', workspaceReceipt: workspace })
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- shutdown can begin during any awaited preparation stage.
          await controller.settle(signal.aborted || this.closing ? 'cancelled' : 'failed')
          if (retainedHandle !== undefined) this.handles.delete(retainedHandle)
          this.reservations.delete(JSON.stringify([root.id, request.ticketId, request.assignmentId]))
        } catch (recording: unknown) { failures.push(recording) }
        throw new AggregateError(failures, 'Ticket preparation ended before a producer started; retry persistence if settlement failed')
      }
      try {
        await this.update(controller, 'preparation-unknown', {
          status: 'unknown', ...workspace === undefined ? {} : { workspaceReceipt: workspace },
          ...activation === undefined ? {} : { runtimeReceipt: { runtimeId: activation.childId, providerId: request.executor.kind === 'in-process' ? 'in-process' : request.executor.provider, childSessionId: activation.childId, ...request.executor.kind === 'remote' ? { world: request.executor.world } : {} } },
          diagnostics: ['Preparation did not establish a recoverable live execution handle; retained resources require reconciliation'],
        })
      } catch (recording: unknown) { failures.push(recording) }
      throw new AggregateError(failures, 'Ticket execution preparation is unknown; reservation retained')
    }
  }

  private async update(controller: TicketAttemptController, stage: string, facts: Pick<UpdateTicketAttemptRequest, 'status' | 'workspaceReceipt' | 'runtimeReceipt' | 'diagnostics'>): Promise<void> {
    await controller.update(stage, facts)
  }

  private startJob(handle: LiveHandle, label: string, run: (job: JobHandle) => JobHooks, signal?: AbortSignal): Promise<JobId> {
    if (handle.closing || this.closing) return Promise.reject(new TicketError('Ticket execution handle is closing', 'TICKET_ATTEMPT_STATE'))
    const operation = handle.queue.then(async () => {
      if (handle.closing) throw new TicketError('Ticket execution handle is closing', 'TICKET_ATTEMPT_STATE')
      this.assertCaller(handle.caller)
      signal?.throwIfAborted()
      const ticket = this.ctx.tickets.get(handle.root, handle.request.ticketId)
      const attempt = ticket.attempts.find(item => item.id === handle.request.attemptId)
      if (ticket.terminalOutcome !== undefined || attempt?.status !== 'running') throw new TicketError('Ticket attempt cannot start background work', 'TICKET_ATTEMPT_STATE')
      const done = Promise.withResolvers<JobOutcome>()
      const producer: {
        hooks?: JobHooks
        job?: JobHandle
        cancelled: boolean
        finished: boolean
        reason?: string
      } = { cancelled: false, finished: false }
      const id = this.ctx.jobs.start({ kind: 'ticket', label, owner: handle.caller.id,
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
      handle.jobs.push(id)
      handle.producers.set(id, {
        cancel: () => {
          if (producer.finished) return
          if (this.ctx.jobs.list(handle.caller.id).some(job => job.id === id)) this.ctx.jobs.kill(id, handle.caller.id, 'Ticket execution released')
          else {
            producer.cancelled = true
            producer.hooks?.cancel('Ticket execution released')
          }
        },
        done: done.promise.then((result) => { producer.finished = true; return result }, (): JobOutcome => {
          producer.finished = true
          return { status: 'failed', detail: 'Ticket producer rejected' }
        }),
      })
      // Producer failure is awaited by stop even if its owner has already removed the Job record.
      void done.promise.catch(() => {})
      try {
        const current = this.ctx.tickets.get(handle.root, handle.request.ticketId)
        const receipt = current.attempts.find(item => item.id === handle.request.attemptId)?.runtimeReceipt
        if (receipt === undefined) throw new TicketError('Job admission requires a runtime receipt', 'TICKET_ATTEMPT_STATE')
        await handle.controller.update('job-' + id, {
          status: 'running', runtimeReceipt: { ...receipt, jobIds: [...receipt.jobIds ?? [], id] },
        })
        if (signal?.aborted || producer.cancelled) {
          done.resolve({ status: 'killed' })
        } else {
          if (producer.job === undefined) throw new TicketError('Job registration did not supply its producer handle', 'TICKET_RECOVERY_FAILED')
          producer.hooks = run(producer.job)
          void producer.hooks.done.then(done.resolve, done.reject)
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- producer startup can synchronously request cancellation.
          if (producer.cancelled) producer.hooks.cancel(producer.reason)
        }
      } catch (error: unknown) {
        done.resolve({ status: 'failed', detail: 'Ticket job admission or producer startup failed' })
        throw error
      }
      if (signal !== undefined) {
        const cancel = () => this.ctx.jobs.kill(id, handle.caller.id, 'Ticket execution caller cancelled')
        const cleanup = () => { signal.removeEventListener('abort', cancel); handle.listeners.delete(cleanup) }
        handle.listeners.add(cleanup)
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
        void done.promise.then(cleanup, cleanup)
      }
      return id
    })
    handle.queue = operation.then(() => {}, () => {})
    return operation
  }

  private disposeHandle(handle: LiveHandle, cancel = true): Promise<void> {
    if (!this.handles.has(handle) && handle.disposal !== undefined) return handle.disposal
    handle.closing = true
    if (cancel && !handle.cancelRequested) {
      handle.cancelRequested = true
      // Cancellation precedes all durable writes and escalates an existing natural settlement wait.
      const cancellations = [...handle.producers.values()].map((producer) => {
        try { producer.cancel() } catch (error: unknown) {
          return Promise.reject(error instanceof Error ? error : new Error('Ticket producer cancellation failed', { cause: error }))
        }
        return Promise.resolve()
      })
      if (handle.activation !== undefined) cancellations.push(handle.activation.dispose())
      else if (handle.worker !== undefined) cancellations.push(Promise.resolve().then(() => { handle.worker?.cancel({ kind: 'parent' }) }))
      handle.cancellation = Promise.all(cancellations).then(() => {})
      void handle.cancellation.catch(() => {})
    }
    if (handle.disposal !== undefined) return handle.disposal
    handle.stopFailed = false
    const disposal = this.stop(handle)
    handle.disposal = disposal
    void disposal.catch(() => {
      handle.stopFailed = true
      if (handle.disposal === disposal) delete handle.disposal
    })
    return disposal
  }

  private async stop(handle: LiveHandle): Promise<void> {
    await handle.queue
    const { root, request, controller } = handle
    try {
      if (handle.cancellation !== undefined) await this.bounded(handle.cancellation)
      let outcome: 'succeeded' | 'failed' | 'cancelled' = handle.cancelRequested ? 'cancelled' : 'succeeded'
      if (handle.activation !== undefined) {
        const result = await this.bounded(handle.activation.result)
        if (result.stopReason !== 'completed') outcome = result.stopReason === 'aborted' ? 'cancelled' : 'failed'
      } else if (handle.worker !== undefined) {
        await this.bounded(handle.worker.whenIdle())
      }
      for (const producer of handle.producers.values()) {
        const result = await this.bounded(producer.done)
        if (result.status === 'failed') outcome = 'failed'
        else if (result.status === 'killed' && outcome !== 'failed') outcome = 'cancelled'
      }
      if (handle.cancelRequested && outcome !== 'failed') outcome = 'cancelled'
      // A dispose may escalate while the natural wait is in progress.
      if (handle.cancellation !== undefined) await this.bounded(handle.cancellation)
      const recorded = this.ctx.tickets.get(root, request.ticketId).attempts.find(attempt => attempt.id === request.attemptId)
      await controller.settle(recorded?.status === 'settled' ? recorded.outcome : outcome)
      for (const cleanup of handle.listeners) cleanup()
      this.handles.delete(handle)
      this.reservations.delete(JSON.stringify([root.id, request.ticketId, request.assignmentId]))
    } catch (error: unknown) {
      if (this.ctx.tickets.get(root, request.ticketId).attempts.find(attempt => attempt.id === request.attemptId)?.status === 'settled') throw error
      try {
        await this.update(controller, 'stop-unknown', { status: 'unknown', diagnostics: ['Cancellation did not establish producer settlement; reservation retained'] })
      } catch (recording: unknown) {
        throw new AggregateError([error, recording], 'Ticket producer settlement and uncertainty recording failed; reservation retained')
      }
      throw error
    }
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
