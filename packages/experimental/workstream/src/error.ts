/** Structured failures preserve unknown effects for safe retry decisions. */

/** Handling-relevant Workstream failure categories. */
export type WorkstreamErrorCode = 'WORKSTREAM_UNAUTHORIZED' | 'WORKSTREAM_NOT_FOUND' | 'WORKSTREAM_CONFLICT'
  | 'WORKSTREAM_LIMIT' | 'WORKSTREAM_INVALID_INPUT' | 'WORKSTREAM_UNKNOWN' | 'WORKSTREAM_DISPOSED'

/** Domain failure; UNKNOWN means inspect the durable intent before further action. */
export class WorkstreamError extends Error {
  constructor(message: string, readonly code: WorkstreamErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkstreamError'
  }
}
