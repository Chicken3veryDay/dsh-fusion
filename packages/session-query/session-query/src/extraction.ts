/** First-party semantic text extraction for session-query consumers. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: includes the first-party todo event consumed below.
import type {} from '@deepseek-ai/dsh-tool-todo'
import { effectiveToolCall, effectiveToolResult } from '@deepseek-ai/dsh-tool-executor-ptc/tool-calls'

/**
 * Extract searchable semantic text from one first-party session event.
 *
 * Structural boundaries, embedded raw streams, request envelopes, and unknown
 * declaration-merged events contribute no text.
 * @param event - event to inspect.
 * @returns newline-joined semantic text, or an empty string when non-searchable.
 */
export function extractSessionEventText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return contentText(event.data.content)
    case 'assistant/message':
      return contentText(event.data.message.content)
    // A call nested in a `run_code` program is searchable like a model-issued call.
    case 'tool/call':
    case 'tool/ptc-dispatch-start': {
      const call = effectiveToolCall(event)
      return joinText([call.name, call.arguments])
    }
    case 'tool/result':
    case 'tool/ptc-dispatch': {
      const result = effectiveToolResult(event)
      return joinText([contentText(result.content), result.error?.name ?? '', result.error?.code ?? ''])
    }
    case 'todo/write':
      return joinText(event.data.todos.flatMap(todo => [todo.status, todo.content]))
    case 'turn/end':
      return turnEndText(event.data.reason)
    case 'turn/start':
    case 'step/start':
    case 'step/end':
    case 'assistant/attempt':
    case 'request/header':
      return ''
    // SessionEventMap is merge-extensible. Unknown events remain
    // non-searchable until a concrete first-party consumer defines semantics.
    default:
      return ''
  }
}

function turnEndText(reason: SessionEvent<'turn/end'>['data']['reason']): string {
  switch (reason.kind) {
    case 'error':
      return joinText(['error', reason.error.message])
    case 'aborted':
      return 'aborted'
    case 'max-tokens':
    case 'interrupted':
      return reason.kind
    case 'completed':
      return ''
    // TurnEndReasonMap is merge-extensible. Unknown outcomes stay out until
    // their owner defines which detail is semantic rather than structural.
    default:
      return ''
  }
}

type SessionContentBlock = SessionEvent<'user/message'>['data']['content'][number]

function contentText(content: readonly SessionContentBlock[]): string {
  return joinText(content.flatMap(blockText))
}

function blockText(block: SessionContentBlock): string[] {
  switch (block.type) {
    case 'text':
      return [block.text]
    case 'reasoning':
      return []
    case 'tool-call':
      return [block.name, block.arguments]
    // ContentBlockMap is merge-extensible. Unknown blocks do not become
    // searchable merely because their payload happens to contain strings.
    default:
      return []
  }
}

function joinText(parts: readonly string[]): string {
  return parts.map(part => part.trim()).filter(Boolean).join('\n')
}
