/**
 * Client-safe readers for the effective tool calls of a Session log.
 *
 * A model-issued call is logged as `tool/call` → `tool/result`. A call a
 * `run_code` program makes is logged as `tool/ptc-dispatch-start` →
 * `tool/ptc-dispatch` inside its enclosing `run_code` call. These readers
 * return one record for either form, so a consumer that follows a tool by
 * name sees it whether the model called it directly or from a program. The
 * enclosing `run_code` call itself is also returned as an ordinary call.
 * Nested dispatch events carry no `turn`; a turn-scoped consumer takes the
 * turn of the enclosing call or of the event's resolved location.
 *
 * @module @deepseek-ai/dsh-tool-executor-ptc/tool-calls
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
// Re-exported so declaration consumers also load the nested dispatch event declarations.
export type { PtcDispatchEventData, PtcDispatchStartEventData } from './types.ts'

/** Session events that start one effective tool call. */
export type ToolCallStartEvent = SessionEvent<'tool/call'> | SessionEvent<'tool/ptc-dispatch-start'>

/** Session events that settle one effective tool call. */
export type ToolCallSettleEvent = SessionEvent<'tool/result'> | SessionEvent<'tool/ptc-dispatch'>

/** One started tool call, model-issued or nested in a `run_code` program. */
export interface EffectiveToolCall {
  /** Call identity; a nested call's `subCallId`. */
  readonly callId: ToolCallId
  /** Enclosing `run_code` call of a nested call; absent for a model-issued call. */
  readonly parentCallId?: ToolCallId
  /** Wire tool name. */
  readonly name: string
  /** Arguments as JSON text: the model's raw text for a model-issued call, the serialized dispatched value for a nested call. */
  readonly arguments: string
}

/** One settled tool call, model-issued or nested in a `run_code` program. */
export interface EffectiveToolResult {
  /** Identity of the call this result settles; a nested call's `subCallId`. */
  readonly callId: ToolCallId
  /** Enclosing `run_code` call of a nested call; absent for a model-issued call. */
  readonly parentCallId?: ToolCallId
  /** Wire tool name of a nested call; absent for a model-issued result, whose name is on its `tool/call`. */
  readonly name?: string
  /** Final content in `tool/result` vocabulary. */
  readonly content: readonly ContentBlock[]
  /** Whether the call failed. */
  readonly isError: boolean
  /** Tool-owned presentation metadata, when the tool attached it. */
  readonly meta?: JsonValue
  /** Failure identity and user-facing reason outside model content, when recorded. */
  readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
}

/**
 * Whether an event starts an effective tool call.
 * @param event - any Session or Client history event.
 * @returns true for `tool/call` and `tool/ptc-dispatch-start`.
 */
export function isToolCallStartEvent(event: { readonly type: string }): event is ToolCallStartEvent {
  return event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start'
}

/**
 * Whether an event settles an effective tool call.
 * @param event - any Session or Client history event.
 * @returns true for `tool/result` and `tool/ptc-dispatch`.
 */
export function isToolCallSettleEvent(event: { readonly type: string }): event is ToolCallSettleEvent {
  return event.type === 'tool/result' || event.type === 'tool/ptc-dispatch'
}

/**
 * Read the call an event starts.
 * @param event - any Session or Client history event.
 * @returns the started call, or undefined when the event starts none.
 */
export function effectiveToolCall(event: ToolCallStartEvent): EffectiveToolCall
export function effectiveToolCall(event: { readonly type: string }): EffectiveToolCall | undefined
export function effectiveToolCall(event: { readonly type: string }): EffectiveToolCall | undefined {
  if (!isToolCallStartEvent(event)) return undefined
  if (event.type === 'tool/call') {
    return { callId: event.data.callId, name: event.data.name, arguments: event.data.arguments }
  }
  const data = event.data
  return {
    // The executor JSON-normalized the dispatched value before logging it.
    callId: data.subCallId, parentCallId: data.parentCallId, name: data.name, arguments: JSON.stringify(data.arguments),
  }
}

/**
 * Read the result an event settles.
 * @param event - any Session or Client history event.
 * @returns the settled result, or undefined when the event settles no call.
 */
export function effectiveToolResult(event: ToolCallSettleEvent): EffectiveToolResult
export function effectiveToolResult(event: { readonly type: string }): EffectiveToolResult | undefined
export function effectiveToolResult(event: { readonly type: string }): EffectiveToolResult | undefined {
  if (!isToolCallSettleEvent(event)) return undefined
  if (event.type === 'tool/result') {
    const { message, meta, error } = event.data
    return {
      callId: message.toolCallId, content: message.content, isError: message.isError === true,
      ...meta === undefined ? {} : { meta }, ...error === undefined ? {} : { error },
    }
  }
  const { subCallId, parentCallId, name, content, isError, meta, error } = event.data
  return {
    callId: subCallId, parentCallId, name, content, isError,
    ...meta === undefined ? {} : { meta }, ...error === undefined ? {} : { error },
  }
}
