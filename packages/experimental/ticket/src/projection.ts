/** Strict replay projection for the standalone Ticket domain. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { assertTicketAcceptance, validateCurrentTicketChange, validateTicketReferences } from './validation.ts'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  AssignmentId,
  TicketAttemptId, TicketOperationId, TicketCandidateId, TicketCheckId, TicketCriterionId, MissionId,
  ExecutionSlotId,
  TicketAttentionId,
  TicketId,
  TicketQuestionId,
  TicketReportId,
} from './types.ts'
import type {
  AssignmentSnapshotV1,
  ExecutionSlotSnapshot,
  TicketAttentionSnapshot,
  TicketProjection,
  TicketQuestionSnapshot,
  TicketReportSnapshot,
  TicketSnapshot,
  TicketSnapshotV1,
  TicketStatus,
  WorkScope,
} from './types.ts'

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveInteger = safeInteger.min(1)
const sessionIdSchema = z.string().min(1).transform(value => brandString<SessionId>(value))
const ticketIdSchema = z.string().min(1).transform(value => TicketId(value))
const assignmentIdSchema = z.string().min(1).transform(value => AssignmentId(value))
const executionSlotIdSchema = z.string().min(1).transform(value => ExecutionSlotId(value))
const reportIdSchema = z.string().min(1).transform(value => TicketReportId(value))
const questionIdSchema = z.string().min(1).transform(value => TicketQuestionId(value))
const attentionIdSchema = z.string().min(1).transform(value => TicketAttentionId(value))

const workScopeSchema: z.ZodType<WorkScope> = z.object({
  path: z.string().min(1),
  access: z.enum(['read', 'write']),
  exclusive: z.boolean().optional(),
}).strict() as z.ZodType<WorkScope>

const assignmentSchema: z.ZodType<AssignmentSnapshotV1> = z.object({
  id: assignmentIdSchema,
  revision: positiveInteger,
  role: z.enum(['worker', 'reviewer', 'integrator', 'observer']),
  subject: z.string().min(1),
  instructions: z.string(),
  ownerId: sessionIdSchema,
  status: z.enum(['assigned', 'claimed', 'running', 'released', 'completed', 'blocked', 'failed', 'cancelled']),
  workScopes: z.array(workScopeSchema),
  executionSlotId: executionSlotIdSchema.optional(),
  attempts: safeInteger,
  latestReportId: reportIdSchema.optional(),
}).strict() as z.ZodType<AssignmentSnapshotV1>

const executionSlotSchema: z.ZodType<ExecutionSlotSnapshot> = z.object({
  id: executionSlotIdSchema,
  mode: z.enum(['shared-workspace', 'isolated-worktree', 'dedicated-process']),
  status: z.enum(['reserved', 'running', 'released', 'failed']),
  assignmentId: assignmentIdSchema,
  holderId: sessionIdSchema.optional(),
}).strict() as z.ZodType<ExecutionSlotSnapshot>

const reportSchema: z.ZodType<TicketReportSnapshot> = z.object({
  id: reportIdSchema,
  assignmentId: assignmentIdSchema,
  authorId: sessionIdSchema,
  kind: z.enum(['progress', 'result', 'failure']),
  summary: z.string().min(1),
  evidence: z.array(z.string()),
  nextSteps: z.array(z.string()),
  createdAt: safeInteger,
}).strict()

const questionSchema: z.ZodType<TicketQuestionSnapshot> = z.object({
  id: questionIdSchema,
  assignmentId: assignmentIdSchema.optional(),
  authorId: sessionIdSchema,
  question: z.string().min(1),
  status: z.enum(['open', 'answered', 'closed']),
  answer: z.string().optional(),
  answeredBy: sessionIdSchema.optional(),
  createdAt: safeInteger,
}).strict() as z.ZodType<TicketQuestionSnapshot>

const attentionSchema: z.ZodType<TicketAttentionSnapshot> = z.object({
  id: attentionIdSchema,
  assignmentId: assignmentIdSchema.optional(),
  kind: z.enum(['review', 'question', 'blocked', 'decision']),
  message: z.string().min(1),
  status: z.enum(['open', 'acknowledged', 'resolved']),
  createdAt: safeInteger,
  resolvedAt: safeInteger.optional(),
}).strict() as z.ZodType<TicketAttentionSnapshot>

const terminalOutcomeSchema = z.object({
  kind: z.enum(['completed', 'failed', 'cancelled']),
  summary: z.string().min(1),
  actorId: sessionIdSchema,
  at: safeInteger,
}).strict()

/** Runtime schema for a complete durable Ticket value. */
const ticketSnapshotV1Schema = z.object({
  id: ticketIdSchema,
  revision: positiveInteger,
  subject: z.string().min(1),
  description: z.string(),
  status: z.enum([
    'proposed', 'ready', 'coordinating', 'executing', 'integrating', 'reviewing', 'waiting',
    'blocked', 'completed', 'failed', 'cancelled',
  ]),
  coordinatorId: sessionIdSchema,
  assignments: z.array(assignmentSchema),
  reports: z.array(reportSchema),
  questions: z.array(questionSchema),
  attentions: z.array(attentionSchema),
  workScopes: z.array(workScopeSchema),
  executionSlots: z.array(executionSlotSchema),
  terminalOutcome: terminalOutcomeSchema.optional(),
  createdAt: safeInteger,
  updatedAt: safeInteger,
}).strict()

