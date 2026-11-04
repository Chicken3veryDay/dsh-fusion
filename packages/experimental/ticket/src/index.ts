/** Host Ticket service: durable CAS lifecycle for direct-worker coordination. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { ticketProjectionDefinition, ticketSnapshotSchema } from './projection.ts'
import type { TicketProjectionState } from './projection.ts'
import {
  AssignmentId,
  ExecutionSlotId,
  TicketAttentionId,
  TicketId,
  TicketQuestionId,
  TicketReportId,
} from './types.ts'
import type {
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
  WorkScope,
} from './types.ts'

export type * from './types.ts'
export { ticketProjectionDefinition, ticketSnapshotSchema } from './projection.ts'
export { AssignmentId, ExecutionSlotId, TicketAttentionId, TicketId, TicketQuestionId, TicketReportId } from './types.ts'
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

/** Errors returned by Ticket commands, with stable machine-readable codes. */
export type TicketErrorCode =
  | 'TICKET_INVALID_INPUT'
  | 'TICKET_NOT_FOUND'
  | 'TICKET_STALE_REVISION'
  | 'TICKET_AUTHORITY'
  | 'TICKET_ASSIGNMENT_NOT_FOUND'
  | 'TICKET_ASSIGNMENT_STATE'
  | 'TICKET_TERMINAL'
  | 'TICKET_RECOVERY_FAILED'
  | 'TICKET_LIMIT'
  | 'TICKET_SNAPSHOT_TOO_LARGE'

/** Structured failure from a Ticket command or projection recovery. */
export class TicketError extends Error {
  constructor(message: string, readonly code: TicketErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TicketError'
  }
}

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

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function cloneScopes(scopes: readonly WorkScope[] | undefined, limit: number): WorkScope[] {
  const result = boundedList('workScopes', scopes, limit)
  for (const scope of result) {
    nonEmpty('work scope path', scope.path)
  }
  return result.map(scope => ({ ...scope }))
}

function nextStatusForAssignment(ticket: TicketSnapshot): TicketStatus {
  const live = ticket.assignments.some(assignment => assignment.status === 'assigned' || assignment.status === 'claimed' || assignment.status === 'running')
  const complete = ticket.assignments.length > 0 && ticket.assignments.every(assignment => assignment.status === 'completed' || assignment.status === 'cancelled')
  if (complete) return 'integrating'
  return live ? 'executing' : 'ready'
}

function activeSlot(slot: ExecutionSlotSnapshot | undefined): boolean {
  return slot?.status === 'reserved' || slot?.status === 'running'
}

