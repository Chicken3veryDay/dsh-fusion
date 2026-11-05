/** Structured failures preserve unknown effects for safe retry decisions. */
import type { TicketId } from '@deepseek-ai/dsh-experimental-ticket'

/** Handling-relevant Workstream failure categories. */
export type WorkstreamErrorCode = 'WORKSTREAM_UNAUTHORIZED' | 'WORKSTREAM_NOT_FOUND' | 'WORKSTREAM_CONFLICT'
  | 'WORKSTREAM_LIMIT' | 'WORKSTREAM_INVALID_INPUT' | 'WORKSTREAM_UNKNOWN' | 'WORKSTREAM_DISPOSED'
  | 'WORKSTREAM_PARTIAL_HANDOFF'

/** Domain failure; UNKNOWN means inspect the durable intent before further action. */
export class WorkstreamError extends Error {
  constructor(message: string, readonly code: WorkstreamErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkstreamError'
  }
}

/** Coordinator handoff moved only some Tickets; the Workstream coordinator is unchanged and the same handoff may be retried. */
export class WorkstreamPartialHandoffError extends WorkstreamError {
  /**
   * @param moved - Ticket ids whose coordinator is now the requested member.
   * @param pending - Ticket ids still held by their previous coordinator.
   * @param options - first Ticket failure as `cause`.
   */
  constructor(readonly moved: readonly TicketId[], readonly pending: readonly TicketId[], options?: ErrorOptions) {
    super(`Coordinator handoff moved ${String(moved.length)} Ticket(s) and left ${String(pending.length)} unmoved; retry the same handoff`,
      'WORKSTREAM_PARTIAL_HANDOFF', options)
    this.name = 'WorkstreamPartialHandoffError'
  }
}
