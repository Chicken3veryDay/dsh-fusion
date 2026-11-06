import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { acceptedMessage } from '../src/accepted-message.ts'

const prompt: UserMessage = createUserMessage({ content: [{ type: 'text', text: 'Initial instructions' }], source: { kind: 'user' } })
const inserted = (): SessionEvent => ({
  type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 0, data: { target: 'next-turn', start: 0, inserted: [prompt] },
})
const spliced = (outcome?: 'canceled'): SessionEvent => ({
  type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 0,
  data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], ...outcome === undefined ? {} : { outcome } },
})
const isPrompt = (message: UserMessage): boolean => message.id === prompt.id

describe('durable message acceptance evidence', () => {
  it('counts a message still waiting in the inbox', () => {
    expect(acceptedMessage([inserted()], isPrompt)).toBe(prompt.id)
  })

  it('counts a message a turn claimed before its user/message was committed', () => {
    expect(acceptedMessage([inserted(), spliced()], isPrompt)).toBe(prompt.id)
  })

  it('counts a message that reached the turn history', () => {
    const history: SessionEvent = { type: 'user/message', seq: SessionSeq(3), time: 0, surfaceOp: 'append', data: prompt }
    expect(acceptedMessage([inserted(), spliced(), history], isPrompt)).toBe(prompt.id)
  })

  it('does not count a message cancelled out of the inbox unrun', () => {
    expect(acceptedMessage([inserted(), spliced('canceled')], isPrompt)).toBeUndefined()
  })

  it('does not count a different message', () => {
    expect(acceptedMessage([inserted()], message => message.id === 'other')).toBeUndefined()
  })
})
