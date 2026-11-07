import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import {
  ConversationEventRegistry, ConversationNodeAssembler,
  type ConversationMatchHandler, type ConversationNodeDefinitionInput, type ConversationTimelineSnapshot,
  type ConversationViewDefinition, type ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Test-only: sequences a Turn-keyed Definition received. */
    'located-seen': readonly number[]
  }
}

interface Snapshot { readonly timeline: ConversationTimelineSnapshot }

const timelineView: ConversationViewDefinition<ConversationViewNode, Snapshot> = {
  target: 'test',
  create: () => {
    let current: Snapshot = { timeline: { turnOrder: [], turns: new Map() } }
    return { empty: current, replace: ({ timeline }) => (current = { timeline }), apply: ({ timeline }) => (current = { timeline }) }
  },
}

const ids = { rootCallId: ToolCallId('prog'), parentCallId: ToolCallId('prog'), name: 'write', arguments: {} }

function at(event: Omit<SessionEvent, 'time'>): SessionLiveEventEntry {
  return { type: 'event', event: { ...event, time: event.seq } as SessionEvent }
}

const turnStart = at({ type: 'turn/start', seq: SessionSeq(1), data: { turn: 1 } })
const call = at({ type: 'tool/call', seq: SessionSeq(2), data: { turn: 1, step: 1, callId: ToolCallId('prog'), name: 'run_code', arguments: '{}' } })
const dispatchStart = at({ type: 'tool/ptc-dispatch-start', seq: SessionSeq(3), data: { ...ids, subCallId: ToolCallId('prog:ptc:1') } })
const dispatch = at({
  type: 'tool/ptc-dispatch', seq: SessionSeq(4), data: { ...ids, subCallId: ToolCallId('prog:ptc:1'), isError: false, content: [] },
})
const turnEnd = at({ type: 'turn/end', seq: SessionSeq(5), data: { turn: 1, reason: { kind: 'completed' } } })

const located: ConversationMatchHandler = event => event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
  ? { located: 'turn', role: 'update' }
  : null

/** Turn-keyed Definition that records every sequence it receives. */
const seen: ConversationNodeDefinitionInput<{ readonly turn: number; readonly seqs: readonly number[] }> = {
  kind: 'located-seen',
  match: event => event.type === 'turn/start' ? { id: String(event.data.turn), role: 'start' } : located(event),
  start: (_context, match) => ({ turn: match.event.type === 'turn/start' ? match.event.data.turn : -1, seqs: [] }),
  update: (context, match) => ({ ...context.state, seqs: [...context.state.seqs, match.event.seq] }),
  buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined ? null
    : { kind: 'turn', turn: context.state.turn, key: 'located-seen', value: context.state.seqs },
}

/** An identity-addressed Definition for the same events, which a relocation must not route again. */
const identified = vi.fn<ConversationMatchHandler>(event => event.type === 'tool/ptc-dispatch' ? { id: 'one', role: 'start' } : null)

function registry(): ConversationEventRegistry {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return new ConversationEventRegistry(ctx)
}

function viewDefinition(kind: string, match: ConversationMatchHandler): ConversationNodeDefinitionInput<null> {
  return { kind, target: 'chat', match, start: () => null, update: context => context.state, buildViewNode: () => null }
}

function assembler(): ConversationNodeAssembler {
  const events = registry()
  events.register(seen)
  events.register({ kind: 'identified', match: identified, start: () => null, update: context => context.state })
  const result = new ConversationNodeAssembler(events, { entries: () => [timelineView] })
  result.activateTarget('test')
  return result
}

function seqs(target: ConversationNodeAssembler): readonly number[] | undefined {
  target.flush()
  return (target.snapshot('test') as Snapshot).timeline.turns.get(1)?.data.get('located-seen')
}

describe('Turn-located matches', () => {
  it('route nested events to the Turn of their resolved Location', () => {
    const target = assembler()
    target.replaceWindow([turnStart, call, dispatchStart, dispatch, turnEnd], false)
    expect(seqs(target)).toEqual([3, 4])
  })

  it('route a live nested event to the open Turn', () => {
    const target = assembler()
    target.replaceWindow([turnStart, call], false)
    target.append(dispatchStart)
    expect(seqs(target)).toEqual([3])
  })

  it('route events whose Turn an older page resolves, once', () => {
    const target = assembler()
    target.replaceWindow([dispatchStart, dispatch, turnEnd], true)
    expect(seqs(target)).toBeUndefined()
    target.prepend([turnStart, call], false)
    expect(seqs(target)).toEqual([3, 4])
    expect(identified).toHaveBeenCalled()
  })

  it('do not route an already routed event again when an older page changes its Turn', () => {
    const target = assembler()
    target.replaceWindow([call, dispatchStart], true)
    target.prepend([turnStart], false)
    expect(seqs(target)).toEqual([3])
  })

  it('occupy their target while unresolved', () => {
    const fallbackMatch = vi.fn<ConversationMatchHandler>(() => ({ id: 'fallback', role: 'start' }))
    const chat = vi.fn<ConversationMatchHandler>(located)
    const events = registry()
    events.register(viewDefinition('chat-located', chat))
    events.registerFallback(viewDefinition('fallback', fallbackMatch))
    new ConversationNodeAssembler(events, { entries: () => [] }).replaceWindow([dispatchStart], true)
    expect(chat).toHaveBeenCalledOnce()
    expect(fallbackMatch).not.toHaveBeenCalled()
  })

  it('resolve a fallback match by Turn and drop it while unresolved', () => {
    const start = vi.fn(() => null)
    const events = registry()
    events.registerFallback({ ...viewDefinition('fallback', event => located(event) && { located: 'turn', role: 'start' }), start })
    new ConversationNodeAssembler(events, { entries: () => [] }).replaceWindow([dispatchStart], true)
    expect(start).not.toHaveBeenCalled()
    new ConversationNodeAssembler(events, { entries: () => [] }).replaceWindow([turnStart, call, dispatchStart], false)
    expect(start).toHaveBeenCalledOnce()
  })
})
