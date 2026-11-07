/** Host Ticket service: durable CAS lifecycle for direct-worker coordination. */

import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { ticketProjectionDefinition, validateTicketChange } from './projection.ts'
import type { TicketProjectionState } from './projection.ts'
import { assertTicketAcceptance, validateTicketReferences } from './validation.ts'
import { TicketError } from './errors.ts'
import { type AttemptCommand, attemptAdmitsCommand, durableAttemptStatus, uncertaintyDiagnostic, uncertaintyStages } from './attempt-lifecycle.ts'
import {
  AssignmentId,
  TicketAttemptId, TicketOperationId, MissionId,
  ExecutionSlotId,
  TicketAttentionId,
  TicketId,
  TicketQuestionId,
  TicketReportId,
} from './types.ts'
import type {
  BeginTicketAttemptRequest, UpdateTicketAttemptRequest, SettleTicketAttemptRequest, ReviseTicketRequest,
  SubmitTicketCandidateRequest, CheckTicketCandidateRequest, PlanTicketMissionRequest, MissionView,
  TicketAttemptSnapshot, TicketMutationRequest, TicketAttemptController, TicketCommand,
  AnswerTicketQuestionRequest,
  CloseTicketQuestionRequest,
  AskTicketQuestionRequest,
  AssignmentSnapshot,
  AssignTicketRequest,
  BlockTicketRequest,
  ClaimAssignmentRequest,
  Config,
  CreateTicketRequest,
  EndTicketRequest,
  ExecutionSlotSnapshot,
  HandoffCoordinatorRequest,
  ReleaseAssignmentRequest,
  ReportTicketRequest,
  RequestTicketAttentionRequest,
  TicketAttentionSnapshot,
  TicketQuestionSnapshot,
  TicketReportSnapshot,
  TicketSnapshot,
  TicketStatus,
  TicketView,
  UpdateTicketAttentionRequest,
  TicketProducerReservation,
  WorkScope,
} from './types.ts'

export { TicketError } from './errors.ts'
export type { TicketErrorCode } from './errors.ts'
export type * from './types.ts'
export { ticketProjectionDefinition, ticketSnapshotSchema } from './projection.ts'
export { TicketAttemptId, TicketCandidateId, TicketCheckId, TicketCriterionId, TicketOperationId, MissionId, AssignmentId, ExecutionSlotId, TicketAttentionId, TicketId, TicketQuestionId, TicketReportId } from './types.ts'
export { TicketExecutionService } from './execution.ts'
export type { PrepareTicketExecutionRequest, TicketExecutionHandle, TicketExecutionWorkspace } from './execution.ts'
export { TicketTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tickets: TicketService
  }
}

const DEFAULT_MAX_TICKETS = 64
const DEFAULT_MAX_ASSIGNMENTS = 128
const DEFAULT_MAX_REPORTS = 256
const DEFAULT_MAX_QUESTIONS = 128
const DEFAULT_MAX_ATTENTIONS = 128
const DEFAULT_MAX_WORK_SCOPES = 64
const DEFAULT_MAX_SNAPSHOT_BYTES = 1_048_576

function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TicketError(`${name} must be a positive safe integer`, 'TICKET_INVALID_INPUT')
  }
  return value
}

function nonEmpty(name: string, value: string): string {
  if (value.trim().length === 0) throw new TicketError(`${name} must not be empty`, 'TICKET_INVALID_INPUT')
  return value
}

function boundedList<T>(name: string, values: readonly T[] | undefined, limit: number): T[] {
  const result = values === undefined ? [] : [...values]
  if (result.length > limit) throw new TicketError(`${name} exceeds ${String(limit)} items`, 'TICKET_LIMIT')
  return result
}

function operationFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
}

function executionOperationId(attemptId: TicketAttemptId, stage: string): TicketOperationId {
  return TicketOperationId('ticket-execution:' + JSON.stringify([attemptId, stage]))
}

/** Prefix shared by every reserved execution stage operation of one attempt. */
function executionOperationPrefix(attemptId: TicketAttemptId): string {
  return 'ticket-execution:' + JSON.stringify([attemptId]).slice(0, -1) + ','
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function cloneScopes(scopes: readonly WorkScope[] | undefined, limit: number): WorkScope[] {
  const result = boundedList('workScopes', scopes, limit)
  return result.map(scope => ({ ...scope, path: normalizeScopePath(scope.path) }))
}

function normalizeScopePath(path: string): string {
  nonEmpty('work scope path', path)
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.includes('\0')) {
    throw new TicketError('work scope path must be a relative workspace path', 'TICKET_INVALID_INPUT')
  }
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) throw new TicketError('work scope path escapes the workspace', 'TICKET_INVALID_INPUT')
      segments.pop()
    } else segments.push(segment)
  }
  return segments.join('/') || '.'
}

function nextStatusForAssignment(ticket: TicketSnapshot): TicketStatus {
  if (ticket.attentions.some(item => item.kind === 'blocked' && item.status !== 'resolved')
    || ticket.assignments.some(assignment => assignment.status === 'failed' || assignment.status === 'blocked')) return 'blocked'
  if (ticket.questions.some(question => question.status === 'open')
    || ticket.attentions.some(item => item.status !== 'resolved')) return 'waiting'
  const live = ticket.assignments.some(assignment => assignment.status === 'assigned' || assignment.status === 'claimed' || assignment.status === 'running')
  const complete = ticket.assignments.length > 0 && ticket.assignments.every(assignment => assignment.status === 'completed' || assignment.status === 'cancelled')
  if (complete) return 'integrating'
  return live ? 'executing' : 'ready'
}

/** One execution-owned attempt in the settlement ledger. The root is named by id and resolved when each write runs. */
interface Settlement {
  readonly rootId: SessionId
  readonly ticketId: TicketId
  readonly attemptId: TicketAttemptId
  readonly assignmentId: AssignmentId
  readonly actorId: SessionId
  /** First observed producer outcome; later settlement calls retry this one. */
  outcome?: SettleTicketAttemptRequest['outcome']
  /** Known workspace receipt written with the settlement when the attempt has none recorded. */
  workspaceReceipt?: SettleTicketAttemptRequest['workspaceReceipt']
  readonly diagnostics: readonly string[]
}

interface AttemptOperationOptions {
  /** Written by the execution owner: no caller CAS or participant check. */
  readonly executionOwned?: boolean
  /** Durable execution-ownership record appended in the same snapshot as the admission, so restart can identify it. */
  readonly admittedBy?: TicketOperationId
  /** Runs once the operation is in the in-memory log, appended now or found on retry, before the flush. */
  readonly recorded?: () => void
  /** A settled attempt is already terminal: settlement retries only repeat the flush. */
  readonly settledByAnyOperation?: TicketAttemptId
}

/** Refuse a Ticket command that the attempt's durable status does not admit. */
function admitCommand(attempt: TicketAttemptSnapshot, command: AttemptCommand): void {
  const decision = attemptAdmitsCommand(durableAttemptStatus(attempt), command)
  if (decision !== 'allowed') throw new TicketError(`Attempt "${attempt.id}": ${decision.reason}`, 'TICKET_ATTEMPT_STATE')
}

/** Decides which coordinator a new Ticket names; see {@link TicketService.registerCoordinatorAuthority}. */
type CoordinatorAuthority = (session: Session, requested: SessionId) => SessionId | undefined

/** Decides whether an acting Session may commit one Ticket command; it throws a `TicketError` to refuse.
 * @param session - root Session that owns the Ticket log.
 * @param actorId - live Agent recorded as the command's actor; for `create`, the initiator that creates the Ticket.
 * @param command - the command at its commit point.
 */
export type TicketCommandAuthority = (session: Session, actorId: SessionId, command: TicketCommand) => void

/** The authorities that govern one queued command: those registered when it was admitted plus any registered since. */
interface Governance {
  readonly coordinators: readonly CoordinatorAuthority[]
  readonly commands: readonly TicketCommandAuthority[]
}

function activeSlot(slot: ExecutionSlotSnapshot | undefined): boolean {
  return slot?.status === 'reserved' || slot?.status === 'running'
}

/** Durable Ticket commands require a registered live Agent in the initiator scope; actor ids must match that Agent. */
export class TicketService extends Service {
  static inject = ['sessions', 'sessionProjections', 'agents']

