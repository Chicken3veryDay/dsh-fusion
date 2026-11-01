/** Bounded repair gaps admit only the exact interrupted step/turn/tool housekeeping. */
import { expect, it } from 'vitest'
import { createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, interruptedTurnClosers, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ReceiverState } from '../src/delivery-state.ts'
import { receiverProjection, createIntent, DeliveryId } from '../src/delivery-state.ts'

it.each([false, true])('matches interrupted tools with started=%s and preserves the incomplete pair until its original insertion', (started) => {
  const target = SessionId('receiver')
  const header: SessionHeader = { id: target, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false }
  const intent = createIntent({ deliveryId: DeliveryId('repair'), targetParticipantId: target,
    inboxTarget: 'next-turn', correlationId: null, text: 'text' }, SessionId('root'), { kind: 'user' }, 1)
  const callId = ToolCallId('call')
  const message = createAssistantMessage({ source: { provider: 'fake', model: 'fake' },
    content: [{ type: 'text', text: 'before' }, { type: 'tool-call', id: callId, name: 'test', arguments: '{}' }] })
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 0, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: SessionSeq(2), time: 0, surfaceOp: 'append', data: { turn: 1, step: 1, message, stream: [] } },
  ]
  let unmatched: ReceiverState = receiverProjection.init(header)
  for (const event of events) unmatched = receiverProjection.apply(unmatched, event)
  expect(receiverProjection.apply(unmatched, { type: 'tool/call', seq: SessionSeq(3), time: 0,
    data: { turn: 1, step: 1, callId: ToolCallId('unrelated'), name: 'test', arguments: '{}' } }).calls).toEqual(unmatched.calls)
  if (started) events.push({ type: 'tool/call', seq: SessionSeq(3), time: 0, data: { turn: 1, step: 1, callId, name: 'test', arguments: '{}' } })
  events.push({ type: 'fusion/delivery-accepted', seq: SessionSeq(events.length), time: 0, data: intent })
  let state: ReceiverState = receiverProjection.init(header)
  for (const event of events) state = receiverProjection.apply(state, event)
  const closers = interruptedTurnClosers(events)
  expect(closers.map(row => row.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
  for (const closer of closers) state = receiverProjection.apply(state, closer)
  state = receiverProjection.apply(state, { type: 'session/end-seed', seq: SessionSeq(events.length + 3), time: 0, data: {} })
  expect(state.entries[0]?.instructionSeq).toBeNull()
  const instruction = { type: 'agent/inbox/spliced', seq: SessionSeq(events.length + 4), time: 0,
    data: { target: 'next-turn', start: 0, inserted: [intent.instruction] } } satisfies SessionEvent
  state = receiverProjection.apply(state, instruction)
  expect(state.entries[0]?.instructionSeq).toBe(instruction.seq)
  expect(() => receiverProjection.apply(state, instruction)).toThrow()
})
