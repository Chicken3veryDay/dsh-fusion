/** Typed error definitions for the context tree. */

/** Handling-relevant context tree failure codes. */
export type ContextTreeErrorCode =
  | 'CONTEXT_TREE_INVALID_CONFIG'
  | 'CONTEXT_TREE_INVALID_INPUT'
  | 'CONTEXT_TREE_DISPOSED'

/** Structured failure for context tree configuration, requests, and disposal. */
export class ContextTreeError extends Error {
  constructor(message: string, readonly code: ContextTreeErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ContextTreeError'
  }
}
