import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { acceptedMessage } from '../src/accepted-message.ts'

const prompt: UserMessage = createUserMessage([{ type: 'text', text: 'Initial instructions' }], { kind: 'user' })
const inserted = (): SessionEvent => ({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [prompt] } }) as SessionEvent
const spliced = (outcome?: 'canceled'): SessionEvent => ({
  type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], ...outcome === undefined ? {} : { outcome } },
}) as SessionEvent
const isPrompt = (message: UserMessage): boolean => message.id === prompt.id

describe('durable message acceptance evidence', () => {
  it('counts a message still waiting in the inbox', () => {
    expect(acceptedMessage([inserted()], isPrompt)).toBe(prompt.id)
  })

  it('counts a message a turn claimed before its user/message was committed', () => {
    expect(acceptedMessage([inserted(), spliced()], isPrompt)).toBe(prompt.id)
  })

  it('counts a message that reached the turn history', () => {
    const history = { type: 'user/message', data: prompt } as SessionEvent
    expect(acceptedMessage([inserted(), spliced(), history], isPrompt)).toBe(prompt.id)
  })

  it('does not count a message cancelled out of the inbox unrun', () => {
    expect(acceptedMessage([inserted(), spliced('canceled')], isPrompt)).toBeUndefined()
  })

  it('does not count a different message', () => {
    expect(acceptedMessage([inserted()], message => message.id === 'other')).toBeUndefined()
  })
})
