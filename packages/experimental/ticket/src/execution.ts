/** Ticket-owned execution adapter over Jobs and Worktree providers. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHandle, JobHooks, JobId, JobSpec } from '@deepseek-ai/dsh-jobs'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { CreatedWorktree } from '@deepseek-ai/dsh-experimental-worktree'
import type { AssignmentSnapshot, ExecutionSlotMode, TicketId, TicketView } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ticketExecution: TicketExecutionService
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    ticket: 'ticket'
  }
}

/** Request for one direct worker execution reservation. */
export interface PrepareTicketExecutionRequest {
  readonly rootSessionId: SessionId
  readonly ticketId: TicketId
  readonly assignmentId: AssignmentSnapshot['id']
  readonly expectedRevision: number
  readonly worktreeName?: string
  readonly from?: string
  readonly signal?: AbortSignal
}

/** Workspace prepared for one Ticket assignment. */
export interface TicketExecutionWorkspace {
  readonly mode: ExecutionSlotMode
  readonly worktree?: CreatedWorktree
}

/** Handle for one claimed assignment and its owned background jobs. */
export interface TicketExecutionHandle {
  readonly ticket: TicketView
  readonly assignment: AssignmentSnapshot
  readonly workspace: TicketExecutionWorkspace
  readonly jobs: readonly JobId[]
  /** Start one owned Job whose output and cancellation remain attached to the worker Session. */
  startJob(label: string, run: (job: JobHandle) => JobHooks, signal?: AbortSignal): JobId
  /** Cancel live jobs and release the assignment when it is still running. */
  dispose(): Promise<void>
}

interface LiveHandle {
  readonly root: Session
  readonly agent: Agent
  readonly ticketId: TicketId
  readonly assignment: AssignmentSnapshot
  readonly workspace: TicketExecutionWorkspace
  readonly jobs: JobId[]
  disposed: boolean
}

/**
 * Composes durable Ticket assignment state with the existing Jobs and Worktree providers.
 * The adapter owns runtime resources; Ticket remains the durable authority.
 */
export class TicketExecutionService extends Service {
  static inject = ['tickets', 'jobs', 'worktrees', 'sessions']

  private readonly handles = new Set<LiveHandle>()

  constructor(ctx: Context) {
    super(ctx, 'ticketExecution')
  }

  protected [Service.init](): void {
    this.ctx.effect(() => async () => {
      await Promise.allSettled([...this.handles].map(handle => this.disposeHandle(handle)))
      this.handles.clear()
    }, 'ticket-execution.runtime()')
  }

  /**
   * Claim an assignment for the exact worker Agent and prepare its declared execution mode.
   * Shared workspaces keep the caller's current directory; isolated workspaces use the existing
   * Worktree service and retain its returned checkout metadata for recovery and review.
   *
   * @param agent - live worker Agent whose Session owns the assignment.
   * @param request - Ticket identity, CAS revision, and optional worktree request.
   * @returns an execution handle with Job and workspace ownership.
   */
  async prepare(agent: Agent, request: PrepareTicketExecutionRequest): Promise<TicketExecutionHandle> {
    const signal = request.signal ?? new AbortController().signal
    signal.throwIfAborted()
    const root = this.ctx.sessions.get(request.rootSessionId)
    if (root === undefined) throw new Error(`Ticket root Session "${request.rootSessionId}" is not live`)
    const current = this.ctx.tickets.get(root, request.ticketId)
    const assignment = current.assignments.find(candidate => candidate.id === request.assignmentId)
    if (assignment === undefined) throw new Error(`Ticket assignment "${request.assignmentId}" was not found`)
    if (assignment.ownerId !== agent.id) throw new Error('Ticket execution requires the assigned worker Agent')
    let claimed: TicketView | undefined
    let claimedHere = false
    try {
      claimed = assignment.status === 'running'
        ? current
        : await this.ctx.tickets.claim(root, {
          ticketId: request.ticketId,
          expectedRevision: request.expectedRevision,
          assignmentId: request.assignmentId,
          actorId: agent.id,
        })
      claimedHere = assignment.status !== 'running'
      const liveAssignment = claimed.assignments.find(candidate => candidate.id === request.assignmentId)
      if (liveAssignment === undefined) throw new Error(`Ticket assignment "${request.assignmentId}" disappeared after claim`)
      const mode = claimed.executionSlots.find(slot => slot.id === liveAssignment.executionSlotId)?.mode ?? 'shared-workspace'
      let workspace: TicketExecutionWorkspace = { mode }
      if (mode === 'isolated-worktree') {
        const worktree = await this.ctx.worktrees.create(agent, {
          ...request.worktreeName === undefined ? {} : { name: request.worktreeName },
          ...request.from === undefined ? {} : { from: request.from },
        }, signal)
        signal.throwIfAborted()
        workspace = { mode, worktree }
      }
      const handle: LiveHandle = {
        root, agent, ticketId: request.ticketId, assignment: liveAssignment, workspace, jobs: [], disposed: false,
      }
      this.handles.add(handle)
      return {
        ticket: claimed,
        assignment: liveAssignment,
        workspace,
        get jobs() { return [...handle.jobs] },
        startJob: (label, run, jobSignal) => this.startJob(handle, label, run, jobSignal),
        dispose: () => this.disposeHandle(handle),
      }
    } catch (error: unknown) {
      if (claimedHere && claimed !== undefined) {
        try {
          await this.ctx.tickets.release(root, {
            ticketId: request.ticketId,
            expectedRevision: claimed.revision,
            assignmentId: request.assignmentId,
            actorId: agent.id,
          })
        } catch (cleanup: unknown) {
          throw new AggregateError([error, cleanup], 'Ticket execution preparation and rollback failed')
        }
      }
      throw error
    }
  }

  private startJob(handle: LiveHandle, label: string, run: (job: JobHandle) => JobHooks, signal?: AbortSignal): JobId {
    if (handle.disposed) throw new Error('Ticket execution handle is disposed')
    const spec: JobSpec = { kind: 'ticket', label, owner: handle.agent.id, run }
    const id = this.ctx.jobs.start(spec)
    handle.jobs.push(id)
    if (signal !== undefined) {
      if (signal.aborted) this.ctx.jobs.kill(id, handle.agent.id, 'Ticket execution caller cancelled')
      else signal.addEventListener('abort', () => {
        this.ctx.jobs.kill(id, handle.agent.id, 'Ticket execution caller cancelled')
      }, { once: true })
    }
    return id
  }

  private async disposeHandle(handle: LiveHandle): Promise<void> {
    if (handle.disposed) return
    handle.disposed = true
    const failures: unknown[] = []
    for (const id of handle.jobs) {
      try { this.ctx.jobs.kill(id, handle.agent.id, 'Ticket execution released') } catch (error: unknown) { failures.push(error) }
    }
    try {
      const current = this.ctx.tickets.get(handle.root, handle.ticketId)
      const assignment = current.assignments.find(candidate => candidate.id === handle.assignment.id)
      if (assignment?.status === 'running') {
        await this.ctx.tickets.release(handle.root, {
          ticketId: handle.ticketId,
          expectedRevision: current.revision,
          assignmentId: assignment.id,
          actorId: handle.agent.id,
        })
      }
    } catch (error: unknown) {
      failures.push(error)
    }
    this.handles.delete(handle)
    if (failures.length > 0) throw new AggregateError(failures, 'Ticket execution cleanup failed')
  }
}

export default TicketExecutionService