/** Standalone durable Ticket domain service. */
export class TicketService extends Service {
  static inject = ['sessions', 'sessionProjections']

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
  private readonly tails = new Map<SessionId, Promise<void>>()

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
    this.ctx.effect(() => () => { this.tails.clear() }, 'tickets.runtime()')
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
    return await this.enqueue(session, async () => {
      const state = this.state(session)
      if (state.tickets.length >= this.config.maxTickets) throw new TicketError('Ticket limit exhausted', 'TICKET_LIMIT')
      const id = request.id ?? TicketId(`ticket-${session.id}-${String(state.tickets.length + 1)}`)
      if (state.tickets.some(ticket => ticket.id === id)) throw new TicketError(`Ticket "${id}" already exists`, 'TICKET_INVALID_INPUT')
      const subject = nonEmpty('subject', request.subject)
      const now = Date.now()
      const ticket: TicketSnapshot = {
        id,
        revision: 1,
        subject,
        description: request.description,
        status: 'proposed',
        coordinatorId: request.coordinatorId ?? session.id,
        assignments: [],
        reports: [],
        questions: [],
        attentions: [],
        workScopes: cloneScopes(request.workScopes, this.config.maxWorkScopes),
        executionSlots: [],
        createdAt: now,
        updatedAt: now,
      }
      ticketSnapshotSchema.parse(ticket)
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
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
      return { ...ticket, status: 'executing', assignments, executionSlots }
    })
  }

  /** Release one responsibility while preserving its durable worker owner.
   * @param session - Session whose log owns the Ticket.
   * @param request - Assignment release request.
   * @returns the committed Ticket view.
   */
  async release(session: Session, request: ReleaseAssignmentRequest): Promise<TicketView> {
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
      if (assignment.ownerId !== request.actorId && ticket.coordinatorId !== request.actorId) throw new TicketError('only the assigned worker or coordinator may report', 'TICKET_AUTHORITY')
      if (ticket.reports.length >= this.config.maxReports) throw new TicketError('report limit exhausted', 'TICKET_LIMIT')
      const summary = nonEmpty('report summary', request.summary)
      const id = TicketReportId(`report-${ticket.id}-${String(ticket.reports.length + 1)}`)
      const report: TicketReportSnapshot = {
        id,
        assignmentId: assignment.id,
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
      return { ...next, status: request.kind === 'failure' ? 'blocked' : nextStatusForAssignment(next) }
    })
  }

  /** Ask a durable question and move the Ticket into waiting.
   * @param session - Session whose log owns the Ticket.
   * @param request - worker question request.
   * @returns the committed Ticket view.
   */
  async ask(session: Session, request: AskTicketQuestionRequest): Promise<TicketView> {
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
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
      return { ...ticket, status: 'waiting', questions: [...ticket.questions, question] }
    })
  }

  /** Add one human-visible attention item and move the Ticket into waiting.
   * @param session - Session whose log owns the Ticket.
   * @param request - attention request.
   * @returns the committed Ticket view.
   */
  async attention(session: Session, request: RequestTicketAttentionRequest): Promise<TicketView> {
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
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
      return { ...ticket, status: 'waiting', attentions: [...ticket.attentions, attention] }
    })
  }

  /** Block a Ticket with a coordinator or direct worker reason.
   * @param session - Session whose log owns the Ticket.
   * @param request - block request.
   * @returns the committed Ticket view.
   */
  async block(session: Session, request: BlockTicketRequest): Promise<TicketView> {
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      this.assertParticipant(ticket, request.actorId)
      return { ...ticket, status: 'blocked', attentions: ticket.attentions.length >= this.config.maxAttentions
        ? ticket.attentions
        : [...ticket.attentions, {
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      nonEmpty('newCoordinatorId', request.newCoordinatorId)
      return { ...ticket, coordinatorId: request.newCoordinatorId, status: ticket.status === 'proposed' ? 'coordinating' : ticket.status }
    })
  }

  /** Finish a Ticket with a completed outcome.
   * @param session - Session whose log owns the Ticket.
   * @param request - terminal completion request.
   * @returns the committed Ticket view.
   */
  async complete(session: Session, request: EndTicketRequest): Promise<TicketView> {
    return await this.end(session, request, 'completed')
  }

  /** Finish a Ticket with a failed outcome.
   * @param session - Session whose log owns the Ticket.
   * @param request - terminal failure request.
   * @returns the committed Ticket view.
   */
  async fail(session: Session, request: EndTicketRequest): Promise<TicketView> {
    return await this.end(session, request, 'failed')
  }

  /** Cancel a Ticket with a terminal outcome.
   * @param session - Session whose log owns the Ticket.
   * @param request - terminal cancellation request.
   * @returns the committed Ticket view.
   */
  async cancel(session: Session, request: EndTicketRequest): Promise<TicketView> {
    return await this.end(session, request, 'cancelled')
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

  private async end(session: Session, request: EndTicketRequest, status: Extract<TicketStatus, 'completed' | 'failed' | 'cancelled'>): Promise<TicketView> {
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      if (ticket.terminalOutcome !== undefined || ticket.status === 'completed' || ticket.status === 'failed' || ticket.status === 'cancelled') throw new TicketError(`Ticket "${ticket.id}" is already terminal`, 'TICKET_TERMINAL')
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
    id: TicketId,
    expectedRevision: number,
    update: (ticket: TicketSnapshot) => TicketSnapshot,
  ): Promise<TicketView> {
    return await this.enqueue(session, async () => {
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
      ticketSnapshotSchema.parse(next)
      await this.commit(session, next)
      return next
    })
  }

  private async enqueue<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(session.id) ?? Promise.resolve()
    const next = prior.then(operation, operation)
    this.tails.set(session.id, next.then(() => undefined, () => undefined))
    return await next
  }

  private async commit(session: Session, ticket: TicketSnapshot): Promise<void> {
    const bytes = textBytes(JSON.stringify(ticket))
    if (bytes > this.config.maxSnapshotBytes) throw new TicketError(`Ticket snapshot exceeds ${String(this.config.maxSnapshotBytes)} bytes`, 'TICKET_SNAPSHOT_TOO_LARGE')
    session.append('ticket/state', { version: 1, sessionId: session.id, ticket })
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
  }

  private assignment(ticket: TicketSnapshot, id: AssignmentId): AssignmentSnapshot {
    const assignment = ticket.assignments.find(candidate => candidate.id === id)
    if (assignment === undefined) throw new TicketError(`unknown Assignment "${id}"`, 'TICKET_ASSIGNMENT_NOT_FOUND')
    return assignment
  }

  private assertCoordinator(ticket: TicketSnapshot, actorId: SessionId): void {
    if (ticket.coordinatorId !== actorId) throw new TicketError('only the current coordinator may perform this command', 'TICKET_AUTHORITY')
  }

  private assertParticipant(ticket: TicketSnapshot, actorId: SessionId, assignmentId?: AssignmentId): void {
    if (ticket.coordinatorId === actorId) return
    if (assignmentId !== undefined
      && ticket.assignments.some(assignment => assignment.id === assignmentId && assignment.ownerId === actorId)) return
    throw new TicketError('caller is not the coordinator or assigned worker', 'TICKET_AUTHORITY')
  }

  private validateAssignmentScopes(ticket: TicketSnapshot, requested: readonly WorkScope[] | undefined): WorkScope[] {
    const scopes = cloneScopes(requested, this.config.maxWorkScopes)
    if (ticket.workScopes.length === 0) return scopes
    for (const scope of scopes) {
      const covered = ticket.workScopes.some(parent => scope.path === parent.path || scope.path.startsWith(parent.path.endsWith('/') ? parent.path : `${parent.path}/`))
      if (!covered) throw new TicketError(`assignment work scope "${scope.path}" is outside the Ticket scope`, 'TICKET_INVALID_INPUT')
    }
    return scopes
  }
}

export default TicketService