const criterionSchema = z.object({
  id: z.string().min(1).transform(value => TicketCriterionId(value)),
  description: z.string().trim().min(1), required: z.boolean(), independent: z.boolean(),
}).strict()
const parentSchema = z.object({ ticketId: ticketIdSchema, required: z.boolean() }).strict()
/** Parser for model-provided specification edits and durable v2 specifications. */
export const ticketSpecificationSchema = z.object({
  revision: positiveInteger, acceptanceCriteria: z.array(criterionSchema),
  dependencies: z.array(ticketIdSchema), parent: parentSchema.optional(),
}).strict()
/** Parser for independent workspace and executor placement. */
export const ticketAttemptWorkspaceSchema = z.object({
  kind: z.enum(['shared-workspace', 'isolated-worktree']), directory: z.string().min(1), baseCommit: z.string().min(1).optional(),
}).strict()
/** Parser for provider selection, including explicit remote execution world. */
export const ticketAttemptExecutorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('in-process') }).strict(),
  z.object({ kind: z.literal('dedicated-process'), provider: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('remote'), provider: z.string().min(1), world: z.string().min(1) }).strict(),
])
/** Parser for durable checkout receipts. */
export const ticketWorkspaceReceiptSchema = z.object({
  directory: z.string().min(1), baseCommit: z.string().min(1),
  worktree: z.object({
    path: z.string().min(1), branch: z.string().min(1),
    baseCommit: z.string().min(1), repositoryRoot: z.string().min(1),
  }).strict().optional(),
}).strict()
/** Parser for durable provider/runtime receipts. */
export const ticketRuntimeReceiptSchema = z.object({
  runtimeId: z.string().min(1), providerId: z.string().min(1), childSessionId: sessionIdSchema.optional(),
  jobIds: z.array(z.string().min(1).transform(value => brandString<JobId>(value))).optional(),
  transportId: z.string().min(1).optional(), world: z.string().min(1).optional(),
}).strict()
const attemptIdSchema = z.string().min(1).transform(value => TicketAttemptId(value))
const candidateIdSchema = z.string().min(1).transform(value => TicketCandidateId(value))
const attemptFields = {
  id: attemptIdSchema, assignmentId: assignmentIdSchema, assignmentRevision: positiveInteger,
  specRevision: positiveInteger, workspace: ticketAttemptWorkspaceSchema, executor: ticketAttemptExecutorSchema,
  modelSelection: z.object({ provider: z.string().min(1), model: z.string().min(1), settings: z.string() }).strict().optional(),
  workspaceReceipt: ticketWorkspaceReceiptSchema.optional(), runtimeReceipt: ticketRuntimeReceiptSchema.optional(),
  diagnostics: z.array(z.string()), createdAt: safeInteger, updatedAt: safeInteger,
}
const attemptSchema = z.union([
  z.object({ ...attemptFields, status: z.enum(['preparing', 'running', 'stopping', 'unknown']) }).strict(),
  z.object({ ...attemptFields, status: z.literal('settled'), outcome: z.enum(['succeeded', 'failed', 'cancelled']) }).strict(),
])
/** Parser requiring immutable Git object identity or an artifact digest. */
export const ticketCandidateContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit'), repository: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict(),
  z.object({ kind: z.literal('artifact'), reference: z.string().min(1), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
])
/** Parser for Mission milestone references, with progress derived at read time. */
export const missionMilestoneSchema = z.object({ title: z.string().trim().min(1), ticketIds: z.array(ticketIdSchema).min(1) }).strict()
/** Runtime schema for the complete current durable Ticket value. */
export const ticketSnapshotSchema: z.ZodType<TicketSnapshot> = ticketSnapshotV1Schema.extend({
  assignments: z.array(z.object({
    id: assignmentIdSchema, revision: positiveInteger, role: z.enum(['worker', 'reviewer', 'integrator', 'observer']),
    subject: z.string().min(1), instructions: z.string(), ownerId: sessionIdSchema,
    status: z.enum(['assigned', 'claimed', 'running', 'released', 'completed', 'blocked', 'failed', 'cancelled']),
    workScopes: z.array(workScopeSchema), executionSlotId: executionSlotIdSchema.optional(), attempts: safeInteger,
    latestReportId: reportIdSchema.optional(), contribution: z.enum(['required', 'advisory']), activeAttemptId: attemptIdSchema.optional(),
  }).strict()),
  reports: z.array(z.object({
    id: reportIdSchema, assignmentId: assignmentIdSchema, authorId: sessionIdSchema,
    kind: z.enum(['progress', 'result', 'failure']), summary: z.string().min(1), evidence: z.array(z.string()),
    nextSteps: z.array(z.string()), createdAt: safeInteger, specRevision: positiveInteger.optional(), attemptId: attemptIdSchema.optional(),
  }).strict()),
  specification: ticketSpecificationSchema, attempts: z.array(attemptSchema),
  candidates: z.array(z.object({
    id: candidateIdSchema, specRevision: positiveInteger, content: ticketCandidateContentSchema,
    assignmentIds: z.array(assignmentIdSchema).min(1), reportIds: z.array(reportIdSchema),
    authorId: sessionIdSchema, createdAt: safeInteger,
  }).strict()),
  currentCandidateId: candidateIdSchema.optional(),
  checks: z.array(z.object({
    id: z.string().min(1).transform(value => TicketCheckId(value)), candidateId: candidateIdSchema,
    criterionId: z.string().min(1).transform(value => TicketCriterionId(value)), specRevision: positiveInteger,
    authorId: sessionIdSchema, outcome: z.enum(['pass', 'fail']),
    evidence: z.array(z.string().trim().min(1)).min(1), createdAt: safeInteger,
  }).strict()),
  operations: z.array(z.object({
    id: z.string().min(1).transform(value => TicketOperationId(value)), request: z.string().min(1),
  }).strict()),
  missionPlans: z.array(z.object({
    id: z.string().min(1).transform(value => MissionId(value)), revision: positiveInteger,
    title: z.string().trim().min(1), milestones: z.array(missionMilestoneSchema),
  }).strict()),
}).strict() as z.ZodType<TicketSnapshot>

