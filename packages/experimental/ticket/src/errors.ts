/** Structured Ticket command and recovery failures. */

/** Errors returned by Ticket commands, with stable machine-readable codes. */
export type TicketErrorCode =
  | 'TICKET_ACCEPTANCE'
  | 'TICKET_ATTEMPT_STATE'
  | 'TICKET_STALE_ATTEMPT'
  | 'TICKET_OPERATION_CONFLICT'
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
