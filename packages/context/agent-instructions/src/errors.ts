/**
 * Typed failures of strict workspace instruction loading.
 *
 * @module @deepseek-ai/dsh-agent-instructions/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable classification of a strict-mode instruction failure. */
export type AgentInstructionsErrorCode =
  /** A discovered applicable file could not be probed or read. */
  | 'AGENT_INSTRUCTIONS_SOURCE_UNREADABLE'
  /** A discovered applicable file exceeds `maxSourceBytes`. */
  | 'AGENT_INSTRUCTIONS_SOURCE_TOO_LARGE'
  /** The complete rendered instructions of one chain exceed `maxBytes`. */
  | 'AGENT_INSTRUCTIONS_BUDGET_EXCEEDED'
  /** Strict loading has no filesystem provider to read instructions from. */
  | 'AGENT_INSTRUCTIONS_FS_UNAVAILABLE'

/**
 * A mandatory workspace instruction cannot be loaded or represented in full.
 * Strict mode raises it before the dependent model request is dispatched, so
 * an applicable rule is never silently omitted, truncated, or replaced by a marker.
 */
export class AgentInstructionsError extends HarnessError {
  /**
   * @param message - actionable account naming the source, size, or budget involved.
   * @param code - stable machine-routable classification.
   * @param options - original cause, when a provider or filesystem failure triggered this error.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line eslint/no-useless-constructor, typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: AgentInstructionsErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
