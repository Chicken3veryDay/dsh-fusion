import { expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  appendPluginRecord, Session, SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { actionCardProjection, type ActionCardState } from '../src/projection.ts'
import type { ActionCardDecision } from '../src/types.ts'

const projection = actionCardProjection
const args = { action: 'test_action', title: 'Counter', brief: 'Keep count visible', details: { value: 'a' } }
let seq = 0

function init(inherited = 0): ActionCardState {
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('cards'), createdAt: 0, isSeeded: inherited > 0 }
  return projection.init(header, SessionLogOffset(inherited))
}

function turn(value: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: SessionSeq(seq++), time: 0, data: { turn: value } }
}

function call(callId: string, value: object | string = args, turnNumber = 1, name = 'propose_action'): SessionEvent<'tool/call'> {
  return { type: 'tool/call', seq: SessionSeq(seq++), time: 0,
    data: { turn: turnNumber, step: 1, callId: ToolCallId(callId), name, arguments: typeof value === 'string' ? value : JSON.stringify(value) } }
}

function result(callId: string, isError = false, turnNumber = 1): SessionEvent<'tool/result'> {
  return { type: 'tool/result', seq: SessionSeq(seq++), time: 0, surfaceOp: 'append',
    data: { turn: turnNumber, step: 1, message: createToolResultMessage({ callId: ToolCallId(callId), content: [], isError }) } }
}

function spliced(inserted: number, removedCount?: number, target: 'next-turn' | 'next-step' = 'next-turn'): SessionEvent<'agent/inbox/spliced'> {
  return { type: 'agent/inbox/spliced', seq: SessionSeq(seq++), time: 0, data: { target, start: 0, ...removedCount === undefined ? {} : { removedCount },
    inserted: Array.from({ length: inserted }, () => createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } })) } }
}

function records(...data: ActionCardDecision[]): readonly SessionEvent[] {
  const session = Session.create(SessionId('records'))
  for (const value of data) appendPluginRecord(session, 'plugin:action-cards/decision', value)
  return session.snapshotEvents()
}

const fold = (events: readonly SessionEvent[], state = init()) => events.reduce(projection.apply, state)

function nested(callId: string, value: object, isError = false, name = 'propose_action'): SessionEvent[] {
  const ids = { rootCallId: ToolCallId('prog'), parentCallId: ToolCallId('prog'), subCallId: ToolCallId(callId), name, arguments: value }
  return [
    { type: 'tool/ptc-dispatch-start', seq: SessionSeq(seq++), time: 0, data: ids },
    { type: 'tool/ptc-dispatch', seq: SessionSeq(seq++), time: 0, data: { ...ids, isError, content: [] } },
  ]
}

it('admits a propose_action nested in run_code in the open turn, under the same rules', () => {
  const state = fold([turn(2), call('prog', { code: '' }, 2, 'run_code'), ...nested('prog:ptc:1', args), result('prog', false, 2)])
  expect(state.view.proposals).toEqual({ 'prog:ptc:1': { callId: 'prog:ptc:1', turn: 2, ...args } })
  expect(fold(nested('early', args)).view.proposals).toEqual({})
  expect(fold([turn(1), ...nested('failed', args, true)]).view.proposals).toEqual({})
  expect(fold([turn(1), ...nested('other', args, false, 'other_tool')]).view.proposals).toEqual({})
  expect(Object.keys(fold([...nested('second', args)], state).view.proposals)).toEqual(['prog:ptc:1'])
})

it('admits a successful propose_action call as a card in its turn and ignores failed, malformed and other calls', () => {
  const state = fold([turn(1), call('c1'), result('c1')])
  expect(state.view.proposals).toEqual({ c1: { callId: 'c1', turn: 1, ...args } })
  expect(state.calls).toEqual({})
  for (const events of [
    [call('c2'), result('c2', true)],
    [call('c3', '{broken')],
    [call('c4', { ...args, title: ' ' })],
    [call('c5', { ...args, details: 'text' })],
    [call('c6', args, 1, 'other_tool'), result('c6')],
    [result('unrelated')],
  ]) {
    expect(fold(events).view.proposals).toEqual({})
  }
  const trimmed = fold([call('c7', { ...args, title: '  Counter  ' }), result('c7')])
  expect(trimmed.view.proposals.c7?.title).toBe('Counter')
  const pending = fold([call('c8')])
  expect(Object.keys(pending.calls)).toEqual(['c8'])
  expect(projection.apply(pending, turn(2)).calls).toEqual({})
  const idle = fold([turn(3)])
  expect(projection.apply(idle, turn(3))).toBe(idle)
  expect(projection.apply(idle, turn(4))).toEqual({ ...idle, turn: 4 })
})

it('keeps the first admitted card of a turn and replaces only unstarted earlier cards', () => {
  const first = fold([turn(1), call('a'), result('a')])
  const late = fold([call('b'), result('b')], first)
  expect(Object.keys(late.view.proposals)).toEqual(['a'])
  const next = fold([turn(2), call('c', args, 2), result('c', false, 2)], first)
  expect(next.view.decisions).toEqual({ a: { callId: 'a', action: 'test_action', phase: 'replaced' } })
  const started = fold(records({ callId: ToolCallId('a'), action: 'test_action', phase: 'creating' }), first)
  const afterStart = fold([turn(2), call('c', args, 2), result('c', false, 2)], started)
  expect(afterStart.view.decisions.a?.phase).toBe('creating')
  expect(afterStart.view.decisions.c).toBeUndefined()
  // Replacement crosses kinds: a card of another action replaces the unstarted one too.
  const other = fold([turn(2), call('d', { ...args, action: 'other_action' }, 2), result('d', false, 2)], first)
  expect(other.view.decisions).toEqual({ a: { callId: 'a', action: 'test_action', phase: 'replaced' } })
})

