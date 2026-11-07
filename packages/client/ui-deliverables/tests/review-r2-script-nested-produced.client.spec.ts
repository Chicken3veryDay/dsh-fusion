// @vitest-environment jsdom
/**
 * Review r2-script: under the shipped run_code default every write/edit is a
 * nested dispatch (`tool/ptc-dispatch-start` / `tool/ptc-dispatch`) inside one
 * outer `run_code` call. The produced-file Turn data must still list the files.
 */
import { describe, expect, it } from 'vitest'
import {
  ConversationNodeAssembler, type ConversationNodeDefinition, type ConversationTimelineSnapshot,
  type ConversationViewDefinition, type ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { deliverablesDefinition, producedForClosing } from '../src/client/turn-deliverables.ts'

interface TimelineSnapshot { readonly timeline: ConversationTimelineSnapshot }

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

function result(seq: number, callId: string, meta?: unknown): SessionLiveEventEntry {
  return at(seq, 'tool/result', {
    ...meta === undefined ? {} : { meta }, turn: 1, step: 1,
    message: { id: `result-${callId}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [], isError: false },
  })
}

function produced(entries: readonly SessionLiveEventEntry[]): readonly string[] {
  const assembler = new ConversationNodeAssembler(
    { entries: (): readonly ConversationNodeDefinition[] => [deliverablesDefinition], fallbackEntry: () => undefined },
    { entries: (): readonly ConversationViewDefinition[] => [timelineView] },
  )
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('test')
  const snapshot = assembler.snapshot('test') as TimelineSnapshot
  return producedForClosing(snapshot.timeline.turns.get(1)?.data.get('deliverables'))
}

describe('produced files under the run_code default', () => {
  it('control: a top-level write is listed', () => {
    expect(produced([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'w', name: 'write', arguments: JSON.stringify({ file_path: 'out.txt', content: 'x' }) }),
      result(3, 'w', { path: '/project/out.txt' }),
    ])).toEqual(['/project/out.txt'])
  })

  it('a write made inside run_code is listed', () => {
    const args = { file_path: 'out.txt', content: 'x' }
    expect(produced([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'prog', name: 'run_code', arguments: JSON.stringify({ code: 'await tools.write({file_path:"out.txt",content:"x"})' }) }),
      at(3, 'tool/ptc-dispatch-start', { rootCallId: 'prog', parentCallId: 'prog', subCallId: 'prog:ptc:1', name: 'write', arguments: args }),
      at(4, 'tool/ptc-dispatch', {
        rootCallId: 'prog', parentCallId: 'prog', subCallId: 'prog:ptc:1', name: 'write', arguments: args,
        isError: false, content: [{ type: 'text', text: 'wrote out.txt' }], meta: { path: '/project/out.txt' },
      }),
      result(5, 'prog'),
      at(6, 'turn/end', { turn: 1 }),
    ])).toEqual(['/project/out.txt'])
  })
})
