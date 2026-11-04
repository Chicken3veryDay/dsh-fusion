/** Browser-safe Ticket identities, snapshots, requests, and Session events. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Stable identity for one durable Ticket. */
export type TicketId = Branded<'TicketId'>
/** Stable identity for one direct worker Assignment. */
export type AssignmentId = Branded<'AssignmentId'>
/** Stable identity for one Assignment execution slot. */
export type ExecutionSlotId = Branded<'ExecutionSlotId'>
/** Stable identity for one durable worker report. */
export type TicketReportId = Branded<'TicketReportId'>
/** Stable identity for one durable worker question. */
export type TicketQuestionId = Branded<'TicketQuestionId'>
/** Stable identity for one human or coordinator attention item. */
export type TicketAttentionId = Branded<'TicketAttentionId'>

/** Brand a Ticket id after validation at the owning service or projection.
 * @param id - validated Ticket identifier.
 * @returns the branded identifier.
 */
export function TicketId(id: string): TicketId { return id as TicketId }
/** Brand an Assignment id after validation at the owning service or projection.
 * @param id - validated Assignment identifier.
 * @returns the branded identifier.
 */
export function AssignmentId(id: string): AssignmentId { return id as AssignmentId }
/** Brand an execution-slot id after validation at the owning service or projection.
 * @param id - validated execution-slot identifier.
 * @returns the branded identifier.
 */
export function ExecutionSlotId(id: string): ExecutionSlotId { return id as ExecutionSlotId }
/** Brand a report id after validation at the owning service or projection.
 * @param id - validated report identifier.
 * @returns the branded identifier.
 */
export function TicketReportId(id: string): TicketReportId { return id as TicketReportId }
/** Brand a question id after validation at the owning service or projection.
 * @param id - validated question identifier.
 * @returns the branded identifier.
 */
export function TicketQuestionId(id: string): TicketQuestionId { return id as TicketQuestionId }
/** Brand an attention id after validation at the owning service or projection.
 * @param id - validated attention identifier.
 * @returns the branded identifier.
 */
export function TicketAttentionId(id: string): TicketAttentionId { return id as TicketAttentionId }

/** Ticket lifecycle owned by the durable domain. */
export type TicketStatus =
  | 'proposed'
  | 'ready'
  | 'coordinating'
  | 'executing'
  | 'integrating'
  | 'reviewing'
  | 'waiting'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Direct worker responsibility. */
export type AssignmentRole = 'worker' | 'reviewer' | 'integrator' | 'observer'
/** Direct worker assignment lifecycle. */
export type AssignmentStatus = 'assigned' | 'claimed' | 'running' | 'released' | 'completed' | 'blocked' | 'failed' | 'cancelled'
/** Execution placement owned by a future adapter. */
export type ExecutionSlotMode = 'shared-workspace' | 'isolated-worktree' | 'dedicated-process'
/** Execution-slot lifecycle. */
export type ExecutionSlotStatus = 'reserved' | 'running' | 'released' | 'failed'
/** Durable report kind. */
export type TicketReportKind = 'progress' | 'result' | 'failure'
/** Durable question lifecycle. */
export type TicketQuestionStatus = 'open' | 'answered' | 'closed'
/** Durable attention category and lifecycle. */
export type TicketAttentionKind = 'review' | 'question' | 'blocked' | 'decision'
/** Attention lifecycle. */
export type TicketAttentionStatus = 'open' | 'acknowledged' | 'resolved'

/** One declared workspace path and the access it permits. */
export interface WorkScope {
  readonly path: string
  readonly access: 'read' | 'write'
  readonly exclusive?: boolean
}

/** One durable execution slot reserved by an Assignment. */
export interface ExecutionSlotSnapshot {
  readonly id: ExecutionSlotId
  readonly mode: ExecutionSlotMode
  readonly status: ExecutionSlotStatus
  readonly assignmentId: AssignmentId
  readonly holderId?: SessionId
}

/** One durable direct-worker responsibility. */
export interface AssignmentSnapshot {
  readonly id: AssignmentId
  readonly revision: number
  readonly role: AssignmentRole
  readonly subject: string
  readonly instructions: string
  readonly ownerId: SessionId
  readonly status: AssignmentStatus
  readonly workScopes: readonly WorkScope[]
  readonly executionSlotId?: ExecutionSlotId
  readonly attempts: number
  readonly latestReportId?: TicketReportId
}

/** One bounded worker report retained by the Ticket. */
export interface TicketReportSnapshot {
  readonly id: TicketReportId
  readonly assignmentId: AssignmentId
  readonly authorId: SessionId
  readonly kind: TicketReportKind
  readonly summary: string
  readonly evidence: readonly string[]
  readonly nextSteps: readonly string[]
  readonly createdAt: number
}

