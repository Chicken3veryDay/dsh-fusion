/** Browser-safe Workstream panel Remote requests and failure codes. */
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { TicketAttentionId, TicketId, TicketQuestionId } from '@deepseek-ai/dsh-experimental-ticket/client'

/** One question command against the Ticket revision the panel displayed. */
export interface WorkstreamQuestionTarget {
  readonly ticketId: TicketId
  readonly questionId: TicketQuestionId
  /** Ticket revision the panel read; a different current revision rejects with `workstreamPanel/stale-revision`. */
  readonly expectedRevision: number
}

/** Answer text for one open question. */
export interface WorkstreamQuestionAnswer extends WorkstreamQuestionTarget {
  readonly answer: string
}

/** One attention command against the Ticket revision the panel displayed. */
export interface WorkstreamAttentionTarget {
  readonly ticketId: TicketId
  readonly attentionId: TicketAttentionId
  /** Ticket revision the panel read; a different current revision rejects with `workstreamPanel/stale-revision`. */
  readonly expectedRevision: number
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The Ticket changed after the panel read it; reread the projection before retrying. */
    'workstreamPanel/stale-revision': Record<string, never>
    /** The calling Session is not the Workstream member or Ticket role the command requires. */
    'workstreamPanel/denied': Record<string, never>
    /** The Workstream owner is not live or the Session belongs to no Workstream. */
    'workstreamPanel/unavailable': Record<string, never>
    /** The Ticket service rejected the command; the message carries its diagnostic. */
    'workstreamPanel/rejected': Record<string, never>
  }
}
