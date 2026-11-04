/** Strict replay projection for the standalone Ticket domain. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  AssignmentId,
  ExecutionSlotId,
  TicketAttentionId,
  TicketId,
  TicketQuestionId,
  TicketReportId,
} from './types.ts'
import type {
  AssignmentSnapshot,
  ExecutionSlotSnapshot,
  TicketAttentionSnapshot,
  TicketProjection,
  TicketQuestionSnapshot,
  TicketReportSnapshot,
  TicketSnapshot,
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

const assignmentSchema: z.ZodType<AssignmentSnapshot> = z.object({
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
}).strict() as z.ZodType<AssignmentSnapshot>

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
export const ticketSnapshotSchema: z.ZodType<TicketSnapshot> = z.object({
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
}).strict() as z.ZodType<TicketSnapshot>

const ticketEventSchema: z.ZodType<SessionEventMap['ticket/state']> = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  ticket: ticketSnapshotSchema,
}).strict()

const ticketSelectorSchema = z.object({
  version: safeInteger,
  sessionId: sessionIdSchema,
}).loose()

/** Projection state retained by the Host and checkpointed by Session projection. */
export interface TicketProjectionState {
  readonly sessionId: SessionId
  readonly tickets: readonly TicketSnapshot[]
  readonly failure?: string
}

/** Create an empty Ticket state for one Session.
 * @param sessionId - Session that owns the Ticket log.
 * @returns empty projection state.
 */
export function emptyTicketState(sessionId: SessionId): TicketProjectionState {
  return { sessionId, tickets: [] }
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
    ready: ['coordinating', 'executing', 'waiting', 'blocked', 'cancelled'],
    coordinating: ['ready', 'executing', 'integrating', 'reviewing', 'waiting', 'blocked', 'cancelled'],
    executing: ['ready', 'integrating', 'reviewing', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'],
    integrating: ['reviewing', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'],
    reviewing: ['executing', 'waiting', 'completed', 'failed', 'blocked', 'cancelled'],
    waiting: ['ready', 'coordinating', 'executing', 'blocked', 'completed', 'failed', 'cancelled'],
    blocked: ['ready', 'coordinating', 'executing', 'waiting', 'completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  }
  return allowed[previous].includes(next)
}

function parsePersisted<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value)
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

function applyCurrentEvent(state: TicketProjectionState, event: TicketSessionEvent): TicketProjectionState {
  const ticket = event.data.ticket
  const index = state.tickets.findIndex(candidate => candidate.id === ticket.id)
  const previous = index < 0 ? undefined : state.tickets[index]
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
  return { ...state, tickets: replaceTicket(state.tickets, index, ticket) }
}

function applyProjectionEvent(state: TicketProjectionState, event: SessionEvent): TicketProjectionState {
  if (state.failure !== undefined || !isTicketEvent(event)) return state
  try {
    const decoded = parsePersisted(ticketEventSchema, event.data)
    const selector = ticketSelectorSchema.parse(decoded)
    if (selector.sessionId !== state.sessionId) return state
    if (selector.version !== 1) throw new Error(`unsupported Ticket event version ${String(selector.version)}`)
    return applyCurrentEvent(state, { ...event, data: decoded })
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
  stateVersion: 1,
  stateSchema: z.object({
    sessionId: sessionIdSchema,
    tickets: z.array(ticketSnapshotSchema),
    failure: z.string().optional(),
  }).strict() as z.ZodType<TicketProjectionState>,
  init: header => emptyTicketState(header.id),
  apply: applyProjectionEvent,
  wire: { viewSchema: ticketProjectionSchema, view: ticketProjectionView },
} satisfies ProjectionDefinition<'ticket', TicketProjectionState>