/** One worker question retained until answered or closed. */
export interface TicketQuestionSnapshot {
  readonly id: TicketQuestionId
  readonly assignmentId?: AssignmentId
  readonly authorId: SessionId
  readonly question: string
  readonly status: TicketQuestionStatus
  readonly answer?: string
  readonly answeredBy?: SessionId
  readonly createdAt: number
}

/** One human-visible item requiring a decision or intervention. */
export interface TicketAttentionSnapshot {
  readonly id: TicketAttentionId
  readonly assignmentId?: AssignmentId
  readonly kind: TicketAttentionKind
  readonly message: string
  readonly status: TicketAttentionStatus
  readonly createdAt: number
  readonly resolvedAt?: number
}

/** The terminal outcome recorded when a Ticket ends. */
export interface TicketTerminalOutcome {
  readonly kind: Extract<TicketStatus, 'completed' | 'failed' | 'cancelled'>
  readonly summary: string
  readonly actorId: SessionId
  readonly at: number
}

/** Complete durable Ticket value written to every `ticket/state` event. */
export interface TicketSnapshot {
  readonly id: TicketId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TicketStatus
  readonly coordinatorId: SessionId
  readonly assignments: readonly AssignmentSnapshot[]
  readonly reports: readonly TicketReportSnapshot[]
  readonly questions: readonly TicketQuestionSnapshot[]
  readonly attentions: readonly TicketAttentionSnapshot[]
  readonly workScopes: readonly WorkScope[]
  readonly executionSlots: readonly ExecutionSlotSnapshot[]
  readonly terminalOutcome?: TicketTerminalOutcome
  readonly createdAt: number
  readonly updatedAt: number
}

/** Browser view of durable Ticket state. This first version is the snapshot itself. */
export type TicketView = TicketSnapshot

/** Durable Ticket projection exposed to browser callers. */
export interface TicketProjection {
  readonly tickets: readonly TicketView[]
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Durable Tickets rooted at the projected Session. */
    ticket: TicketProjection
  }
}

/** Deployment bounds for one Ticket service instance. */
export interface Config {
  /** Maximum Tickets retained in one Session projection. */
  readonly maxTickets?: number
  /** Maximum direct worker Assignments retained per Ticket. */
  readonly maxAssignments?: number
  /** Maximum Reports retained per Ticket. */
  readonly maxReports?: number
  /** Maximum Questions retained per Ticket. */
  readonly maxQuestions?: number
  /** Maximum Attention items retained per Ticket. */
  readonly maxAttentions?: number
  /** Maximum WorkScope declarations retained per Ticket or Assignment. */
  readonly maxWorkScopes?: number
  /** Maximum serialized bytes in one complete Ticket snapshot event. */
  readonly maxSnapshotBytes?: number
}

/** Input for creating a Ticket in one Session's durable log. */
export interface CreateTicketRequest {
  readonly id?: TicketId
  readonly subject: string
  readonly description: string
  readonly coordinatorId?: SessionId
  readonly workScopes?: readonly WorkScope[]
}

/** Input for assigning a direct worker. */
export interface AssignTicketRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly actorId: SessionId
  readonly ownerId: SessionId
  readonly role?: AssignmentRole
  readonly subject: string
  readonly instructions?: string
  readonly workScopes?: readonly WorkScope[]
  readonly executionMode?: ExecutionSlotMode
}

/** Input for claiming one Assignment by its direct worker. */
export interface ClaimAssignmentRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly assignmentId: AssignmentId
  readonly actorId: SessionId
}

/** Input for releasing one Assignment while retaining its owner. */
export interface ReleaseAssignmentRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly assignmentId: AssignmentId
  readonly actorId: SessionId
}

/** Input for publishing one worker report. */
export interface ReportTicketRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly assignmentId: AssignmentId
  readonly actorId: SessionId
  readonly kind: TicketReportKind
  readonly summary: string
  readonly evidence?: readonly string[]
  readonly nextSteps?: readonly string[]
}

/** Input for a worker question. */
export interface AskTicketQuestionRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly assignmentId?: AssignmentId
  readonly actorId: SessionId
  readonly question: string
}

/** Input for human or coordinator attention. */
export interface RequestTicketAttentionRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly assignmentId?: AssignmentId
  readonly actorId: SessionId
  readonly kind: TicketAttentionKind
  readonly message: string
}

/** Input for a coordinator handoff. */
export interface HandoffCoordinatorRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly actorId: SessionId
  readonly newCoordinatorId: SessionId
}

/** Input for blocking a Ticket. */
export interface BlockTicketRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly actorId: SessionId
  readonly reason: string
}

/** Input for ending a Ticket. */
export interface EndTicketRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly actorId: SessionId
  readonly summary: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete post-change Ticket value; the Session log is the durable authority. */
    'ticket/state': { version: 1; sessionId: SessionId; ticket: TicketSnapshot }
  }
}