const ticketEventSchema: z.ZodType<SessionEventMap['ticket/state']> = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), sessionId: sessionIdSchema, ticket: ticketSnapshotV1Schema as z.ZodType<TicketSnapshotV1> }).strict(),
  z.object({ version: z.literal(2), sessionId: sessionIdSchema, ticket: ticketSnapshotSchema }).strict(),
])

const ticketSelectorSchema = z.object({
  version: safeInteger,
  sessionId: sessionIdSchema,
}).loose()

/** Projection state retained by the Host and checkpointed by Session projection. */
export interface TicketProjectionState {
  readonly sessionId: SessionId
  readonly tickets: readonly TicketSnapshot[]
  readonly currentVersionTickets: readonly TicketId[]
  readonly failure?: string
}

/** Create an empty Ticket state for one Session.
 * @param sessionId - Session that owns the Ticket log.
 * @returns empty projection state.
 */
export function emptyTicketState(sessionId: SessionId): TicketProjectionState {
  return { sessionId, tickets: [], currentVersionTickets: [] }
}

/** The only durable event owned by this package. */
export type TicketEventType = 'ticket/state'
/** A narrowed Ticket event. */
type TicketSessionEvent = SessionEvent<TicketEventType>

/** Test whether a Session event belongs to this Ticket domain.
 * @param event - candidate Session event.
 * @returns whether the event is a Ticket event.
 */