  static Config: z<Config> = z.object({
    maxTickets: z.number().step(1).min(1).default(DEFAULT_MAX_TICKETS),
    maxAssignments: z.number().step(1).min(1).default(DEFAULT_MAX_ASSIGNMENTS),
    maxReports: z.number().step(1).min(1).default(DEFAULT_MAX_REPORTS),
    maxQuestions: z.number().step(1).min(1).default(DEFAULT_MAX_QUESTIONS),
    maxAttentions: z.number().step(1).min(1).default(DEFAULT_MAX_ATTENTIONS),
    maxWorkScopes: z.number().step(1).min(1).default(DEFAULT_MAX_WORK_SCOPES),
    maxSnapshotBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SNAPSHOT_BYTES),
  })

  private readonly config: Required<Config>
  private projection: ProjectionHandle<TicketProjectionState> | undefined
  private readonly scopeReservations = new Map<string, { root: SessionId; attempt: TicketAttemptSnapshot; scopes: readonly WorkScope[] }>()
  private readonly recoveryFailures = new Set<SessionId>()
  private readonly tails = new Map<SessionId, Promise<void>>()
  private readonly coordinatorAuthorities = new Set<CoordinatorAuthority>()
  private readonly commandAuthorities = new Set<TicketCommandAuthority>()
  /** Execution-admitted attempts this service owns until a durable flush shows them settled, keyed like scope reservations. */
  private readonly settlements = new Map<string, Settlement>()
  /** Roots live when this service activated; their attempts may still belong to the previous service generation's producers. */
  private readonly activationRoots = new Set<SessionId>()
  /** Stored roots whose log could not be read; shared-workspace admission stays refused while any remains. */
  private readonly unreadableRoots = new Map<SessionId, unknown>()
  private storedScan: Promise<void> | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tickets')
    this.config = {
      maxTickets: positiveLimit('maxTickets', config.maxTickets ?? DEFAULT_MAX_TICKETS),
      maxAssignments: positiveLimit('maxAssignments', config.maxAssignments ?? DEFAULT_MAX_ASSIGNMENTS),
      maxReports: positiveLimit('maxReports', config.maxReports ?? DEFAULT_MAX_REPORTS),
      maxQuestions: positiveLimit('maxQuestions', config.maxQuestions ?? DEFAULT_MAX_QUESTIONS),
      maxAttentions: positiveLimit('maxAttentions', config.maxAttentions ?? DEFAULT_MAX_ATTENTIONS),
      maxWorkScopes: positiveLimit('maxWorkScopes', config.maxWorkScopes ?? DEFAULT_MAX_WORK_SCOPES),
      maxSnapshotBytes: positiveLimit('maxSnapshotBytes', config.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES),
    }
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(ticketProjectionDefinition)
    this.ctx.on('session/created', (session) => {
      this.retainScopes(session)
      // Announcement keeps the Session read-only until dispatch unwinds, so recovery writes start afterwards.
      void Promise.resolve().then(() => this.recoverRoot(session)).catch((error: unknown) => {
        this.ctx.logger.warn(`Ticket attempt recovery for Session "${session.id}" did not persist; the next resume retries it: ${String(error)}`)
      })
    })
    this.ctx.on('session/event', (session, event) => {
      if (event.type === 'ticket/state') this.retainScopes(session)
    })
    this.ctx.effect(() => async () => {
      await this.drainSettlements()
      this.tails.clear(); this.scopeReservations.clear(); this.recoveryFailures.clear(); this.settlements.clear()
      this.activationRoots.clear(); this.unreadableRoots.clear(); this.storedScan = undefined
    }, 'tickets.runtime()')
    for (const session of this.ctx.sessions.list()) {
      this.activationRoots.add(session.id)
      this.retainScopes(session)
    }
  }

  /** Register an owner of coordination that may replace the coordinator a new Ticket would name.
   *
   * `create` consults every authority inside the Session's command queue, in the same synchronous step that reads the
   * Session state and appends the Ticket, so the Ticket names the coordinator the authority decides at that moment.
   * The authority receives `CreateTicketRequest.coordinatorId` (the Session id when absent); the first authority that
   * returns an id replaces it. An authority that throws fails the creation with nothing appended. A creation admitted to
   * the queue before the disposer runs is still decided by this authority.
   * @param authority - synchronous decision returning the replacement coordinator, or `undefined` to keep the requested one.
   * @returns disposer that removes the authority for creations admitted later.
   */
  registerCoordinatorAuthority(authority: (session: Session, requested: SessionId) => SessionId | undefined): () => void {
    this.coordinatorAuthorities.add(authority)
    return () => { this.coordinatorAuthorities.delete(authority) }
  }

  /** Register an owner of assignment admission that may refuse an assignee.
   *
   * A narrowing of {@link registerCommandAuthority} to `assign`: the authority runs in the same queued step, after the
   * actor, role and CAS checks and immediately before the append, so a refusal reflects the assignee's standing at the
   * moment the assignment would commit rather than when the call was made. A Session with no registered authority accepts
   * any assignee.
   * @param authority - synchronous decision for `assigneeId` in `session`; it throws a `TicketError` to refuse, which fails
   * the assignment with that error unchanged and appends nothing. Any other exception returns `TICKET_RECOVERY_FAILED`
   * with the original cause.
   * @returns disposer that removes the authority for later commands; a command already admitted stays governed by it.
   */
  registerAssignmentAuthority(authority: (session: Session, assigneeId: SessionId) => void): () => void {
    return this.registerCommandAuthority((session, _actorId, command) => {
      if (command.kind === 'assign') authority(session, command.assigneeId)
    })
  }

  /** Register an owner of acting authority that may refuse any Ticket command of a Session at its commit point.
   *
   * Every mutating command (`TicketCommandKind`) consults every authority inside the root Session's command queue, in the
   * same synchronous step that follows the command's own actor, role and CAS checks and precedes the append, so the decision
   * reflects the actor's standing when the command would commit rather than when the call was made or queued. Attempt
   * writes made by the execution owner for settlement and recovery act as the system rather than as a member and are not
   * consulted. A Session with no registered authority accepts every command.
   *
   * A command is governed by the authorities registered when it was admitted to the queue, plus any registered before it
   * commits; disposing an authority only stops it from governing commands admitted later.
   * @param authority - synchronous decision; it throws a `TicketError` to refuse, which fails the command with that error
   * unchanged and appends nothing. Any other exception fails it with `TICKET_RECOVERY_FAILED` and the original cause.
   * @returns disposer that removes the authority for later commands.
   */
  registerCommandAuthority(authority: TicketCommandAuthority): () => void {
    this.commandAuthorities.add(authority)
    return () => { this.commandAuthorities.delete(authority) }
  }

  /** Wait for the commands already admitted to one root's queue.
   *
   * Resolves once every command admitted for `session` before this call has committed or failed. Commands admitted later
   * are not awaited, so a caller that must not be outrun stops its own admission first. An owner of a command authority
   * calls this before it releases the state that authority reads.
   * @param session - root Session whose command queue is awaited.
   */
  async whenIdle(session: Session): Promise<void> {
    await this.tails.get(session.id)
  }

  /** Read all Tickets recovered from one Session's durable log.
   * @param session - Session whose log is replayed.
   * @returns recovered Ticket views.
   */
  recover(session: Session): TicketView[] {
    return this.state(session).tickets.map(ticket => ticket)
  }

  /** Read one Ticket from the projection.
   * @param session - Session whose projection is read.
   * @param id - Ticket identity.
   * @returns the current Ticket view.
   */
  get(session: Session, id: TicketId): TicketView {
    const ticket = this.state(session).tickets.find(candidate => candidate.id === id)
    if (ticket === undefined) throw new TicketError(`unknown Ticket "${id}"`, 'TICKET_NOT_FOUND')
    return ticket
  }

  /** Read all Tickets in creation order.
   * @param session - Session whose projection is read.
   * @returns current Ticket views.
   */
  list(session: Session): TicketView[] {
    return this.state(session).tickets.map(ticket => ticket)
  }

  /** Create the first whole-value state event for one Ticket.
   * @param session - Session whose log owns the Ticket.
   * @param request - Ticket creation request.
   * @returns the committed Ticket view.
   */
  async create(session: Session, request: CreateTicketRequest): Promise<TicketView> {
    const caller = this.assertCaller(undefined)
    if (caller.session !== session) throw new TicketError('Ticket creation requires its technical owner', 'TICKET_AUTHORITY')
    return await this.enqueue(session, async (governance) => {
      const state = this.state(session)
      if (state.tickets.length >= this.config.maxTickets) throw new TicketError('Ticket limit exhausted', 'TICKET_LIMIT')
      const id = request.id ?? TicketId(`ticket-${session.id}-${String(state.tickets.length + 1)}`)
      if (state.tickets.some(ticket => ticket.id === id)) throw new TicketError(`Ticket "${id}" already exists`, 'TICKET_INVALID_INPUT')
      const subject = nonEmpty('subject', request.subject)
      const requested = request.coordinatorId ?? session.id
      let coordinatorId: SessionId
      try { coordinatorId = this.authorizedCoordinator(governance, session, requested) } catch (cause: unknown) {
        // An authority's own TicketError carries its handling code, such as a retryable TICKET_COORDINATOR_UNAVAILABLE.
        if (cause instanceof TicketError) throw cause
        throw new TicketError('Ticket coordinator authority failed', 'TICKET_RECOVERY_FAILED', { cause })
      }
      const coordinator = this.ctx.agents.get(coordinatorId)
      if (coordinator === undefined || this.ctx.sessions.get(coordinatorId) !== coordinator.session) {
        const origin = coordinatorId === requested ? '' : ' selected by the coordinator authority'
        throw new TicketError(`Ticket coordinator "${coordinatorId}"${origin} must be a registered live Agent; resume that Agent, `
          + `or hand coordination back to the Session owner "${session.id}", then retry`, 'TICKET_AUTHORITY')
      }
      const now = Date.now()
      const ticket: TicketSnapshot = {
        id,
        revision: 1,
        subject,
        description: request.description,
        status: 'proposed',
        coordinatorId,
        assignments: [],
        reports: [],
        questions: [],
        attentions: [],
        workScopes: cloneScopes(request.workScopes, this.config.maxWorkScopes),
        executionSlots: [],
        specification: {
          revision: 1, acceptanceCriteria: [...request.acceptanceCriteria ?? []], dependencies: [...request.dependencies ?? []],
          ...request.parent === undefined ? {} : { parent: request.parent },
        },
        attempts: [], candidates: [], checks: [], operations: [], missionPlans: [],
        createdAt: now,
        updatedAt: now,
      }
      this.authorize(governance, session, caller.id, { kind: 'create', ticketId: id })
      await this.commit(session, ticket)
      return ticket
    })
  }

  /** Assign one direct worker under coordinator authority.
   * @param session - Session whose log owns the Ticket.
   * @param request - direct worker assignment request.
   * @returns the committed Ticket view.
   */
  async assign(session: Session, request: AssignTicketRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'assign', ticketId: request.ticketId, assigneeId: request.ownerId }, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      if (ticket.assignments.length >= this.config.maxAssignments) throw new TicketError('Assignment limit exhausted', 'TICKET_LIMIT')
      const subject = nonEmpty('assignment subject', request.subject)
      const assignmentId = AssignmentId(`assignment-${ticket.id}-${String(ticket.assignments.length + 1)}`)
      const slotId = ExecutionSlotId(`slot-${ticket.id}-${String(ticket.executionSlots.length + 1)}`)
      const mode = request.executionMode ?? 'dedicated-process'
      const assignment: AssignmentSnapshot = {
        id: assignmentId,
        revision: 1,
        role: request.role ?? 'worker',
        contribution: request.contribution ?? (request.role === 'observer' ? 'advisory' : 'required'),
        subject,
        instructions: request.instructions ?? '',
        ownerId: request.ownerId,
        status: 'assigned',
        workScopes: this.validateAssignmentScopes(ticket, request.workScopes),
        executionSlotId: slotId,
        attempts: 0,
      }
      const slot: ExecutionSlotSnapshot = {
        id: slotId,
        mode,
        status: 'reserved',
        assignmentId,
      }
      return {
        ...ticket,
        status: ticket.status === 'proposed' ? 'ready' : ticket.status,
        assignments: [...ticket.assignments, assignment],
        executionSlots: [...ticket.executionSlots, slot],
      }
    })
  }

  /** Claim one assigned responsibility by its direct worker.
   * @param session - Session whose log owns the Ticket.
   * @param request - worker claim request.
   * @returns the committed Ticket view.
   */
  async claim(session: Session, request: ClaimAssignmentRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'claim', ticketId: request.ticketId }, (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
      if (assignment.workScopes.some(scope => scope.access === 'write' && scope.exclusive)) throw new TicketError('Exclusive write Assignments require a workspace-bearing attempt instead of claim', 'TICKET_ATTEMPT_STATE')
      if (assignment.activeAttemptId !== undefined) throw new TicketError('admit a fresh attempt instead of claiming an Assignment with attempt history', 'TICKET_ATTEMPT_STATE')
      if (assignment.ownerId !== request.actorId) throw new TicketError('only the assigned worker may claim the Assignment', 'TICKET_AUTHORITY')
      if (assignment.status !== 'assigned' && assignment.status !== 'released') throw new TicketError(`Assignment "${assignment.id}" cannot be claimed from ${assignment.status}`, 'TICKET_ASSIGNMENT_STATE')
      const slot = assignment.executionSlotId === undefined
        ? undefined
        : ticket.executionSlots.find(candidate => candidate.id === assignment.executionSlotId)
      if (slot !== undefined && activeSlot(slot) && slot.holderId !== undefined && slot.holderId !== request.actorId) {
        throw new TicketError(`execution slot "${slot.id}" is held by another worker`, 'TICKET_ASSIGNMENT_STATE')
      }
      const nextAssignment: AssignmentSnapshot = {
        ...assignment,
        revision: assignment.revision + 1,
        status: 'running',
        attempts: assignment.attempts + 1,
      }
      const assignments = ticket.assignments.map(candidate => candidate.id === assignment.id ? nextAssignment : candidate)
      const executionSlots = ticket.executionSlots.map(candidate => candidate.id === slot?.id
        ? { ...candidate, status: 'running' as const, holderId: request.actorId }
        : candidate)
      const next = { ...ticket, assignments, executionSlots }
      return { ...next, status: nextStatusForAssignment(next) }
    })
  }

  /** Release one responsibility while preserving its durable worker owner.
   * @param session - Session whose log owns the Ticket.
   * @param request - Assignment release request.
   * @returns the committed Ticket view.
   */
  async release(session: Session, request: ReleaseAssignmentRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'release', ticketId: request.ticketId }, (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
      const active = ticket.attempts.find(attempt => attempt.id === assignment.activeAttemptId)
      if (active !== undefined) admitCommand(active, 'release')
      if (assignment.ownerId !== request.actorId && ticket.coordinatorId !== request.actorId) throw new TicketError('only the assigned worker or coordinator may release the Assignment', 'TICKET_AUTHORITY')
      if (assignment.status !== 'running' && assignment.status !== 'claimed' && assignment.status !== 'assigned') throw new TicketError(`Assignment "${assignment.id}" cannot be released from ${assignment.status}`, 'TICKET_ASSIGNMENT_STATE')
      const nextAssignment: AssignmentSnapshot = { ...assignment, revision: assignment.revision + 1, status: 'released' }
      const assignments = ticket.assignments.map(candidate => candidate.id === assignment.id ? nextAssignment : candidate)
      const executionSlots = ticket.executionSlots.map(candidate => candidate.id === assignment.executionSlotId
        ? { id: candidate.id, mode: candidate.mode, status: 'released' as const, assignmentId: candidate.assignmentId }
        : candidate)
      const next = { ...ticket, assignments, executionSlots }
      return { ...next, status: nextStatusForAssignment(next) }
    })
  }

  /** Publish a bounded worker report and update its Assignment's latest report.
   * @param session - Session whose log owns the Ticket.
   * @param request - worker report request.
   * @returns the committed Ticket view.
   */
  async report(session: Session, request: ReportTicketRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'report', ticketId: request.ticketId }, (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
      if (assignment.ownerId !== request.actorId && ticket.coordinatorId !== request.actorId) throw new TicketError('only the assigned worker or coordinator may report', 'TICKET_AUTHORITY')
      if (!['assigned', 'claimed', 'running', 'blocked'].includes(assignment.status)) throw new TicketError(`Assignment "${assignment.id}" cannot report from ${assignment.status}`, 'TICKET_ASSIGNMENT_STATE')
      if (assignment.activeAttemptId !== undefined) {
        if (request.attemptId !== assignment.activeAttemptId) throw new TicketError('report must name the current active attempt', 'TICKET_STALE_ATTEMPT')
        const attempt = ticket.attempts.find(item => item.id === request.attemptId)
        if (attempt?.specRevision !== ticket.specification.revision) throw new TicketError('report belongs to an obsolete specification', 'TICKET_STALE_ATTEMPT')
        admitCommand(attempt, request.kind === 'result' ? 'report-result' : request.kind === 'failure' ? 'report-failure' : 'report-progress')
      } else if (request.attemptId !== undefined) throw new TicketError('unknown report attempt', 'TICKET_STALE_ATTEMPT')
      if (ticket.reports.length >= this.config.maxReports) throw new TicketError('report limit exhausted', 'TICKET_LIMIT')
      const summary = nonEmpty('report summary', request.summary)
      const id = TicketReportId(`report-${ticket.id}-${String(ticket.reports.length + 1)}`)
      const report: TicketReportSnapshot = {
        id,
        assignmentId: assignment.id,
        specRevision: ticket.specification.revision,
        ...request.attemptId === undefined ? {} : { attemptId: request.attemptId },
        authorId: request.actorId,
        kind: request.kind,
        summary,
        evidence: boundedList('report evidence', request.evidence, this.config.maxReports),
        nextSteps: boundedList('report next steps', request.nextSteps, this.config.maxReports),
        createdAt: Date.now(),
      }
      const assignmentStatus = request.kind === 'result' ? 'completed' : request.kind === 'failure' ? 'failed' : 'running'
      const nextAssignment: AssignmentSnapshot = {
        ...assignment,
        revision: assignment.revision + 1,
        status: assignmentStatus,
        latestReportId: id,
      }
      const assignments = ticket.assignments.map(candidate => candidate.id === assignment.id ? nextAssignment : candidate)
      const next = { ...ticket, assignments, reports: [...ticket.reports, report] }
      return { ...next, status: nextStatusForAssignment(next) }
    })
  }

  /** Ask a durable question; blocked Tickets remain blocked, otherwise they wait.
   * @param session - Session whose log owns the Ticket.
   * @param request - worker question request.
   * @returns the committed Ticket view.
   */
  async ask(session: Session, request: AskTicketQuestionRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'ask', ticketId: request.ticketId }, (ticket) => {
      this.assertParticipant(ticket, request.actorId, request.assignmentId)
      if (ticket.questions.length >= this.config.maxQuestions) throw new TicketError('question limit exhausted', 'TICKET_LIMIT')
      const question: TicketQuestionSnapshot = {
        id: TicketQuestionId(`question-${ticket.id}-${String(ticket.questions.length + 1)}`),
        ...request.assignmentId === undefined ? {} : { assignmentId: request.assignmentId },
        authorId: request.actorId,
        question: nonEmpty('question', request.question),
        status: 'open',
        createdAt: Date.now(),
      }
      const next = { ...ticket, questions: [...ticket.questions, question] }
      return { ...next, status: nextStatusForAssignment(next) }
    })
  }

  /** Answer an open question under coordinator authority; other blockers remain active.
   * @param session - Session owning the Ticket.
   * @param request - Question identity, answer, actor, and CAS revision.
   * @returns Committed Ticket; rejects without appending for denied or invalid changes.
   */
  async answer(session: Session, request: AnswerTicketQuestionRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'answer', ticketId: request.ticketId }, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      const question = this.question(ticket, request.questionId)
      if (question.status !== 'open') throw new TicketError('only an open question may be answered', 'TICKET_INVALID_INPUT')
      const answer = nonEmpty('answer', request.answer)
      const next = { ...ticket, questions: ticket.questions.map(item => item.id === question.id
        ? { ...item, status: 'answered' as const, answer, answeredBy: request.actorId } : item) }
      return { ...next, status: nextStatusForAssignment(next) }
    })
  }

  /** Close an open or answered question as its author or current coordinator.
   * @param session - Session owning the Ticket.
   * @param request - Question identity, actor, and CAS revision.
   * @returns Committed Ticket; rejects without appending for denied or invalid changes.
   */
  async closeQuestion(session: Session, request: CloseTicketQuestionRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'close-question', ticketId: request.ticketId }, (ticket) => {
      const question = this.question(ticket, request.questionId)
      if (request.actorId !== question.authorId) this.assertCoordinator(ticket, request.actorId)
      if (question.status === 'closed') throw new TicketError('question is already closed', 'TICKET_INVALID_INPUT')
      const next = { ...ticket, questions: ticket.questions.map(item => item.id === question.id
        ? { ...item, status: 'closed' as const } : item) }
      return { ...next, status: nextStatusForAssignment(next) }
    })
  }

  /** Acknowledge an open attention item as coordinator; acknowledgement retains its blocker.
   * @param session - Session owning the Ticket.
   * @param request - Attention identity, actor, and CAS revision.
   * @returns Committed Ticket; rejects without appending for denied or invalid changes.
   */
  async acknowledgeAttention(session: Session, request: UpdateTicketAttentionRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.updateAttention(session, request, 'acknowledged')
  }

  /** Resolve an open or acknowledged attention item as coordinator, preserving other blockers.
   * @param session - Session owning the Ticket.
   * @param request - Attention identity, actor, and CAS revision.
   * @returns Committed Ticket; rejects without appending for denied or invalid changes.
   */
  async resolveAttention(session: Session, request: UpdateTicketAttentionRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.updateAttention(session, request, 'resolved')
  }

  /** Add a human-visible attention item; blocked attention keeps the Ticket blocked.
   * @param session - Session whose log owns the Ticket.
   * @param request - attention request.
   * @returns the committed Ticket view.
   */
  async attention(session: Session, request: RequestTicketAttentionRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'attention', ticketId: request.ticketId }, (ticket) => {
      this.assertParticipant(ticket, request.actorId, request.assignmentId)
      if (ticket.attentions.length >= this.config.maxAttentions) throw new TicketError('attention limit exhausted', 'TICKET_LIMIT')
      const attention: TicketAttentionSnapshot = {
        id: TicketAttentionId(`attention-${ticket.id}-${String(ticket.attentions.length + 1)}`),
        ...request.assignmentId === undefined ? {} : { assignmentId: request.assignmentId },
        kind: request.kind,
        message: nonEmpty('attention message', request.message),
        status: 'open',
        createdAt: Date.now(),
      }
      const next = { ...ticket, attentions: [...ticket.attentions, attention] }
      return { ...next, status: nextStatusForAssignment(next) }
    })
  }

  /** Block a Ticket with a coordinator or direct worker reason.
   * @param session - Session whose log owns the Ticket.
   * @param request - block request.
   * @returns the committed Ticket view.
   */
  async block(session: Session, request: BlockTicketRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'block', ticketId: request.ticketId }, (ticket) => {
      this.assertParticipant(ticket, request.actorId)
      if (ticket.attentions.length >= this.config.maxAttentions) throw new TicketError('attention limit exhausted', 'TICKET_LIMIT')
      return { ...ticket, status: 'blocked', attentions: [...ticket.attentions, {
        id: TicketAttentionId(`attention-${ticket.id}-${String(ticket.attentions.length + 1)}`),
        kind: 'blocked' as const,
        message: nonEmpty('block reason', request.reason),
        status: 'open' as const,
        createdAt: Date.now(),
      }] }
    })
  }

  /** Transfer coordinator authority while keeping the Ticket revision and history intact.
   * @param session - Session whose log owns the Ticket.
   * @param request - coordinator handoff request.
   * @returns the committed Ticket view.
   */
  async handoff(session: Session, request: HandoffCoordinatorRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'handoff', ticketId: request.ticketId }, (ticket) => {
      if (request.actorId !== session.id) this.assertCoordinator(ticket, request.actorId)
      nonEmpty('newCoordinatorId', request.newCoordinatorId)
      const coordinator = this.ctx.agents.get(request.newCoordinatorId)
      if (coordinator === undefined || this.ctx.sessions.get(coordinator.id) !== coordinator.session) throw new TicketError('New coordinator must be a registered live Agent', 'TICKET_AUTHORITY')
      return { ...ticket, coordinatorId: request.newCoordinatorId, status: ticket.status === 'proposed' ? 'coordinating' : ticket.status }
    })
  }

  /** Finish a Ticket with a completed outcome.
   * @param session - Session whose log owns the Ticket.
   * @param request - terminal completion request.
   * @returns the committed Ticket view.
   */
  async complete(session: Session, request: EndTicketRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.end(session, request, 'completed')
  }

  /** Finish a Ticket with a failed outcome.
   * @param session - Session whose log owns the Ticket.
   * @param request - terminal failure request.
   * @returns the committed Ticket view.
   */
  async fail(session: Session, request: EndTicketRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.end(session, request, 'failed')
  }

  /** Cancel a Ticket with a terminal outcome.
   * @param session - Session whose log owns the Ticket.
   * @param request - terminal cancellation request.
   * @returns the committed Ticket view.
   */
  async cancel(session: Session, request: EndTicketRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.end(session, request, 'cancelled')
  }

  /** Replace the specification; prior candidates, checks and contributions remain historical.
   * @param session - Owning Session.
   * @param request - Complete replacement obligations and CAS revision.
   * @returns Committed Ticket with an incremented specification revision.
   */
  async revise(session: Session, request: ReviseTicketRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'revise', ticketId: request.ticketId }, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      const { currentCandidateId: _candidate, ...withoutCandidate } = ticket
      return {
        ...withoutCandidate,
        assignments: ticket.assignments.map(assignment => assignment.status === 'completed' && assignment.activeAttemptId === undefined
          ? { ...assignment, revision: assignment.revision + 1, status: 'assigned' as const } : assignment),
        status: ticket.status === 'integrating' ? 'ready' : ticket.status,
        specification: {
          revision: ticket.specification.revision + 1,
          acceptanceCriteria: [...request.acceptanceCriteria], dependencies: [...request.dependencies],
          ...request.parent === undefined ? {} : { parent: request.parent },
        },
      }
    })
  }

  /** Admit one execution attempt before effects; repeated operation identities do not append.
   *
   * With `capture`, the attempt is execution-owned: `capture` receives the attempt-bound recorder as soon as the admission is
   * appended or found on retry, before the flush, so a failed flush still leaves the execution owner able to retry or settle it.
   * @param session - Owning Session.
   * @param request - Attempt identity, placement, actor and CAS revision.
   * @param capture - Optional execution owner receiving an attempt-bound recorder after admission; omitted for manual admission.
   * @returns Durably flushed Ticket, including on retry; rejects unsettled replacements or changed operation payloads.
   */
  async beginAttempt(
    session: Session, request: BeginTicketAttemptRequest,
    capture?: (controller: {
      update(stage: string, facts: Pick<UpdateTicketAttemptRequest, 'status' | 'workspaceReceipt' | 'runtimeReceipt' | 'diagnostics'>): Promise<TicketView>
      settle(outcome: SettleTicketAttemptRequest['outcome'], facts?: Pick<SettleTicketAttemptRequest, 'workspaceReceipt'>): Promise<TicketView>
    }) => void,
  ): Promise<TicketView> {
    this.assertCaller(request.actorId)
    if (request.workspace.kind === 'shared-workspace') await this.reconcileStoredReservations()
    const key = JSON.stringify([session.id, request.ticketId, request.attemptId])
    const recorded = capture === undefined ? undefined : () => {
      if (!this.settlements.has(key)) {
        this.settlements.set(key, {
          rootId: session.id, ticketId: request.ticketId, attemptId: request.attemptId, assignmentId: request.assignmentId,
          actorId: request.actorId, diagnostics: [],
        })
      }
      const settlement = this.settlements.get(key)
      if (settlement !== undefined) capture(this.recorder(settlement))
    }
    // Scope checks and append run synchronously in the Session queue; durability never holds a host-wide lock.
    return await this.attemptOperation(session, request, 'begin', (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
      this.assertParticipant(ticket, request.actorId, assignment.id)
      if (ticket.operations.some(item => item.id === executionOperationId(request.attemptId, 'settled'))) throw new TicketError('Execution settlement identity is already used; choose a fresh attempt identity', 'TICKET_OPERATION_CONFLICT')
      if (request.assignmentRevision !== undefined && assignment.revision !== request.assignmentRevision) throw new TicketError('Assignment revision changed', 'TICKET_STALE_REVISION')
      if (ticket.attempts.some(attempt => attempt.id === request.attemptId)) throw new TicketError('attempt identity is already used', 'TICKET_ATTEMPT_STATE')
      if (ticket.attempts.some(attempt => attempt.assignmentId === assignment.id && attempt.status !== 'settled')) throw new TicketError('previous attempt has not settled', 'TICKET_ATTEMPT_STATE')
      if (request.workspace.kind === 'shared-workspace') {
        for (const root of this.ctx.sessions.list()) this.retainScopes(root)
        const held: (Omit<TicketProducerReservation, 'ticketId' | 'attemptId'> & { readonly producer: boolean })[] = []
        for (const { root, attempt, scopes } of this.scopeReservations.values()) {
          held.push({ rootId: root, workspace: attempt.workspace, executor: attempt.executor, scopes, producer: false })
        }
        // Execution producers can outlive the service generations and the root log that admitted them.
        this.ctx.emit('ticket/collect-reservations', (reservation) => {
          if (reservation.workspace.kind === 'shared-workspace') held.push({ ...reservation, producer: true })
        })
        for (const reservation of held) {
          const world = request.executor.kind === 'remote' ? request.executor.world : undefined
          const otherWorld = reservation.executor.kind === 'remote' ? reservation.executor.world : undefined
          if (world !== otherWorld) continue
          const conflict = assignment.workScopes.some(scope => reservation.scopes.some((reserved) => {
            if (scope.access !== 'write' || reserved.access !== 'write' || (!scope.exclusive && !reserved.exclusive)) return false
            const path = resolve(request.workspace.directory, scope.path)
            const otherPath = resolve(reservation.workspace.directory, reserved.path)
            const contains = (parent: string, child: string) => {
              const suffix = relative(parent, child)
              return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep)
            }
            return contains(path, otherPath) || contains(otherPath, path)
          }))
          if (conflict && reservation.producer) {
            throw new TicketError(`Exclusive write scope is reserved by a producer of Session "${reservation.rootId}" that may still be writing; `
              + 'it is released when that producer stops or a host settles its attempt', 'TICKET_ATTEMPT_STATE')
          }
          if (conflict) {
            throw new TicketError(`Exclusive write scope is reserved by unsettled work in Session "${reservation.rootId}"; settle that work, `
              + 'or resume that Session so recovery can settle it', 'TICKET_ATTEMPT_STATE')
          }
        }
      }
      if (ticket.specification.dependencies.some(id => this.get(session, id).terminalOutcome?.kind !== 'completed')) throw new TicketError('dependencies must be accepted before execution', 'TICKET_ACCEPTANCE')
      if (ticket.attempts.length >= this.config.maxReports) throw new TicketError('attempt limit exhausted', 'TICKET_LIMIT')
      const now = Date.now()
      const attempt: TicketAttemptSnapshot = {
        id: request.attemptId, assignmentId: assignment.id, assignmentRevision: assignment.revision,
        specRevision: ticket.specification.revision, workspace: request.workspace, executor: request.executor,
        ...request.modelSelection === undefined ? {} : { modelSelection: request.modelSelection },
        diagnostics: [], status: 'preparing', createdAt: now, updatedAt: now,
      }
      const assignments = ticket.assignments.map(item => item.id === assignment.id
        ? { ...item, revision: item.revision + 1, activeAttemptId: attempt.id, attempts: item.attempts + 1, status: 'running' as const } : item)
      const next = { ...ticket, assignments, attempts: [...ticket.attempts, attempt] }
      return { ...next, status: nextStatusForAssignment(next) }
    }, recorded === undefined ? {} : { recorded, admittedBy: executionOperationId(request.attemptId, 'admitted') })
  }

  /** Attempt-bound recorder over the settlement ledger; every write resolves the root Session by id when it runs. */
  private recorder(settlement: Settlement): TicketAttemptController {
    return {
      update: async (stage, facts) => {
        const root = this.liveRoot(settlement)
        const update = {
          ...this.settlementRequest(settlement, root), ...facts, operationId: executionOperationId(settlement.attemptId, stage),
        }
        return this.attemptOperation(root, update, 'update', current => this.changeAttempt(current, update, attempt => ({
          ...attempt, ...facts, diagnostics: [...attempt.diagnostics, ...facts.diagnostics ?? []], updatedAt: Date.now(),
        }), true), { executionOwned: true })
      },
      settle: (outcome, facts) => {
        // The ledger takes ownership synchronously, before any write that can fail.
        settlement.outcome ??= outcome
        settlement.workspaceReceipt ??= facts?.workspaceReceipt
        return this.writeSettlement(settlement)
      },
    }
  }

  private settlementRequest(settlement: Settlement, root: Session) {
    return {
      ticketId: settlement.ticketId, attemptId: settlement.attemptId, assignmentId: settlement.assignmentId,
      actorId: settlement.actorId, expectedRevision: this.get(root, settlement.ticketId).revision,
    }
  }

  private liveRoot(settlement: Settlement): Session {
    const root = this.ctx.sessions.get(settlement.rootId)
    if (root === undefined) {
      throw new TicketError(`Ticket root Session "${settlement.rootId}" is not live; resume it, then retry`, 'TICKET_ROOT_UNAVAILABLE')
    }
    return root
  }

  /** Write the ledger's settlement to the live root; the entry and its reservation leave only after a durable flush. */
  private async writeSettlement(settlement: Settlement): Promise<TicketView> {
    const { outcome } = settlement
    if (outcome === undefined) throw new TicketError('Ticket attempt settlement has no observed outcome', 'TICKET_ATTEMPT_STATE')
    const pending = (cause?: unknown) => new TicketError(`Ticket attempt "${settlement.attemptId}" ended ${outcome}; `
      + `resume Session "${settlement.rootId}" to persist its settlement`, 'TICKET_SETTLEMENT_PENDING', cause === undefined ? undefined : { cause })
    const root = this.ctx.sessions.get(settlement.rootId)
    if (root === undefined) throw pending()
    const settle = { ...this.settlementRequest(settlement, root), outcome, operationId: executionOperationId(settlement.attemptId, 'settled') }
    try {
      return await this.attemptOperation(root, settle, 'settle', (current) => {
        const changed = this.changeAttempt(current, settle, (attempt) => {
          const workspaceReceipt = attempt.workspaceReceipt ?? settlement.workspaceReceipt
          return {
            ...attempt, status: 'settled', outcome, updatedAt: Date.now(), diagnostics: [...attempt.diagnostics, ...settlement.diagnostics],
            ...workspaceReceipt === undefined ? {} : { workspaceReceipt },
          }
        }, true)
        // Settlement releases execution resources; a successful contribution stays open for its result report.
        const assignments = outcome === 'succeeded' ? changed.assignments : changed.assignments.map(item => item.id === settlement.assignmentId
          && ['running', 'claimed', 'assigned'].includes(item.status) ? { ...item, status: 'released' as const, revision: item.revision + 1 } : item)
        const next = { ...changed, assignments }
        return { ...next, status: nextStatusForAssignment(next) }
      }, { executionOwned: true, settledByAnyOperation: settlement.attemptId })
    } catch (error: unknown) {
      if (this.ctx.sessions.get(settlement.rootId) !== root) throw pending(error)
      throw error
    }
  }

  /** Finish what this service owns for one root that became live: replay known outcomes, and settle in-process attempts
   * an earlier host admitted, since their producers ended with that host. An attempt whose reservation is still registered
   * on the root context belongs to producers that run in this host, whatever service generation admitted them. */
  private async recoverRoot(session: Session): Promise<void> {
    if (this.projection === undefined || this.ctx.sessions.get(session.id) !== session) return
    const writes: Promise<unknown>[] = []
    for (const settlement of this.settlements.values()) {
      if (settlement.rootId === session.id && settlement.outcome !== undefined) writes.push(this.writeSettlement(settlement))
    }
    const state = this.projection.stateOf(session)
    if (!this.activationRoots.has(session.id) && state.failure === undefined) {
      const owned = new Set<string>()
      this.ctx.emit('ticket/collect-reservations', (reservation) => {
        if (reservation.rootId === session.id) owned.add(JSON.stringify([session.id, reservation.ticketId, reservation.attemptId]))
      })
      for (const ticket of state.tickets) for (const attempt of ticket.attempts) {
        const key = JSON.stringify([session.id, ticket.id, attempt.id])
        // Only the execution owner writes reserved operation records, starting with its admission, so they mark an attempt
        // this host family admitted. Before its workspace stage no producer of any placement has started; an in-process
        // producer ends with its host in every unsettled phase.
        const inProcess = attempt.executor.kind === 'in-process' && ['preparing', 'running', 'stopping'].includes(attempt.status)
        if (owned.has(key) || this.settlements.has(key) || (!inProcess && attempt.status !== 'preparing')
          || !ticket.operations.some(item => item.id.startsWith(executionOperationPrefix(attempt.id)))) continue
        const settlement: Settlement = {
          rootId: session.id, ticketId: ticket.id, attemptId: attempt.id, assignmentId: attempt.assignmentId, actorId: session.id,
          outcome: 'cancelled', diagnostics: [inProcess ? 'The in-process producer ended with the host that admitted it; recovered as cancelled'
            : 'The admission ended with the host that admitted it before any producer started; recovered as cancelled'],
        }
        this.settlements.set(key, settlement)
        writes.push(this.writeSettlement(settlement))
      }
    }
    const failures = (await Promise.allSettled(writes))
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Ticket attempt recovery did not persist')
  }

  /** Teardown makes one last attempt for known outcomes and reports what stays pending for the next resume. */
  private async drainSettlements(): Promise<void> {
    for (const settlement of [...this.settlements.values()]) {
      if (settlement.outcome === undefined) continue
      try { await this.writeSettlement(settlement) } catch (error: unknown) {
        this.ctx.logger.warn(`Ticket attempt "${settlement.attemptId}" in Session "${settlement.rootId}" ended ${settlement.outcome}, `
          + `but its settlement is not durable; resuming that Session settles it: ${String(error)}`)
      }
    }
  }

  /** Record runtime receipts, stopping or uncertainty without releasing work.
   * @param session - Owning Session.
   * @param request - Current attempt and stable operation identity.
   * @returns Durably flushed Ticket, including on retry; obsolete attempts and replaced receipts are rejected.
   */
  async updateAttempt(session: Session, request: UpdateTicketAttemptRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.attemptOperation(session, request, 'update', ticket => this.changeAttempt(ticket, request, attempt => ({
      ...attempt, status: request.status, updatedAt: Date.now(),
      ...request.workspaceReceipt === undefined ? {} : { workspaceReceipt: request.workspaceReceipt },
      ...request.runtimeReceipt === undefined ? {} : { runtimeReceipt: request.runtimeReceipt },
      diagnostics: [...attempt.diagnostics, ...request.diagnostics ?? []],
    })))
  }

  /** Record observed producer settlement; result reports alone never settle attempts.
   * @param session - Owning Session.
   * @param request - Current attempt, observed outcome and retained receipts.
   * @returns Durably flushed Ticket with settled work; retries repeat the flush before returning.
   */
  async settleAttempt(session: Session, request: SettleTicketAttemptRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.attemptOperation(session, request, 'settle', ticket => this.changeAttempt(ticket, request, attempt => ({
      ...attempt, status: 'settled', outcome: request.outcome, updatedAt: Date.now(),
      ...request.workspaceReceipt === undefined ? {} : { workspaceReceipt: request.workspaceReceipt },
      ...request.runtimeReceipt === undefined ? {} : { runtimeReceipt: request.runtimeReceipt },
      diagnostics: [...attempt.diagnostics, ...request.diagnostics ?? []],
    })))
  }

  /** Pin immutable content and the contributing Assignments for the current specification.
   * @param session - Owning Session.
   * @param request - New candidate identity and immutable content reference.
   * @returns Committed Ticket; all older checks remain historical.
   */
  async submitCandidate(session: Session, request: SubmitTicketCandidateRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'submit-candidate', ticketId: request.ticketId }, (ticket) => {
      this.assertParticipant(ticket, request.actorId)
      if (request.specRevision !== ticket.specification.revision) throw new TicketError('candidate specification is stale', 'TICKET_STALE_REVISION')
      if (ticket.candidates.length >= this.config.maxReports) throw new TicketError('candidate limit exhausted', 'TICKET_LIMIT')
      for (const id of request.assignmentIds) {
        const assignment = this.assignment(ticket, id)
        const report = ticket.reports.find(item => item.id === assignment.latestReportId)
        if (report?.kind !== 'result' || report.specRevision !== ticket.specification.revision) throw new TicketError(`Assignment "${id}" requires a current result before candidate submission`, 'TICKET_ACCEPTANCE')
      }
      return { ...ticket, currentCandidateId: request.candidateId, candidates: [...ticket.candidates, {
        id: request.candidateId, specRevision: request.specRevision, content: request.content,
        assignmentIds: [...request.assignmentIds],
        reportIds: request.assignmentIds.flatMap((id) => {
          const reportId = this.assignment(ticket, id).latestReportId
          return reportId === undefined ? [] : [reportId]
        }), authorId: request.actorId, createdAt: Date.now(),
      }] }
    })
  }

  /** Append criterion evidence; independent authors cannot contribute to the candidate.
   * @param session - Owning Session.
   * @param request - Current candidate, criterion and evidence.
   * @returns Committed Ticket; stale checks append nothing.
   */
  async checkCandidate(session: Session, request: CheckTicketCandidateRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'check-candidate', ticketId: request.ticketId }, (ticket) => {
      this.assertParticipant(ticket, request.actorId)
      if (ticket.currentCandidateId !== request.candidateId || ticket.specification.revision !== request.specRevision) throw new TicketError('check candidate or specification is stale', 'TICKET_STALE_REVISION')
      const criterion = ticket.specification.acceptanceCriteria.find(item => item.id === request.criterionId)
      const candidate = ticket.candidates.find(item => item.id === request.candidateId)
      if (criterion === undefined || candidate === undefined) throw new TicketError('unknown candidate criterion', 'TICKET_INVALID_INPUT')
      if (criterion.independent && (candidate.authorId === request.actorId || ticket.assignments.some(assignment => candidate.assignmentIds.includes(assignment.id) && assignment.ownerId === request.actorId))) throw new TicketError('independent check author contributed to candidate', 'TICKET_AUTHORITY')
      if (ticket.checks.length >= this.config.maxReports) throw new TicketError('check limit exhausted', 'TICKET_LIMIT')
      return { ...ticket, checks: [...ticket.checks, {
        id: request.checkId, candidateId: request.candidateId, criterionId: request.criterionId,
        specRevision: request.specRevision, authorId: request.actorId, outcome: request.outcome,
        evidence: [...request.evidence], createdAt: Date.now(),
      }] }
    })
  }

  /** Version a Mission's Ticket references without adding mutable completion state.
   * @param session - Owning Session.
   * @param request - Plan references and current Ticket/plan revisions.
   * @returns Committed Ticket containing the new plan revision.
   */
  async planMission(session: Session, request: PlanTicketMissionRequest): Promise<TicketView> {
    this.assertCaller(request.actorId)
    return await this.mutate(session, request, { kind: 'plan-mission', ticketId: request.ticketId }, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      const previous = ticket.missionPlans.find(plan => plan.id === request.missionId)
      if ((previous?.revision ?? 0) !== request.expectedPlanRevision) throw new TicketError('Mission plan revision changed', 'TICKET_STALE_REVISION')
      if (previous === undefined && ticket.missionPlans.length >= this.config.maxTickets) throw new TicketError('Mission plan limit exhausted', 'TICKET_LIMIT')
      const plan = {
        id: request.missionId, revision: request.expectedPlanRevision + 1,
        title: request.title, milestones: [...request.milestones],
      }
      const missionPlans = previous === undefined
        ? [...ticket.missionPlans, plan]
        : ticket.missionPlans.map(item => item.id === plan.id ? plan : item)
      return { ...ticket, missionPlans }
    })
  }

  /** Read Mission progress derived solely from referenced Ticket acceptance.
   * @param session - Owning Session.
   * @param ticketId - Ticket containing the plan.
   * @param missionId - Mission identity.
   * @returns Current plan with accepted and total Ticket counts.
   */
  mission(session: Session, ticketId: TicketId, missionId: MissionId): MissionView {
    const plan = this.get(session, ticketId).missionPlans.find(item => item.id === missionId)
    if (plan === undefined) throw new TicketError('unknown Mission', 'TICKET_INVALID_INPUT')
    const milestones = plan.milestones.map(item => ({
      title: item.title, total: item.ticketIds.length,
      completed: item.ticketIds.filter(id => this.get(session, id).terminalOutcome?.kind === 'completed').length,
    }))
    return {
      plan, milestones,
      completed: milestones.reduce((sum, item) => sum + item.completed, 0),
      total: milestones.reduce((sum, item) => sum + item.total, 0),
    }
  }

  private changeAttempt(
    ticket: TicketSnapshot,
    request: TicketMutationRequest & { readonly attemptId: TicketAttemptId },
    update: (attempt: TicketAttemptSnapshot) => TicketAttemptSnapshot,
    executionOwned = false,
  ): TicketSnapshot {
    const attempt = ticket.attempts.find(item => item.id === request.attemptId)
    if (attempt === undefined) throw new TicketError('unknown attempt', 'TICKET_STALE_ATTEMPT')
    const assignment = this.assignment(ticket, attempt.assignmentId)
    if (!executionOwned) this.assertParticipant(ticket, request.actorId, assignment.id)
    if (assignment.activeAttemptId !== attempt.id) throw new TicketError('attempt has been superseded', 'TICKET_STALE_ATTEMPT')
    if (attempt.status === 'settled') throw new TicketError('attempt is already settled', 'TICKET_ATTEMPT_STATE')
    const next = update(attempt)
    return { ...ticket, attempts: ticket.attempts.map(item => item.id === next.id ? next : item) }
  }

  private async attemptOperation<T extends TicketMutationRequest & { readonly operationId: TicketOperationId }>(
    session: Session, request: T, kind: 'begin' | 'update' | 'settle', update: (ticket: TicketSnapshot) => TicketSnapshot,
    options: AttemptOperationOptions = {},
  ): Promise<TicketView> {
    const { executionOwned = false } = options
    if (!executionOwned && request.operationId.startsWith('ticket-execution:')) throw new TicketError('Operation prefix ticket-execution: is reserved for execution facts; choose another operation identity', 'TICKET_INVALID_INPUT')
    const { expectedRevision: _revision, ...payload } = request
    const legacyFingerprint = operationFingerprint({ kind, ...payload })
    const fingerprint = createHash('sha256').update(legacyFingerprint).digest('hex')
    return await this.enqueue(session, async (governance) => {
      const ticket = this.get(session, request.ticketId)
      if (!executionOwned) this.assertParticipant(ticket, request.actorId)
      const operation = ticket.operations.find(item => item.id === request.operationId)
      if (operation !== undefined) {
        if (operation.request !== fingerprint && operation.request !== legacyFingerprint) throw new TicketError('operation identity was reused with different arguments', 'TICKET_OPERATION_CONFLICT')
        options.recorded?.()
        await this.durable(session)
        return ticket
      }
      // Settlement compacted this committed operation into its tombstone; an identical retry reports the recorded Ticket.
      const tombstone = ticket.operations.find(item => item.retiredIds?.includes(request.operationId))
      if (tombstone !== undefined) {
        if (!('attemptId' in request) || request.attemptId !== tombstone.attemptId) throw new TicketError('Operation belongs to another, settled attempt', 'TICKET_ATTEMPT_STATE')
        const retired = tombstone.retiredRequests?.[tombstone.retiredIds?.indexOf(request.operationId) ?? -1]
        if (retired !== undefined && retired !== fingerprint && retired !== legacyFingerprint) throw new TicketError('operation identity was reused with different arguments', 'TICKET_OPERATION_CONFLICT')
        await this.durable(session)
        return ticket
      }
      if (options.settledByAnyOperation !== undefined
        && ticket.attempts.some(item => item.id === options.settledByAnyOperation && item.status === 'settled')) {
        await this.durable(session)
        return ticket
      }
      if (!executionOwned && ticket.revision !== request.expectedRevision) throw new TicketError('Ticket revision changed', 'TICKET_STALE_REVISION')
      if (ticket.terminalOutcome !== undefined) throw new TicketError('Ticket is terminal', 'TICKET_TERMINAL')
      const changed = update(ticket)
      const attemptId = 'attemptId' in request && typeof request.attemptId === 'string'
        ? changed.attempts.find(item => item.id === request.attemptId)?.id : undefined
      const retired = attemptId === undefined || !changed.attempts.some(item => item.id === attemptId && item.status === 'settled')
        ? [] : ticket.operations.filter(item => item.attemptId === attemptId)
      // Fingerprints are retained only when every retired id has one, so the two lists stay aligned index for index.
      const retiredRequests = retired.every(item => (item.retiredIds?.length ?? 0) === (item.retiredRequests?.length ?? 0))
        ? retired.flatMap(item => [item.request, ...item.retiredRequests ?? []]) : undefined
      const admitted = options.admittedBy === undefined || attemptId === undefined ? []
        : [{ id: options.admittedBy, request: fingerprint, attemptId }]
      const next = {
        ...changed, revision: ticket.revision + 1, updatedAt: Date.now(),
        operations: [...ticket.operations.filter(item => !retired.includes(item)), ...admitted, {
          id: request.operationId, request: fingerprint,
          ...attemptId === undefined ? {} : { attemptId },
          ...retired.length === 0 ? {} : {
            retiredIds: retired.flatMap(item => [item.id, ...item.retiredIds ?? []]),
            ...retiredRequests === undefined ? {} : { retiredRequests },
          },
        }],
      }
      if (!executionOwned) this.authorize(governance, session, request.actorId, { kind: `${kind}-attempt`, ticketId: request.ticketId })
      this.append(session, next)
      options.recorded?.()
      await this.durable(session)
      return next
    }, executionOwned)
  }

  /** Alias for {@link create} used by adapters. */
  readonly createTicket: TicketService['create'] = this.create.bind(this)
  /** Alias for {@link assign} used by adapters. */
  readonly assignWorker: TicketService['assign'] = this.assign.bind(this)
  /** Alias for {@link claim} used by adapters. */
  readonly claimAssignment: TicketService['claim'] = this.claim.bind(this)
  /** Alias for {@link release} used by adapters. */
  readonly releaseAssignment: TicketService['release'] = this.release.bind(this)
  /** Alias for {@link report} used by adapters. */
  readonly reportResult: TicketService['report'] = this.report.bind(this)
  /** Alias for {@link ask} used by adapters. */
  readonly askQuestion: TicketService['ask'] = this.ask.bind(this)
  /** Alias for {@link attention} used by adapters. */
  readonly requestAttention: TicketService['attention'] = this.attention.bind(this)
  /** Alias for {@link handoff} used by adapters. */
  readonly handoffCoordinator: TicketService['handoff'] = this.handoff.bind(this)

  private question(ticket: TicketSnapshot, id: TicketQuestionId): TicketQuestionSnapshot {
    const question = ticket.questions.find(item => item.id === id)
    if (question === undefined) throw new TicketError(`unknown question "${id}"`, 'TICKET_INVALID_INPUT')
    return question
  }

  private async updateAttention(session: Session, request: UpdateTicketAttentionRequest, status: 'acknowledged' | 'resolved'): Promise<TicketView> {
    return await this.mutate(session, request, { kind: status === 'resolved' ? 'resolve' : 'acknowledge', ticketId: request.ticketId }, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      const attention = ticket.attentions.find(item => item.id === request.attentionId)
      if (attention === undefined) throw new TicketError(`unknown attention "${request.attentionId}"`, 'TICKET_INVALID_INPUT')
      if (attention.status === 'resolved' || (status === 'acknowledged' && attention.status !== 'open')) {
        throw new TicketError('attention item cannot make this status change', 'TICKET_INVALID_INPUT')
      }
      const next = { ...ticket, attentions: ticket.attentions.map(item => item.id === attention.id
        ? { ...item, status, ...status === 'resolved' ? { resolvedAt: Date.now() } : {} } : item) }
      return { ...next, status: nextStatusForAssignment(next) }
    })
  }

  private async end(session: Session, request: EndTicketRequest, status: Extract<TicketStatus, 'completed' | 'failed' | 'cancelled'>): Promise<TicketView> {
    return await this.mutate(session, request, { kind: 'end', ticketId: request.ticketId }, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      if (ticket.terminalOutcome !== undefined || ticket.status === 'completed' || ticket.status === 'failed' || ticket.status === 'cancelled') throw new TicketError(`Ticket "${ticket.id}" is already terminal`, 'TICKET_TERMINAL')
      for (const attempt of ticket.attempts) admitCommand(attempt, 'end-ticket')
      if (status === 'completed') assertTicketAcceptance(ticket, this.state(session).tickets)
      const summary = nonEmpty('terminal summary', request.summary)
      const at = Date.now()
      return {
        ...ticket,
        status,
        terminalOutcome: { kind: status, summary, actorId: request.actorId, at },
      }
    })
  }

  private state(session: Session): TicketProjectionState {
    if (this.projection === undefined) throw new TicketError('Ticket service is not initialized', 'TICKET_RECOVERY_FAILED')
    const state = this.projection.stateOf(session)
    if (state.failure !== undefined) throw new TicketError(`Ticket recovery failed: ${state.failure}`, 'TICKET_RECOVERY_FAILED')
    return state
  }

  private async mutate(
    session: Session,
    { ticketId: id, expectedRevision, actorId }: TicketMutationRequest,
    command: TicketCommand,
    update: (ticket: TicketSnapshot) => TicketSnapshot,
  ): Promise<TicketView> {
    return await this.enqueue(session, async (governance) => {
      const ticket = this.get(session, id)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new TicketError('expectedRevision must be a positive safe integer', 'TICKET_INVALID_INPUT')
      if (ticket.revision !== expectedRevision) throw new TicketError(`Ticket "${id}" is at revision ${String(ticket.revision)}, expected ${String(expectedRevision)}`, 'TICKET_STALE_REVISION')
      if (ticket.terminalOutcome !== undefined) throw new TicketError(`Ticket "${id}" is terminal`, 'TICKET_TERMINAL')
      const changed = update(ticket)
      const next: TicketSnapshot = {
        ...changed,
        id: ticket.id,
        revision: ticket.revision + 1,
        createdAt: ticket.createdAt,
        updatedAt: Date.now(),
      }
      this.authorize(governance, session, actorId, command)
      await this.commit(session, next)
      return next
    })
  }

  /** Queue one command on the root's tail. The governing authorities are fixed here, at admission, so removing an authority
   * later never leaves a command that was already queued ungoverned. */
  private async enqueue<T>(session: Session, operation: (governance: Governance) => Promise<T>, executionOwned = false): Promise<T> {
    const prior = this.tails.get(session.id) ?? Promise.resolve()
    const admitted: Governance = { coordinators: [...this.coordinatorAuthorities], commands: [...this.commandAuthorities] }
    const run = () => { if (!executionOwned) this.assertCaller(undefined); return operation(admitted) }
    const next = prior.then(run, run)
    this.tails.set(session.id, next.then(() => undefined, () => undefined))
    return await next
  }

  private async commit(session: Session, ticket: TicketSnapshot): Promise<void> {
    this.append(session, ticket)
    await this.durable(session)
  }

  /** Validate and append one complete snapshot to the exact live Session; durability is the caller's next step. */
  private append(session: Session, ticket: TicketSnapshot): void {
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new TicketError(`Ticket Session "${session.id}" is not live; resume it, then retry`, 'TICKET_ROOT_UNAVAILABLE')
    }
    const previous = this.state(session).tickets.find(candidate => candidate.id === ticket.id)
    try {
      validateTicketChange(previous, ticket)
      const tickets = [...this.state(session).tickets.filter(item => item.id !== ticket.id), ticket]
      validateTicketReferences(tickets)
      if (ticket.terminalOutcome?.kind === 'completed') assertTicketAcceptance(ticket, tickets)
    } catch (error) {
      throw new TicketError('Ticket candidate violates schema or lifecycle rules', 'TICKET_INVALID_INPUT', { cause: error })
    }
    // Every writer preserves room for uncertainty, minimal settlement, and a terminal Ticket summary.
    const unsettled = ticket.attempts.filter(attempt => attempt.status !== 'settled')
    const reserved = {
      ...ticket, revision: Number.MAX_SAFE_INTEGER, updatedAt: Number.MAX_SAFE_INTEGER,
      ...ticket.terminalOutcome === undefined ? {
        status: 'cancelled', terminalOutcome: { kind: 'cancelled', summary: 'x', actorId: ticket.coordinatorId, at: Number.MAX_SAFE_INTEGER },
      } : {},
      attempts: ticket.attempts.map(attempt => attempt.status === 'settled' ? attempt : {
        ...attempt, status: 'settled', outcome: 'cancelled', updatedAt: Number.MAX_SAFE_INTEGER,
        diagnostics: [...attempt.diagnostics, ...uncertaintyStages
          .filter(stage => !ticket.operations.some(item => item.id === executionOperationId(attempt.id, stage)))
          .map(stage => uncertaintyDiagnostic(stage))],
      }),
      assignments: ticket.assignments.map(item => unsettled.some(attempt => attempt.assignmentId === item.id)
        ? { ...item, status: 'released', revision: Number.MAX_SAFE_INTEGER } : item),
      operations: [...ticket.operations, ...unsettled.flatMap(attempt =>
        [...uncertaintyStages, 'settled'].filter(stage => !ticket.operations.some(item => item.id === executionOperationId(attempt.id, stage)))
          .map(stage => ({ id: executionOperationId(attempt.id, stage), request: '0'.repeat(64), attemptId: attempt.id })))],
    }
    const bytes = Math.max(textBytes(JSON.stringify(ticket)), textBytes(JSON.stringify(reserved)))
    if (bytes > this.config.maxSnapshotBytes) throw new TicketError(`Ticket snapshot exceeds ${String(this.config.maxSnapshotBytes)} bytes`, 'TICKET_SNAPSHOT_TOO_LARGE')
    session.append('ticket/state', { version: 2, sessionId: session.id, ticket })
  }

  /** Flush the exact live Session, then release the reservations and settlement ownership its settled attempts held.
   * A Session object outside the store has nothing to flush without persistence; with persistence it must be resumed. */
  private async durable(session: Session): Promise<void> {
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
    else if (this.ctx.get('sessionPersistence') !== undefined) {
      throw new TicketError(`Ticket Session "${session.id}" is not live; resume it, then retry`, 'TICKET_ROOT_UNAVAILABLE')
    }
    const state = this.state(session)
    for (const ticket of state.tickets) for (const attempt of ticket.attempts) {
      if (attempt.status !== 'settled') continue
      const key = JSON.stringify([session.id, ticket.id, attempt.id])
      this.scopeReservations.delete(key)
      this.settlements.delete(key)
    }
  }

  private retainScopes(session: Session): void {
    if (this.projection === undefined) return
    this.retainState(session.id, this.projection.stateOf(session))
  }

  private retainState(root: SessionId, state: TicketProjectionState): void {
    for (const ticket of state.tickets) for (const attempt of ticket.attempts) {
      if (attempt.status === 'settled' || attempt.workspace.kind !== 'shared-workspace') continue
      this.scopeReservations.set(JSON.stringify([root, ticket.id, attempt.id]), {
        root, attempt, scopes: this.assignment(ticket, attempt.assignmentId).workScopes,
      })
    }
    if (state.failure !== undefined) this.reportRecoveryFailure(root, state.failure)
  }

  /** Bring stored-root reservations up to date before a shared-workspace admission.
   *
   * The first call lists storage and folds only the `ticket/state` events of each stored root that is not live; activation
   * reads no log. A listing failure or an unreadable root refuses the admission and is retried by the next one. When a root's
   * stored Session no longer exists, its reservations are released unless an owner in this host still awaits its producer's
   * outcome; that owner releases them once it hands an outcome to the ledger.
   */
  private async reconcileStoredReservations(): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return
    this.storedScan ??= persistence.list().then(async (stored) => {
      for (const { header } of stored) {
        if (this.ctx.sessions.get(header.id) === undefined) await this.scanStoredRoot(persistence, header.id)
      }
    })
    try { await this.storedScan } catch (cause: unknown) {
      this.storedScan = undefined
      throw new TicketError('Stored Ticket reservations could not be listed; shared-workspace admission is refused until storage '
        + 'recovers, then retry', 'TICKET_RECOVERY_FAILED', { cause })
    }
    const stale = new Set([...this.unreadableRoots.keys(), ...[...this.scopeReservations.values()].map(item => item.root)])
    for (const root of stale) {
      if (this.ctx.sessions.get(root) !== undefined || await persistence.stat(root) !== undefined) continue
      this.unreadableRoots.delete(root)
      // Deleting a log is not producer settlement: an owner in this host that has not observed its outcome keeps its scopes.
      const owned = (key: string) => this.settlements.has(key) && this.settlements.get(key)?.outcome === undefined
      for (const [key, reservation] of this.scopeReservations) {
        if (reservation.root === root && !owned(key)) this.scopeReservations.delete(key)
      }
      for (const [key, settlement] of this.settlements) {
        if (settlement.rootId !== root || settlement.outcome === undefined) continue
        this.settlements.delete(key)
        this.ctx.logger.warn(`Ticket attempt "${settlement.attemptId}" ended ${settlement.outcome}, but its root Session "${root}" `
          + 'was deleted before the settlement could be persisted; the outcome is discarded with that Session')
      }
    }
    for (const root of [...this.unreadableRoots.keys()]) await this.scanStoredRoot(persistence, root)
    if (this.unreadableRoots.size > 0) {
      const roots = [...this.unreadableRoots.keys()].map(root => `"${root}"`).join(', ')
      throw new TicketError(`Stored Session ${roots} could not be read to rebuild its Ticket reservations; shared-workspace admission `
        + 'is refused until it is readable or removed, then retry', 'TICKET_RECOVERY_FAILED', { cause: [...this.unreadableRoots.values()][0] })
    }
  }

  private async scanStoredRoot(persistence: SessionPersistence, root: SessionId): Promise<void> {
    try {
      await using stored = await persistence.open(root, 'read')
      const log = await stored.read()
      let state = ticketProjectionDefinition.init(stored.header)
      for (const event of log.events) if (event.type === 'ticket/state') state = ticketProjectionDefinition.apply(state, event)
      this.unreadableRoots.delete(root)
      // A root resumed during the read publishes its own reservations from its live log.
      if (this.ctx.sessions.get(root) === undefined) this.retainState(root, state)
    } catch (error: unknown) {
      this.unreadableRoots.set(root, error)
      this.reportRecoveryFailure(root, error)
    }
  }

  private reportRecoveryFailure(root: SessionId, cause: unknown): void {
    if (this.recoveryFailures.has(root)) return
    this.recoveryFailures.add(root)
    this.ctx.logger.warn(`Ticket recovery failed for Session "${root}"; known scopes remain reserved. Resume and repair that Session before continuing its work: ${String(cause)}`)
  }

  private assignment(ticket: TicketSnapshot, id: AssignmentId): AssignmentSnapshot {
    const assignment = ticket.assignments.find(candidate => candidate.id === id)
    if (assignment === undefined) throw new TicketError(`unknown Assignment "${id}"`, 'TICKET_ASSIGNMENT_NOT_FOUND')
    return assignment
  }

  /** The coordinator a new Ticket names: the first replacement a governing authority decides, else the requested one. */
  private authorizedCoordinator(governance: Governance, session: Session, requested: SessionId): SessionId {
    for (const authority of new Set([...governance.coordinators, ...this.coordinatorAuthorities])) {
      const coordinatorId = authority(session, requested)
      if (coordinatorId !== undefined) return coordinatorId
    }
    return requested
  }

  /** Consult every governing command authority, synchronously, immediately before the append. */
  private authorize(governance: Governance, session: Session, actorId: SessionId, command: TicketCommand): void {
    for (const authority of new Set([...governance.commands, ...this.commandAuthorities])) {
      try { authority(session, actorId, command) } catch (cause: unknown) {
        if (cause instanceof TicketError) throw cause
        throw new TicketError('Ticket command authority failed', 'TICKET_RECOVERY_FAILED', { cause })
      }
    }
  }

  private assertCaller(actorId: SessionId | undefined): Agent {
    const caller = this.ctx.agents.currentInitiator()
    if (caller === undefined || this.ctx.agents.get(caller.id) !== caller
      || this.ctx.sessions.get(caller.id) !== caller.session || (actorId !== undefined && caller.id !== actorId)) {
      throw new TicketError('Ticket mutation requires the exact live initiating Agent matching actorId', 'TICKET_AUTHORITY')
    }
    return caller
  }

  private assertCoordinator(ticket: TicketSnapshot, actorId: SessionId): void {
    if (ticket.coordinatorId !== actorId) throw new TicketError('only the current coordinator may perform this command', 'TICKET_AUTHORITY')
  }

  private assertParticipant(ticket: TicketSnapshot, actorId: SessionId, assignmentId?: AssignmentId): void {
    if (assignmentId !== undefined) this.assignment(ticket, assignmentId)
    if (ticket.coordinatorId === actorId) return
    if (ticket.assignments.some(assignment =>
      (assignmentId === undefined || assignment.id === assignmentId) && assignment.ownerId === actorId)) return
    throw new TicketError('caller is not the coordinator or assigned worker', 'TICKET_AUTHORITY')
  }

  private validateAssignmentScopes(ticket: TicketSnapshot, requested: readonly WorkScope[] | undefined): WorkScope[] {
    const scopes = cloneScopes(requested, this.config.maxWorkScopes)
    if (ticket.workScopes.length === 0) return scopes
    for (const scope of scopes) {
      const covered = ticket.workScopes.some((parent) => {
        const parentPath = normalizeScopePath(parent.path)
        return (scope.access === 'read' || parent.access === 'write')
          && (parentPath === '.' || scope.path === parentPath || scope.path.startsWith(`${parentPath}/`))
      })
      if (!covered) throw new TicketError(`assignment work scope "${scope.path}" is outside the Ticket scope`, 'TICKET_INVALID_INPUT')
    }
    return scopes
  }
}

export default TicketService
