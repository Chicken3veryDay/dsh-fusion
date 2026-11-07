/**
 * Review r2-script: base now defaults to run_code, and the personalized-recommendations
 * bundle does not select native. A `propose_action` call is then a nested dispatch
 * inside `run_code`; the projection must still admit its card.
 */
import { expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { actionCardProjection, type ActionCardState } from '../src/projection.ts'

const args = { action: 'test_action', title: 'Counter', brief: 'Keep count visible', details: { value: 'a' } }
let seq = 0
const next = (): SessionSeq => SessionSeq(seq++)

function init(): ActionCardState {
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('cards'), createdAt: 0, isSeeded: false }
  return actionCardProjection.init(header, SessionLogOffset(0))
}

const fold = (events: readonly SessionEvent[]): ActionCardState => events.reduce(actionCardProjection.apply, init())

function call(callId: string, name: string, value: object): SessionEvent<'tool/call'> {
  return { type: 'tool/call', seq: next(), time: 0, data: { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: JSON.stringify(value) } }
}

function result(callId: string): SessionEvent<'tool/result'> {
  return { type: 'tool/result', seq: next(), time: 0, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId(callId), content: [], isError: false }) } }
}

it('control: a top-level propose_action becomes a card', () => {
  const state = fold([{ type: 'turn/start', seq: next(), time: 0, data: { turn: 1 } }, call('c1', 'propose_action', args), result('c1')])
  expect(Object.keys(state.view.proposals)).toEqual(['c1'])
})

it('a propose_action made inside run_code becomes a card', () => {
  const ids = { rootCallId: ToolCallId('prog'), parentCallId: ToolCallId('prog'), subCallId: ToolCallId('prog:ptc:1'), name: 'propose_action', arguments: args }
  const state = fold([
    { type: 'turn/start', seq: next(), time: 0, data: { turn: 1 } },
    call('prog', 'run_code', { code: 'await tools.propose_action({})' }),
    { type: 'tool/ptc-dispatch-start', seq: next(), time: 0, data: ids },
    { type: 'tool/ptc-dispatch', seq: next(), time: 0, data: { ...ids, isError: false, content: [{ type: 'text', text: 'proposed' }] } },
    result('prog'),
  ])
  expect(Object.keys(state.view.proposals)).toEqual(['prog:ptc:1'])
})
