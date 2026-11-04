/** Host Ticket service: durable CAS lifecycle for direct-worker coordination. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { ticketProjectionDefinition, validateTicketChange } from './projection.ts'
import type { TicketProjectionState } from './projection.ts'
import { assertTicketAcceptance, validateTicketReferences } from './validation.ts'
import { TicketError } from './errors.ts'
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
  TicketAttemptSnapshot, TicketMutationRequest,
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
        specification: {
          revision: 1, acceptanceCriteria: [...request.acceptanceCriteria ?? []], dependencies: [...request.dependencies ?? []],
          ...request.parent === undefined ? {} : { parent: request.parent },
        },
        attempts: [], candidates: [], checks: [], operations: [], missionPlans: [],
        createdAt: now,
        updatedAt: now,
      }
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
      if (assignment.activeAttemptId !== undefined && ticket.attempts.some(attempt => attempt.id === assignment.activeAttemptId && attempt.status !== 'settled')) throw new TicketError('settle the active attempt before claiming or releasing its Assignment', 'TICKET_ATTEMPT_STATE')
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
      if (assignment.activeAttemptId !== undefined && ticket.attempts.some(attempt => attempt.id === assignment.activeAttemptId && attempt.status !== 'settled')) throw new TicketError('settle the active attempt before claiming or releasing its Assignment', 'TICKET_ATTEMPT_STATE')
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
      if (!['assigned', 'claimed', 'running', 'blocked'].includes(assignment.status)) throw new TicketError(`Assignment "${assignment.id}" cannot report from ${assignment.status}`, 'TICKET_ASSIGNMENT_STATE')
      if (assignment.activeAttemptId !== undefined) {
        if (request.attemptId !== assignment.activeAttemptId) throw new TicketError('report must name the current active attempt', 'TICKET_STALE_ATTEMPT')
        const attempt = ticket.attempts.find(item => item.id === request.attemptId)
        if (attempt?.specRevision !== ticket.specification.revision) throw new TicketError('report belongs to an obsolete specification', 'TICKET_STALE_ATTEMPT')
        if (attempt.status === 'settled' && (attempt.outcome !== 'succeeded' || request.kind !== 'result')) throw new TicketError('settled attempt cannot report progress or failure', 'TICKET_ATTEMPT_STATE')
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
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
    return await this.updateAttention(session, request, 'acknowledged')
  }

  /** Resolve an open or acknowledged attention item as coordinator, preserving other blockers.
   * @param session - Session owning the Ticket.
   * @param request - Attention identity, actor, and CAS revision.
   * @returns Committed Ticket; rejects without appending for denied or invalid changes.
   */
  async resolveAttention(session: Session, request: UpdateTicketAttentionRequest): Promise<TicketView> {
    return await this.updateAttention(session, request, 'resolved')
  }

  /** Add a human-visible attention item; blocked attention keeps the Ticket blocked.
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
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

  /** Replace the specification; prior candidates, checks and contributions remain historical.
   * @param session - Owning Session.
   * @param request - Complete replacement obligations and CAS revision.
   * @returns Committed Ticket with an incremented specification revision.
   */
  async revise(session: Session, request: ReviseTicketRequest): Promise<TicketView> {
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      const { currentCandidateId: _candidate, ...withoutCandidate } = ticket
      return {
        ...withoutCandidate,
        specification: {
          revision: ticket.specification.revision + 1,
          acceptanceCriteria: [...request.acceptanceCriteria], dependencies: [...request.dependencies],
          ...request.parent === undefined ? {} : { parent: request.parent },
        },
      }
    })
  }

  /** Admit one execution attempt before effects; repeated operation identities do not append.
   * @param session - Owning Session.
   * @param request - Attempt identity, placement, actor and CAS revision.
   * @returns Current Ticket; rejects replacement of unsettled work or changed operation payloads.
   */
  async beginAttempt(session: Session, request: BeginTicketAttemptRequest): Promise<TicketView> {
    return await this.attemptOperation(session, request, 'begin', (ticket) => {
      const assignment = this.assignment(ticket, request.assignmentId)
      this.assertParticipant(ticket, request.actorId, assignment.id)
      if (request.assignmentRevision !== undefined && assignment.revision !== request.assignmentRevision) throw new TicketError('Assignment revision changed', 'TICKET_STALE_REVISION')
      if (ticket.attempts.some(attempt => attempt.id === request.attemptId)) throw new TicketError('attempt identity is already used', 'TICKET_ATTEMPT_STATE')
      if (ticket.attempts.some(attempt => attempt.assignmentId === assignment.id && attempt.status !== 'settled')) throw new TicketError('previous attempt has not settled', 'TICKET_ATTEMPT_STATE')
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
    })
  }

  /** Record runtime receipts, stopping or uncertainty without releasing work.
   * @param session - Owning Session.
   * @param request - Current attempt and stable operation identity.
   * @returns Current Ticket; obsolete attempts and replaced receipts are rejected.
   */
  async updateAttempt(session: Session, request: UpdateTicketAttemptRequest): Promise<TicketView> {
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
   * @returns Current Ticket with settled work; retrying the same operation is safe.
   */
  async settleAttempt(session: Session, request: SettleTicketAttemptRequest): Promise<TicketView> {
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      this.assertParticipant(ticket, request.actorId)
      if (request.specRevision !== ticket.specification.revision) throw new TicketError('candidate specification is stale', 'TICKET_STALE_REVISION')
      if (ticket.candidates.length >= this.config.maxReports) throw new TicketError('candidate limit exhausted', 'TICKET_LIMIT')
      for (const id of request.assignmentIds) this.assignment(ticket, id)
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
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
  ): TicketSnapshot {
    const attempt = ticket.attempts.find(item => item.id === request.attemptId)
    if (attempt === undefined) throw new TicketError('unknown attempt', 'TICKET_STALE_ATTEMPT')
    const assignment = this.assignment(ticket, attempt.assignmentId)
    this.assertParticipant(ticket, request.actorId, assignment.id)
    if (assignment.activeAttemptId !== attempt.id) throw new TicketError('attempt has been superseded', 'TICKET_STALE_ATTEMPT')
    if (attempt.status === 'settled') throw new TicketError('attempt is already settled', 'TICKET_ATTEMPT_STATE')
    const next = update(attempt)
    return { ...ticket, attempts: ticket.attempts.map(item => item.id === next.id ? next : item) }
  }

  private async attemptOperation<T extends TicketMutationRequest & { readonly operationId: TicketOperationId }>(
    session: Session, request: T, kind: string, update: (ticket: TicketSnapshot) => TicketSnapshot,
  ): Promise<TicketView> {
    const { expectedRevision: _revision, ...payload } = request
    const fingerprint = operationFingerprint({ kind, ...payload })
    return await this.enqueue(session, async () => {
      const ticket = this.get(session, request.ticketId)
      this.assertParticipant(ticket, request.actorId)
      const operation = ticket.operations.find(item => item.id === request.operationId)
      if (operation !== undefined) {
        if (operation.request !== fingerprint) throw new TicketError('operation identity was reused with different arguments', 'TICKET_OPERATION_CONFLICT')
        return ticket
      }
      if (ticket.revision !== request.expectedRevision) throw new TicketError('Ticket revision changed', 'TICKET_STALE_REVISION')
      if (ticket.terminalOutcome !== undefined) throw new TicketError('Ticket is terminal', 'TICKET_TERMINAL')
      if (ticket.operations.length >= this.config.maxReports) throw new TicketError('operation limit exhausted', 'TICKET_LIMIT')
      const changed = update(ticket)
      const next = {
        ...changed, revision: ticket.revision + 1, updatedAt: Date.now(),
        operations: [...ticket.operations, { id: request.operationId, request: fingerprint }],
      }
      await this.commit(session, next)
      return next
    })
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
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
    return await this.mutate(session, request.ticketId, request.expectedRevision, (ticket) => {
      this.assertCoordinator(ticket, request.actorId)
      if (ticket.terminalOutcome !== undefined || ticket.status === 'completed' || ticket.status === 'failed' || ticket.status === 'cancelled') throw new TicketError(`Ticket "${ticket.id}" is already terminal`, 'TICKET_TERMINAL')
      if (ticket.attempts.some(attempt => attempt.status !== 'settled')) throw new TicketError('settle all attempts before ending the Ticket', 'TICKET_ATTEMPT_STATE')
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
    const previous = this.state(session).tickets.find(candidate => candidate.id === ticket.id)
    try {
      validateTicketChange(previous, ticket)
      const tickets = [...this.state(session).tickets.filter(item => item.id !== ticket.id), ticket]
      validateTicketReferences(tickets)
      if (ticket.terminalOutcome?.kind === 'completed') assertTicketAcceptance(ticket, tickets)
    } catch (error) {
      throw new TicketError('Ticket candidate violates schema or lifecycle rules', 'TICKET_INVALID_INPUT', { cause: error })
    }
    const bytes = textBytes(JSON.stringify(ticket))
    if (bytes > this.config.maxSnapshotBytes) throw new TicketError(`Ticket snapshot exceeds ${String(this.config.maxSnapshotBytes)} bytes`, 'TICKET_SNAPSHOT_TOO_LARGE')
    session.append('ticket/state', { version: 2, sessionId: session.id, ticket })
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
