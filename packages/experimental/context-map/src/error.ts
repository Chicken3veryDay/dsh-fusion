/** Typed error definitions for the project map. */

/** Handling-relevant project map failure codes. */
export type ContextMapErrorCode =
  | 'CONTEXT_MAP_INVALID_CONFIG'
  | 'CONTEXT_MAP_INVALID_INPUT'
  | 'CONTEXT_MAP_UNAUTHORIZED'
  | 'CONTEXT_MAP_CONFLICT'
  | 'CONTEXT_MAP_LIMIT'
  | 'CONTEXT_MAP_NOT_FOUND'
  | 'CONTEXT_MAP_NO_CHEAP_ROUTE'
  | 'CONTEXT_MAP_DISPOSED'

/** Structured failure for map configuration, edits, authority checks, and disposal. */
export class ContextMapError extends Error {
  constructor(message: string, readonly code: ContextMapErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ContextMapError'
  }
}
