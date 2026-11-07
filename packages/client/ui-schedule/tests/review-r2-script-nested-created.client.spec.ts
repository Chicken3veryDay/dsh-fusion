// @vitest-environment jsdom
/**
 * Review r2-script: under the shipped run_code default a `schedule_create`
 * call is a nested dispatch inside one outer `run_code` call. The Turn's
 * created-task card data must still record the created task.
 */
import { describe, expect, it } from 'vitest'
import {
  ConversationNodeAssembler, type ConversationNodeDefinition, type ConversationTimelineSnapshot,
  type ConversationViewDefinition, type ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { scheduleTasksForClosing, scheduleTurnDefinition } from '../src/client/schedule-turn.ts'

interface TimelineSnapshot { readonly timeline: ConversationTimelineSnapshot }

const ARGS = { prompt: 'Check the deployment', daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' } }
const TASK = {
  id: 'task-daily', kind: 'daily', prompt: 'Check the deployment', scheduledAt: '2026-10-01T15:00:00.000Z',
  time: '23:00:00.000', timeZone: 'Asia/Shanghai',
}

const timelineView: ConversationViewDefinition<ConversationViewNode, TimelineSnapshot> = {
  target: 'test',
  create: () => {
    let current: TimelineSnapshot = { timeline: { turnOrder: [], turns: new Map() } }
    return { empty: current, replace: ({ timeline }) => (current = { timeline }), apply: ({ timeline }) => (current = { timeline }) }
  },
}

function at(seq: number, type: string, data: unknown): SessionLiveEventEntry {
  return { type: 'event', event: { seq, time: seq * 1_000, type, data, ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}) } as SessionEvent }
}

function result(seq: number, callId: string, text: string): SessionLiveEventEntry {
  return at(seq, 'tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text }], isError: false }),
  })
}

function created(entries: readonly SessionLiveEventEntry[]): number {
  const assembler = new ConversationNodeAssembler(
    { entries: (): readonly ConversationNodeDefinition[] => [scheduleTurnDefinition], fallbackEntry: () => undefined },
    { entries: (): readonly ConversationViewDefinition[] => [timelineView] },
  )
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('test')
  const snapshot = assembler.snapshot('test') as TimelineSnapshot
  return scheduleTasksForClosing(snapshot.timeline.turns.get(1)?.data.get('schedule-created')).length
}

describe('created-task card under the run_code default', () => {
  it('control: a top-level schedule_create is recorded', () => {
    expect(created([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'schedule_create', arguments: JSON.stringify(ARGS) }),
      result(3, 'c', JSON.stringify(TASK)),
    ])).toBe(1)
  })

  it('a schedule_create made inside run_code is recorded', () => {
    expect(created([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'prog', name: 'run_code', arguments: JSON.stringify({ code: 'await tools.schedule_create({})' }) }),
      at(3, 'tool/ptc-dispatch-start', { rootCallId: 'prog', parentCallId: 'prog', subCallId: 'prog:ptc:1', name: 'schedule_create', arguments: ARGS }),
      at(4, 'tool/ptc-dispatch', {
        rootCallId: 'prog', parentCallId: 'prog', subCallId: 'prog:ptc:1', name: 'schedule_create', arguments: ARGS,
        isError: false, content: [{ type: 'text', text: JSON.stringify(TASK) }],
      }),
      result(5, 'prog', JSON.stringify(TASK)),
      at(6, 'turn/end', { turn: 1 }),
    ])).toBe(1)
  })
})