it('counts user messages queued for later turns for the card tool and leaves cards to it', () => {
  const queued = fold([turn(1), spliced(1, undefined, 'next-step'), spliced(2), call('a'), result('a')])
  expect(queued.queued).toBe(2)
  expect(Object.keys(queued.view.proposals)).toEqual(['a'])
  expect(queued.view.decisions).toEqual({})
  expect(fold([spliced(0, 2)], queued).queued).toBe(0)
  expect(fold([spliced(0, 5)]).queued).toBe(0)
})

it('ignores the events a forked Session inherits from its parent', () => {
  const parent = [turn(1), call('a'), result('a')]
  // Every event created so far precedes the fork point.
  const inherited = init(seq)
  expect(fold(parent, inherited)).toBe(inherited)
  const own = fold([turn(2), call('b', args, 2), result('b', false, 2)], inherited)
  expect(Object.keys(own.view.proposals)).toEqual(['b'])
  expect(own.view.decisions).toEqual({})
})

it('records valid decisions as pending status until a status notice acknowledges them', () => {
  const [created, malformed, dismissed] = records(
    { callId: ToolCallId('a'), action: 'test_action', phase: 'creating', data: { value: 1 } },
    { callId: ToolCallId('a'), action: 'test_action', phase: '' },
    { callId: ToolCallId('b'), action: 'test_action', phase: 'dismissed' },
  )
  const state = fold([created!, malformed!, dismissed!])
  expect(state.view.decisions).toEqual({
    a: { callId: 'a', action: 'test_action', phase: 'creating', data: { value: 1 } },
    b: { callId: 'b', action: 'test_action', phase: 'dismissed' },
  })
  expect(state.pendingStatus).toEqual({ a: created!.seq, b: dismissed!.seq })
  const notice = (through: number): SessionEvent<'user/message'> => ({ type: 'user/message', seq: SessionSeq(99), time: 0, surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: 'status' }],
      source: { kind: 'action-cards', through: SessionSeq(through), form: 'notice', summary: 'status' } }) })
  expect(projection.apply(state, notice(created!.seq)).pendingStatus).toEqual({ b: dismissed!.seq })
  const user: SessionEvent<'user/message'> = { type: 'user/message', seq: SessionSeq(100), time: 0, surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }) }
  expect(projection.apply(state, user)).toBe(state)
})

it('publishes proposals and decisions as one view reused across internal state changes', () => {
  const state = fold([turn(1), call('a'), result('a')])
  const view = projection.wire.view(state)
  expect(view).toBe(state.view)
  expect(projection.wire.viewSchema.parse(view)).toEqual(view)
  expect(projection.wire.view(fold([spliced(1), call('pending')], state))).toBe(view)
  expect(projection.stateSchema.parse(state)).toEqual(state)
})

it('keeps cards and supersession for prototype-named call ids through state and wire parsing', () => {
  for (const id of ['__proto__', 'constructor', 'toString']) {
    const state = fold([turn(1), call(id), result(id), turn(2), call('next', args, 2), result('next', false, 2)])
    expect(Object.keys(state.view.proposals)).toEqual([id, 'next'])
    expect(Object.keys(state.view.decisions)).toEqual([id])
    expect(state.view.decisions[id]).toEqual({ callId: id, action: 'test_action', phase: 'replaced' })
    expect(Object.getPrototypeOf(state.view.decisions)).toBe(Object.prototype)
    const restored = projection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
    expect(restored).toEqual(state)
    expect(Object.keys(projection.wire.viewSchema.parse(JSON.parse(JSON.stringify(state.view))).proposals)).toEqual([id, 'next'])
  }
  const pending = fold([turn(1), call('__proto__')])
  expect(Object.keys(pending.calls)).toEqual(['__proto__'])
  expect(Object.keys(projection.stateSchema.parse(JSON.parse(JSON.stringify(pending))).calls)).toEqual(['__proto__'])
  const decided = fold(records({ callId: ToolCallId('__proto__'), action: 'test_action', phase: 'creating' }))
  expect(Object.keys(decided.pendingStatus)).toEqual(['__proto__'])
  expect(Object.keys(projection.stateSchema.parse(JSON.parse(JSON.stringify(decided))).pendingStatus)).toEqual(['__proto__'])
})

it('rejects a state or view whose call-id record is not an object or holds an invalid entry', () => {
  const state = fold([turn(1), call('a'), result('a')])
  expect(projection.stateSchema.safeParse({ ...state, calls: [] }).success).toBe(false)
  expect(projection.stateSchema.safeParse({ ...state, calls: null }).success).toBe(false)
  expect(projection.wire.viewSchema.safeParse({ proposals: { a: { callId: 'a' } }, decisions: {} }).success).toBe(false)
  expect(projection.stateSchema.safeParse({ ...state, pendingStatus: { a: 'seq' } }).success).toBe(false)
})
