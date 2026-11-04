/** Browser-safe Ticket identities, snapshots, requests, and Session events. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CreatedWorktree } from '@deepseek-ai/dsh-experimental-worktree'
import type { JobId } from '@deepseek-ai/dsh-jobs'
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

/** Declared relative workspace access; exclusivity coordinates workers and does not confine filesystem access. */
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
export interface AssignmentSnapshotV1 {
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
  readonly specRevision?: number
  readonly attemptId?: TicketAttemptId
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
export interface TicketSnapshotV1 {
  readonly id: TicketId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TicketStatus
  readonly coordinatorId: SessionId
  readonly assignments: readonly AssignmentSnapshotV1[]
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
  readonly acceptanceCriteria?: readonly TicketAcceptanceCriterion[]
  readonly dependencies?: readonly TicketId[]
  readonly parent?: TicketParent
  readonly workScopes?: readonly WorkScope[]
}

/** Input for assigning a direct worker. */
export interface AssignTicketRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly actorId: SessionId
  readonly ownerId: SessionId
  readonly contribution?: TicketContribution
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
  readonly attemptId?: TicketAttemptId
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

/** Coordinator response to an open durable question. */
export interface AnswerTicketQuestionRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly actorId: SessionId
  readonly questionId: TicketQuestionId
  readonly answer: string
}

/** Author or coordinator closure of an open or answered question. */
export interface CloseTicketQuestionRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly actorId: SessionId
  readonly questionId: TicketQuestionId
}

/** Coordinator acknowledgement or resolution of one attention item. */
export interface UpdateTicketAttentionRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly actorId: SessionId
  readonly attentionId: TicketAttentionId
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
    'ticket/state':
      | { version: 1; sessionId: SessionId; ticket: TicketSnapshotV1 }
      | { version: 2; sessionId: SessionId; ticket: TicketSnapshot }
  }
}

/** Whether acceptance requires an Assignment result for the current specification. */
export type TicketContribution = 'required' | 'advisory'
/** Identity of one durable execution attempt. */
export type TicketAttemptId = Branded<'TicketAttemptId'>
/** Idempotency identity of one admitted attempt operation. */
export type TicketOperationId = Branded<'TicketOperationId'>
/** Identity of immutable content submitted for acceptance. */
export type TicketCandidateId = Branded<'TicketCandidateId'>
/** Identity of one criterion evaluation. */
export type TicketCheckId = Branded<'TicketCheckId'>
/** Identity of an acceptance criterion within a specification. */
export type TicketCriterionId = Branded<'TicketCriterionId'>
/** Identity of a Mission plan rooted at one Ticket. */
export type MissionId = Branded<'MissionId'>

/** Validate and brand an attempt identity.
 * @param id - Nonempty identifier.
 * @returns Branded attempt identifier.
 */
export function TicketAttemptId(id: string): TicketAttemptId { return brandString<TicketAttemptId>(id) }
/** Validate and brand an operation identity.
 * @param id - Nonempty identifier.
 * @returns Branded operation identifier.
 */
export function TicketOperationId(id: string): TicketOperationId { return brandString<TicketOperationId>(id) }
/** Validate and brand a candidate identity.
 * @param id - Nonempty identifier.
 * @returns Branded candidate identifier.
 */
export function TicketCandidateId(id: string): TicketCandidateId { return brandString<TicketCandidateId>(id) }
/** Validate and brand a check identity.
 * @param id - Nonempty identifier.
 * @returns Branded check identifier.
 */
export function TicketCheckId(id: string): TicketCheckId { return brandString<TicketCheckId>(id) }
/** Validate and brand a criterion identity.
 * @param id - Nonempty identifier.
 * @returns Branded criterion identifier.
 */
export function TicketCriterionId(id: string): TicketCriterionId { return brandString<TicketCriterionId>(id) }
/** Validate and brand a Mission identity.
 * @param id - Nonempty identifier.
 * @returns Branded Mission identifier.
 */
export function MissionId(id: string): MissionId { return brandString<MissionId>(id) }

