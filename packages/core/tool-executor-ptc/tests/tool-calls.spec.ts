import { describe, expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  effectiveToolCall, effectiveToolResult, isToolCallSettleEvent, isToolCallStartEvent,
} from '../src/tool-calls.ts'

const ids = { rootCallId: ToolCallId('prog'), parentCallId: ToolCallId('prog'), subCallId: ToolCallId('prog:ptc:1'), name: 'write' }

function event<T extends SessionEvent['type']>(type: T, data: SessionEvent<T>['data']): SessionEvent<T> {
  return { type, seq: SessionSeq(1), time: 0, data } as SessionEvent<T>
}

describe('effective tool calls', () => {
  it('reads a model-issued call and its result', () => {
    const call = event('tool/call', { turn: 1, step: 1, callId: ToolCallId('c'), name: 'write', arguments: '{"file_path":"a"' })
    expect(isToolCallStartEvent(call)).toBe(true)
    expect(effectiveToolCall(call)).toEqual({ callId: 'c', name: 'write', arguments: '{"file_path":"a"' })
    const result = event('tool/result', {
      turn: 1, step: 1, meta: { path: '/a' },
      message: createToolResultMessage({ callId: ToolCallId('c'), content: [{ type: 'text', text: 'ok' }], isError: false }),
    })
    expect(isToolCallSettleEvent(result)).toBe(true)
    expect(effectiveToolResult(result)).toEqual({ callId: 'c', content: [{ type: 'text', text: 'ok' }], isError: false, meta: { path: '/a' } })
  })

  it('reads a failed model-issued result with its error identity', () => {
    const result = event('tool/result', {
      turn: 1, step: 1, error: { name: 'Error', code: 'failed', reason: 'denied' },
      message: createToolResultMessage({ callId: ToolCallId('c'), content: [{ type: 'text', text: 'no' }], isError: true }),
    })
    expect(effectiveToolResult(result)).toEqual({
      callId: 'c', content: [{ type: 'text', text: 'no' }], isError: true, error: { name: 'Error', code: 'failed', reason: 'denied' },
    })
  })

  it('reads a nested run_code dispatch and its settlement', () => {
    const start = event('tool/ptc-dispatch-start', { ...ids, arguments: { file_path: 'out.txt', content: 'x' } })
    expect(effectiveToolCall(start)).toEqual({
      callId: 'prog:ptc:1', parentCallId: 'prog', name: 'write', arguments: '{"file_path":"out.txt","content":"x"}',
    })
    const settle = event('tool/ptc-dispatch', {
      ...ids, arguments: {}, isError: false, content: [{ type: 'text', text: 'wrote' }], meta: { path: '/out.txt' },
    })
    expect(effectiveToolResult(settle)).toEqual({
      callId: 'prog:ptc:1', parentCallId: 'prog', name: 'write', content: [{ type: 'text', text: 'wrote' }], isError: false, meta: { path: '/out.txt' },
    })
    const failed = event('tool/ptc-dispatch', {
      ...ids, arguments: {}, isError: true, content: [], error: { name: 'Error', code: 'aborted' },
    })
    expect(effectiveToolResult(failed)).toEqual({
      callId: 'prog:ptc:1', parentCallId: 'prog', name: 'write', content: [], isError: true, error: { name: 'Error', code: 'aborted' },
    })
  })

  it('ignores events that start or settle no call', () => {
    const other = event('turn/start', { turn: 1 })
    expect(isToolCallStartEvent(other)).toBe(false)
    expect(isToolCallSettleEvent(other)).toBe(false)
    expect(effectiveToolCall(other)).toBeUndefined()
    expect(effectiveToolResult(other)).toBeUndefined()
  })
})
