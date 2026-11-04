/** Durable Ticket attempt ownership over managed activations and background Jobs. */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHandle, JobHooks, JobId } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-working-directory'
import {
  TicketOperationId,
  type AssignmentSnapshot, type BeginTicketAttemptRequest, type TicketAttemptSnapshot,
  type TicketView, type TicketWorkspaceReceipt, type UpdateTicketAttemptRequest,
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
  readonly jobs: JobId[]
  queue: Promise<void>
  closing: boolean
  disposal?: Promise<void>
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
      throw new Error('Ticket execution settlementTimeoutMs must be a positive safe integer')
    }
  }

  protected [Service.init](): void {
    this.ctx.effect(() => async () => {
      this.closing = true
      await Promise.allSettled([...this.reservations.values()].map(entry => entry.preparation))
      const results = await Promise.allSettled([...this.handles].map(handle => this.disposeHandle(handle)))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
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
      if (this.closing) throw new Error('Ticket execution admission is closed')
      request.signal?.throwIfAborted()
      const root = this.ctx.sessions.get(request.rootSessionId)
      if (root === undefined) throw new Error('Ticket technical root Session is not live')
      const current = this.ctx.tickets.get(root, request.ticketId)
      const assignment = current.assignments.find(item => item.id === request.assignmentId)
      if (assignment === undefined) throw new Error('Ticket assignment was not found')
      if (caller.id !== assignment.ownerId && caller.id !== current.coordinatorId) throw new Error('Ticket execution requires the assigned owner or coordinator')
      const { signal: _signal, ...facts } = request
      const fingerprint = JSON.stringify(facts)
      const key = JSON.stringify([root.id, current.id, assignment.id])
      const retained = this.reservations.get(key)
      if (retained !== undefined) {
        if (retained.caller === caller && retained.fingerprint === fingerprint) return retained.preparation
        if (current.attempts.some(item => item.assignmentId === assignment.id && item.status !== 'settled')) throw new Error('Ticket assignment already has a different execution reservation')
        this.reservations.delete(key)
      }
      if (current.revision !== request.expectedRevision) throw new Error('Ticket execution revision is stale')
      if (current.terminalOutcome !== undefined) throw new Error('Terminal Ticket cannot execute')
      if (current.attempts.some(item => item.id === request.attemptId || (item.assignmentId === assignment.id && item.status !== 'settled'))) {
        throw new Error('Recovered Ticket attempt requires settlement reconciliation before execution')
      }
      this.preflight(request)
      const preparation = this.prepareHandle(caller, root, assignment, request)
      this.reservations.set(key, { caller, fingerprint, preparation })
      return preparation
    } catch (error: unknown) {
      return Promise.reject(error)
    }
  }

  private assertCaller(caller: Agent): void {
    if (this.ctx.agents.get(caller.id) !== caller || this.ctx.sessions.get(caller.id) !== caller.session) {
      throw new Error('Ticket execution requires the exact live caller Agent')
    }
  }

  private preflight(request: PrepareTicketExecutionRequest): void {
    if (!isAbsolute(request.workspace.directory)) throw new Error('Ticket workspace directory must be absolute')
    if (request.workspace.kind === 'shared-workspace' && request.workspace.baseCommit === undefined) throw new Error('Shared Ticket workspace requires its immutable base commit')
    if (request.executor.kind === 'in-process') return
    const provider = this.ctx.subagents.getProvider(request.executor.provider)
    if (provider === undefined) throw new Error('Ticket execution provider is not registered')
    if (provider.execution?.kind !== request.executor.kind) throw new Error('Ticket execution provider does not support the requested placement')
    if (request.executor.kind === 'remote' && (provider.execution.kind !== 'remote' || provider.execution.world !== request.executor.world)) {
      throw new Error('Ticket execution provider does not match the requested remote world')
    }
    if (request.modelSelection !== undefined && !provider.capabilities.agentOptions) throw new Error('Ticket execution provider cannot select agent model options')
  }

  private async prepareHandle(
    caller: Agent, root: Session, assignment: AssignmentSnapshot,
    request: PrepareTicketExecutionRequest,
  ): Promise<TicketExecutionHandle> {
    const signal = request.signal ?? new AbortController().signal
    const technicalRoot = this.ctx.agents.get(root.id)
    if (technicalRoot === undefined) throw new Error('Ticket technical root Agent is not live')
    const worker = request.executor.kind === 'in-process' ? this.ctx.agents.get(assignment.ownerId) : undefined
    if (request.executor.kind === 'in-process' && worker === undefined) throw new Error('In-process Ticket execution requires a live assigned worker')
    const workspaceAgent = worker ?? caller
    if (request.workspace.kind === 'isolated-worktree' || worker !== undefined) {
      const directory = await this.ctx.workingDirectory.ensure(workspaceAgent, signal)
      if (directory !== request.workspace.directory) throw new Error('Ticket workspace differs from the live worker directory')
    }
    this.assertCaller(caller)
    if (this.closing) throw new Error('Ticket execution admission is closed')
    await this.ctx.tickets.beginAttempt(root, {
      ticketId: request.ticketId, expectedRevision: request.expectedRevision, actorId: caller.id,
      assignmentId: request.assignmentId, attemptId: request.attemptId, operationId: request.operationId,
      workspace: request.workspace, executor: request.executor,
      ...request.assignmentRevision === undefined ? {} : { assignmentRevision: request.assignmentRevision },
      ...request.modelSelection === undefined ? {} : { modelSelection: request.modelSelection },
    })
    let workspace: TicketWorkspaceReceipt | undefined
    let activation: SubagentActivation | undefined
    let retainedHandle: LiveHandle | undefined
    try {
      if (request.workspace.kind === 'isolated-worktree') {
        const worktree = await this.ctx.worktrees.create(workspaceAgent, {
          name: request.worktreeName ?? request.attemptId,
          ...request.workspace.baseCommit === undefined ? {} : { from: request.workspace.baseCommit },
        }, signal)
        workspace = { directory: worktree.path, baseCommit: worktree.baseCommit, worktree }
      } else {
        if (request.workspace.baseCommit === undefined) throw new Error('Ticket shared workspace requires a baseCommit receipt')
        workspace = { directory: request.workspace.directory, baseCommit: request.workspace.baseCommit }
      }
      await this.update(root, caller, request, 'workspace', { status: 'running', workspaceReceipt: workspace })
      signal.throwIfAborted()
      if (this.closing) throw new Error('Ticket execution admission is closed')
      if (request.executor.kind !== 'in-process') {
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
        root, caller, worker, request, workspace, activation,
        jobs: [], queue: Promise.resolve(), closing: false,
      }
      retainedHandle = handle
      this.handles.add(handle)
      await this.update(root, caller, request, 'runtime', { status: 'running', runtimeReceipt })
      const ticket = this.ctx.tickets.get(root, request.ticketId)
      const attempt = ticket.attempts.find(item => item.id === request.attemptId)
      const nextAssignment = ticket.assignments.find(item => item.id === assignment.id)
      if (attempt === undefined || nextAssignment === undefined) throw new Error('Ticket execution lost its committed attempt')
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
      try {
        await this.update(root, caller, request, 'preparation-unknown', {
          status: 'unknown', ...workspace === undefined ? {} : { workspaceReceipt: workspace },
          ...activation === undefined ? {} : { runtimeReceipt: { runtimeId: activation.childId, providerId: request.executor.kind === 'in-process' ? 'in-process' : request.executor.provider, childSessionId: activation.childId, ...request.executor.kind === 'remote' ? { world: request.executor.world } : {} } },
          diagnostics: ['Preparation did not establish a recoverable live execution handle; retained resources require reconciliation'],
        })
      } catch (recording: unknown) { failures.push(recording) }
      throw new AggregateError(failures, 'Ticket execution preparation is unknown; reservation retained')
    }
  }

  private async update(root: Session, caller: Agent, request: PrepareTicketExecutionRequest, stage: string, facts: Pick<UpdateTicketAttemptRequest, 'status' | 'workspaceReceipt' | 'runtimeReceipt' | 'diagnostics'>): Promise<void> {
    const current = this.ctx.tickets.get(root, request.ticketId)
    await this.ctx.tickets.updateAttempt(root, { ticketId: request.ticketId, expectedRevision: current.revision, actorId: caller.id, attemptId: request.attemptId, operationId: TicketOperationId(`${request.operationId}:${stage}`), ...facts })
  }

  private startJob(handle: LiveHandle, label: string, run: (job: JobHandle) => JobHooks, signal?: AbortSignal): Promise<JobId> {
    if (handle.closing || this.closing) return Promise.reject(new Error('Ticket execution handle is closing'))
    const operation = handle.queue.then(async () => {
      this.assertCaller(handle.caller)
      signal?.throwIfAborted()
      const ticket = this.ctx.tickets.get(handle.root, handle.request.ticketId)
      const attempt = ticket.attempts.find(item => item.id === handle.request.attemptId)
      if (ticket.terminalOutcome !== undefined || attempt?.status !== 'running') throw new Error('Ticket attempt cannot start background work')
      await this.update(handle.root, handle.caller, handle.request, `job-${handle.jobs.length}-admit`, { status: 'running' })
      const id = this.ctx.jobs.start({ kind: 'ticket', label, owner: handle.caller.id, run })
      handle.jobs.push(id)
      if (signal !== undefined) {
        const cancel = () => this.ctx.jobs.kill(id, handle.caller.id, 'Ticket execution caller cancelled')
        if (signal.aborted) cancel()
        else {
          signal.addEventListener('abort', cancel, { once: true })
          void this.ctx.jobs.wait(id, this.config.settlementTimeoutMs, handle.caller.id).finally(() => signal.removeEventListener('abort', cancel)).catch(() => {})
        }
      }
      return id
    })
    handle.queue = operation.then(() => {}, () => {})
    return operation
  }

  private disposeHandle(handle: LiveHandle, cancel = true): Promise<void> {
    if (handle.disposal !== undefined) return handle.disposal
    handle.closing = true
    handle.disposal = this.stop(handle, cancel)
    return handle.disposal
  }

  private async stop(handle: LiveHandle, cancel: boolean): Promise<void> {
    await handle.queue
    const { root, caller, request } = handle
    await this.update(root, caller, request, 'stopping', { status: 'stopping' })
    try {
      let outcome: 'succeeded' | 'failed' | 'cancelled' = cancel ? 'cancelled' : 'succeeded'
      if (cancel) for (const id of handle.jobs) this.ctx.jobs.kill(id, caller.id, 'Ticket execution released')
      if (handle.activation !== undefined) {
        if (cancel) await this.bounded(handle.activation.dispose())
        const result = await this.bounded(handle.activation.result)
        outcome = result.stopReason === 'completed' ? 'succeeded' : result.stopReason === 'aborted' ? 'cancelled' : 'failed'
      } else if (handle.worker !== undefined) {
        if (cancel) handle.worker.cancel({ kind: 'parent' })
        await this.bounded(handle.worker.whenIdle())
      }
      for (const id of handle.jobs) {
        const result = await this.ctx.jobs.wait(id, this.config.settlementTimeoutMs, caller.id)
        if (result.status === 'running' || result.status === 'stopping') throw new Error('Ticket background producer did not settle')
        if (result.status === 'failed') outcome = 'failed'
      }
      const current = this.ctx.tickets.get(root, request.ticketId)
      await this.ctx.tickets.settleAttempt(root, { ticketId: request.ticketId, expectedRevision: current.revision, actorId: caller.id, attemptId: request.attemptId, operationId: TicketOperationId(`${request.operationId}:settled`), outcome })
      const settled = this.ctx.tickets.get(root, request.ticketId)
      const assignment = settled.assignments.find(item => item.id === request.assignmentId)
      if (assignment?.status === 'running' || assignment?.status === 'claimed' || assignment?.status === 'assigned') {
        await this.ctx.tickets.release(root, {
          ticketId: request.ticketId, expectedRevision: settled.revision,
          actorId: caller.id, assignmentId: request.assignmentId,
        })
      }
      this.handles.delete(handle)
    } catch (error: unknown) {
      await this.update(root, caller, request, 'stop-unknown', { status: 'unknown', diagnostics: ['Cancellation did not establish producer settlement; reservation retained'] })
      throw error
    }
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Ticket producer settlement timed out')), this.config.settlementTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
}

export default TicketExecutionService