/** One acceptance obligation; required checks may require an independent author. */
export interface TicketAcceptanceCriterion {
  readonly id: TicketCriterionId
  readonly description: string
  readonly required: boolean
  readonly independent: boolean
}
/** Parent reference; required children must complete before the parent is accepted. */
export interface TicketParent { readonly ticketId: TicketId; readonly required: boolean }
/** Current specification. Prior revisions remain in committed Session events. */
export interface TicketSpecification {
  readonly revision: number
  readonly acceptanceCriteria: readonly TicketAcceptanceCriterion[]
  readonly dependencies: readonly TicketId[]
  readonly parent?: TicketParent
}
/** Direct-worker responsibility with explicit contribution and attempt identity. */
export interface AssignmentSnapshot extends AssignmentSnapshotV1 {
  readonly contribution: TicketContribution
  readonly activeAttemptId?: TicketAttemptId
}
/** Workspace placement is independent from executor placement. */
export interface TicketAttemptWorkspace {
  readonly kind: 'shared-workspace' | 'isolated-worktree'
  readonly directory: string
  readonly baseCommit?: string
}
/** Execution provider selection; remote execution requires an explicit world. */
export type TicketAttemptExecutor =
  | { readonly kind: 'in-process' }
  | { readonly kind: 'dedicated-process'; readonly provider: string }
  | { readonly kind: 'remote'; readonly provider: string; readonly world: string }
/** Runtime receipt retained across restarts, without a live handle. */
export interface TicketRuntimeReceipt {
  readonly runtimeId: string
  readonly providerId: string
  readonly childSessionId?: SessionId
  readonly jobIds?: readonly JobId[]
  readonly transportId?: string
  readonly world?: string
}
/** Actual checkout location and immutable starting commit. */
export interface TicketWorkspaceReceipt {
  readonly directory: string
  readonly baseCommit: string
  readonly worktree?: CreatedWorktree
}
/** Common attempt facts; selections and identities cannot change after admission. */
export interface TicketAttemptFacts {
  readonly id: TicketAttemptId
  readonly assignmentId: AssignmentId
  readonly assignmentRevision: number
  readonly specRevision: number
  readonly workspace: TicketAttemptWorkspace
  readonly executor: TicketAttemptExecutor
  readonly modelSelection?: { readonly provider: string; readonly model: string; readonly settings: string }
  readonly workspaceReceipt?: TicketWorkspaceReceipt
  readonly runtimeReceipt?: TicketRuntimeReceipt
  readonly diagnostics: readonly string[]
  readonly createdAt: number
  readonly updatedAt: number
}
/** Unknown means settlement has not been established and conflicting work stays reserved. */
export type TicketAttemptSnapshot = TicketAttemptFacts & (
  | { readonly status: 'preparing' | 'running' | 'stopping' | 'unknown' }
  | { readonly status: 'settled'; readonly outcome: 'succeeded' | 'failed' | 'cancelled' }
)
/** Immutable content identity; mutable path references are insufficient. */
export type TicketCandidateContent =
  | { readonly kind: 'commit'; readonly repository: string; readonly commit: string }
  | { readonly kind: 'artifact'; readonly reference: string; readonly digest: string }
