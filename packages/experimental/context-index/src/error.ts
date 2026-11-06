/** Typed error definitions for the context index. */

/** Handling-relevant context index failure codes. */
export type ContextIndexErrorCode =
  | 'CONTEXT_INDEX_INVALID_CONFIG'
  | 'CONTEXT_INDEX_INVALID_INPUT'
  | 'CONTEXT_INDEX_DISPOSED'

/** Structured failure for context index configuration, requests, and disposal. */
export class ContextIndexError extends Error {
  constructor(message: string, readonly code: ContextIndexErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ContextIndexError'
  }
}