export function isTicketEvent(event: SessionEvent): event is TicketSessionEvent {
  return event.type === 'ticket/state'
}

/** Legal Ticket lifecycle transitions. Replay rejects any persisted jump outside this table.
 * @param previous - current Ticket status.
 * @param next - candidate next status.
 * @returns whether the transition is allowed.
 */
export function isTicketStatusTransitionAllowed(previous: TicketStatus, next: TicketStatus): boolean {
  if (previous === next) return true
  const allowed: Record<TicketStatus, readonly TicketStatus[]> = {
    proposed: ['ready', 'coordinating', 'executing', 'waiting', 'blocked', 'cancelled'],
    ready: ['coordinating', 'executing', 'integrating', 'waiting', 'blocked', 'cancelled'],
    coordinating: ['ready', 'executing', 'integrating', 'reviewing', 'waiting', 'blocked', 'cancelled'],
    executing: ['ready', 'integrating', 'reviewing', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'],
    integrating: ['ready', 'executing', 'reviewing', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'],
    reviewing: ['executing', 'waiting', 'completed', 'failed', 'blocked', 'cancelled'],
    waiting: ['ready', 'coordinating', 'executing', 'integrating', 'blocked', 'completed', 'failed', 'cancelled'],
    blocked: ['ready', 'coordinating', 'executing', 'integrating', 'waiting', 'completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  }
  return allowed[previous].includes(next)
}

function replaceTicket(tickets: readonly TicketSnapshot[], index: number, ticket: TicketSnapshot): TicketSnapshot[] {
  const next = [...tickets]
  if (index < 0) next.push(ticket)
  else next[index] = ticket
  return next
}

function assertUnique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ids are duplicated`)
}

/** Validate one candidate using the same rules as durable replay.
 * @param previous - Last committed value, or undefined for creation.
 * @param ticket - Candidate complete value.
 * @returns Nothing; throws before admission when schema or lifecycle rules fail.
 */
function validateLegacyTicketChange(previous: TicketSnapshot | undefined, ticket: TicketSnapshotV1): void {
  ticketSnapshotV1Schema.parse(ticket)
  if (previous === undefined) {
    if (ticket.revision !== 1) throw new Error(`ticket "${ticket.id}" must begin at revision 1`)
  } else {
    if (ticket.revision !== previous.revision + 1) throw new Error(`ticket "${ticket.id}" revision is not contiguous`)
    if (previous.createdAt !== ticket.createdAt || previous.subject !== ticket.subject || previous.description !== ticket.description) {
      throw new Error(`ticket "${ticket.id}" changed immutable identity fields`)
    }
    if (!isTicketStatusTransitionAllowed(previous.status, ticket.status)) {
      throw new Error(`ticket "${ticket.id}" has an invalid ${previous.status} -> ${ticket.status} transition`)
    }
  }
  assertUnique(ticket.assignments.map(assignment => assignment.id), `ticket "${ticket.id}" assignment`)
  assertUnique(ticket.executionSlots.map(slot => slot.id), `ticket "${ticket.id}" execution slot`)
  assertUnique(ticket.reports.map(report => report.id), `ticket "${ticket.id}" report`)
  assertUnique(ticket.questions.map(question => question.id), `ticket "${ticket.id}" question`)
  assertUnique(ticket.attentions.map(attention => attention.id), `ticket "${ticket.id}" attention`)
}

/** Validate current writes using the same semantics as v2 replay.
 * @param previous - Prior committed snapshot.
 * @param ticket - Complete proposed snapshot.
 * @returns Nothing; rejects malformed or unsafe transitions.
 */
export function validateTicketChange(previous: TicketSnapshot | undefined, ticket: TicketSnapshot): void {
  ticketSnapshotSchema.parse(ticket)
  validateCurrentTicketChange(previous, ticket)
}

function upgradeLegacy(ticket: TicketSnapshotV1): TicketSnapshot {
  return {
    ...ticket,
    assignments: ticket.assignments.map(assignment => ({ ...assignment, contribution: assignment.role === 'observer' ? 'advisory' : 'required' })),
    specification: { revision: 1, acceptanceCriteria: [], dependencies: [] },
    attempts: [], candidates: [], checks: [], operations: [], missionPlans: [],
  }
}

function applyProjectionEvent(state: TicketProjectionState, event: SessionEvent): TicketProjectionState {
  if (state.failure !== undefined || !isTicketEvent(event)) return state
  try {
    const selector = ticketSelectorSchema.parse(event.data)
    if (selector.sessionId !== state.sessionId) return state
    const decoded = ticketEventSchema.parse(event.data)
    const index = state.tickets.findIndex(candidate => candidate.id === decoded.ticket.id)
    const previous = index < 0 ? undefined : state.tickets[index]
    if (decoded.version === 1) {
      if (state.currentVersionTickets.includes(decoded.ticket.id)) throw new Error('Ticket event version cannot downgrade')
      validateLegacyTicketChange(previous, decoded.ticket)
      return { ...state, tickets: replaceTicket(state.tickets, index, upgradeLegacy(decoded.ticket)) }
    }
    validateTicketChange(previous, decoded.ticket)
    const tickets = replaceTicket(state.tickets, index, decoded.ticket)
    validateTicketReferences(tickets)
    if (decoded.ticket.terminalOutcome?.kind === 'completed') assertTicketAcceptance(decoded.ticket, tickets)
    return {
      ...state, tickets,
      currentVersionTickets: state.currentVersionTickets.includes(decoded.ticket.id)
        ? state.currentVersionTickets : [...state.currentVersionTickets, decoded.ticket.id],
    }
  } catch (error: unknown) {
    return { ...state, failure: error instanceof Error ? error.message : String(error) }
  }
}

const ticketProjectionSchema: z.ZodType<TicketProjection> = z.object({
  tickets: z.array(ticketSnapshotSchema),
  failure: z.string().optional(),
}).strict() as z.ZodType<TicketProjection>

/** Convert durable state to the browser-safe projection value.
 * @param state - durable projection state.
 * @returns browser-safe Ticket projection.
 */
export function ticketProjectionView(state: TicketProjectionState): TicketProjection {
  return {
    tickets: state.tickets,
    ...state.failure === undefined ? {} : { failure: state.failure },
  }
}

/** Session projection for the durable Ticket domain. */
export const ticketProjectionDefinition = {
  key: 'ticket',
  stateVersion: 3,
  stateSchema: z.object({
    sessionId: sessionIdSchema,
    tickets: z.array(ticketSnapshotSchema),
    currentVersionTickets: z.array(ticketIdSchema),
    failure: z.string().optional(),
  }).strict() as z.ZodType<TicketProjectionState>,
  init: header => emptyTicketState(header.id),
  apply: applyProjectionEvent,
  wire: { viewSchema: ticketProjectionSchema, view: ticketProjectionView },
} satisfies ProjectionDefinition<'ticket', TicketProjectionState>