/** Submission pins the specification and contributing responsibilities. */
export interface TicketCandidateSnapshot {
  readonly id: TicketCandidateId
  readonly specRevision: number
  readonly content: TicketCandidateContent
  readonly assignmentIds: readonly AssignmentId[]
  readonly reportIds: readonly TicketReportId[]
  readonly authorId: SessionId
  readonly createdAt: number
}
/** Evidence of one criterion evaluation for exact submitted content. */
export interface TicketCheckSnapshot {
  readonly id: TicketCheckId
  readonly candidateId: TicketCandidateId
  readonly criterionId: TicketCriterionId
  readonly specRevision: number
  readonly authorId: SessionId
  readonly outcome: 'pass' | 'fail'
  readonly evidence: readonly string[]
  readonly createdAt: number
}
/** Durable deduplication record; request excludes the CAS revision. */
export interface TicketOperationSnapshot { readonly id: TicketOperationId; readonly request: string }
/** A Mission milestone references Ticket completion, never a second mutable status. */
export interface MissionMilestone { readonly title: string; readonly ticketIds: readonly TicketId[] }
/** Versioned plan; progress is derived from referenced Ticket terminal outcomes. */
export interface MissionPlanSnapshot {
  readonly id: MissionId
  readonly revision: number
  readonly title: string
  readonly milestones: readonly MissionMilestone[]
}
/** Derived Mission progress at the current Session revision. */
export interface MissionView {
  readonly plan: MissionPlanSnapshot
  readonly milestones: readonly { readonly title: string; readonly completed: number; readonly total: number }[]
  readonly completed: number
  readonly total: number
}
/** Current complete snapshot; the v1 event decoder supplies explicit defaults. */
export interface TicketSnapshot extends Omit<TicketSnapshotV1, 'assignments'> {
  readonly assignments: readonly AssignmentSnapshot[]
  readonly specification: TicketSpecification
  readonly attempts: readonly TicketAttemptSnapshot[]
  readonly candidates: readonly TicketCandidateSnapshot[]
  readonly currentCandidateId?: TicketCandidateId
  readonly checks: readonly TicketCheckSnapshot[]
  readonly operations: readonly TicketOperationSnapshot[]
  readonly missionPlans: readonly MissionPlanSnapshot[]
}
/** Common CAS and actor arguments, authenticated by the calling adapter. */
export interface TicketMutationRequest {
  readonly ticketId: TicketId
  readonly expectedRevision: number
  readonly actorId: SessionId
}
/** Replace acceptance obligations, invalidating prior contributions and checks. */
export interface ReviseTicketRequest extends TicketMutationRequest {
  readonly acceptanceCriteria: readonly TicketAcceptanceCriterion[]
  readonly dependencies: readonly TicketId[]
  readonly parent?: TicketParent
}
/** Claim an attempt before any workspace or runtime side effect. */
export interface BeginTicketAttemptRequest extends TicketMutationRequest {
  readonly assignmentId: AssignmentId
  readonly assignmentRevision?: number
  readonly attemptId: TicketAttemptId
  readonly operationId: TicketOperationId
  readonly workspace: TicketAttemptWorkspace
  readonly executor: TicketAttemptExecutor
  readonly modelSelection?: TicketAttemptFacts['modelSelection']
}
/** Record runtime facts or uncertainty without releasing the reservation. */
export interface UpdateTicketAttemptRequest extends TicketMutationRequest {
  readonly attemptId: TicketAttemptId
  readonly operationId: TicketOperationId
  readonly status: 'running' | 'stopping' | 'unknown'
  readonly workspaceReceipt?: TicketWorkspaceReceipt
  readonly runtimeReceipt?: TicketRuntimeReceipt
  readonly diagnostics?: readonly string[]
}
/** Establish actual producer settlement before releasing conflicting work. */
export interface SettleTicketAttemptRequest extends Omit<UpdateTicketAttemptRequest, 'status'> {
  readonly outcome: 'succeeded' | 'failed' | 'cancelled'
}
/** Pin immutable candidate content and its current contributing Assignments. */
export interface SubmitTicketCandidateRequest extends TicketMutationRequest {
  readonly candidateId: TicketCandidateId
  readonly specRevision: number
  readonly content: TicketCandidateContent
  readonly assignmentIds: readonly AssignmentId[]
}
/** Append a current candidate's criterion result with readable evidence. */
export interface CheckTicketCandidateRequest extends TicketMutationRequest {
  readonly checkId: TicketCheckId
  readonly candidateId: TicketCandidateId
  readonly criterionId: TicketCriterionId
  readonly specRevision: number
  readonly outcome: 'pass' | 'fail'
  readonly evidence: readonly string[]
}
/** Create or replace a Mission plan at its current plan revision (zero creates). */
export interface PlanTicketMissionRequest extends TicketMutationRequest {
  readonly missionId: MissionId
  readonly expectedPlanRevision: number
  readonly title: string
  readonly milestones: readonly MissionMilestone[]
}
