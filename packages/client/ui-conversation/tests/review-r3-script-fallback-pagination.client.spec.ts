import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import {
  ConversationEventRegistry, ConversationNodeAssembler,
  type ConversationMatchHandler, type ConversationNodeDefinitionInput,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

function at(event: Omit<SessionEvent, 'time'>): SessionLiveEventEntry {
  return { type: 'event', event: { ...event, time: event.seq } as SessionEvent }
}

const turnStart = at({ type: 'turn/start', seq: SessionSeq(1), data: { turn: 1 } })
const call = at({ type: 'tool/call', seq: SessionSeq(2), data: { turn: 1, step: 1, callId: ToolCallId('prog'), name: 'run_code', arguments: '{}' } })
const dispatchStart = at({
  type: 'tool/ptc-dispatch-start', seq: SessionSeq(3),
  data: { rootCallId: ToolCallId('prog'), parentCallId: ToolCallId('prog'), subCallId: ToolCallId('prog:ptc:1'), name: 'write', arguments: {} },
})

const located: ConversationMatchHandler = event => event.type === 'tool/ptc-dispatch-start'
  ? { located: 'turn', role: 'update' }
  : null

function registry(): ConversationEventRegistry {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return new ConversationEventRegistry(ctx)
}

function viewDefinition(kind: string, match: ConversationMatchHandler): ConversationNodeDefinitionInput<null> {
  return { kind, target: 'chat', match, start: () => null, update: context => context.state, buildViewNode: () => null }
}

describe('review r3: Turn-located fallback pagination', () => {
  it.each([false, true])('routes a resolved fallback when paged=%s', (paged) => {
    const start = vi.fn(() => null)
    const events = registry()
    events.registerFallback({
      ...viewDefinition('fallback', event => located(event) && { located: 'turn', role: 'start' }),
      start,
    })
    const target = new ConversationNodeAssembler(events, { entries: () => [] })
    if (paged) {
      target.replaceWindow([dispatchStart], true)
      expect(start).not.toHaveBeenCalled()
      target.prepend([turnStart, call], false)
    } else {
      target.replaceWindow([turnStart, call, dispatchStart], false)
    }
    expect(start).toHaveBeenCalledOnce()
  })
})
