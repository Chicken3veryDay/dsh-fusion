/** Tool timing survives a checkpoint cut between dispatch and settlement for every call id. */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionStatsPlugin from '@deepseek-ai/dsh-session-stats'
import { sessionStatsProjectionDefinition } from '../src/projection.ts'
import { expect, it } from 'vitest'

it.each(['__proto__', 'constructor', 'toString'])('retains pending tool timing for %s through checkpoint restore', async (id) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionStatsPlugin)
    const session = ctx.sessions.create(SessionId('pending-calls-restore'))
    const callId = ToolCallId(id)
    const events: SessionEvent[] = [
      { type: 'tool/call', seq: SessionSeq(0), time: 100, data: { turn: 1, step: 1, callId, name: 'read', arguments: '{}' } },
      { type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(1), time: 600, data: {
        turn: 1, step: 1,
        message: createMessage({ role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [] }),
      } },
    ]
    const registry = ctx.sessionProjections
    const prefix = registry.restore({}, events.slice(0, 1), SessionLogOffset(0), session.header, session.inheritedEventCount)
    const checkpoint = JSON.parse(JSON.stringify(prefix.checkpoint)) as typeof prefix.checkpoint
    const restored = registry.restore(checkpoint, events.slice(1), SessionLogOffset(1), session.header, session.inheritedEventCount)
    const replayed = registry.restore({}, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(restored.snapshot.values.sessionStats).toMatchObject({ toolMs: 500 })
    expect(restored).toEqual(replayed)
    const old = { sessionStats: {
      ...checkpoint.sessionStats!, ver: 1,
      val: { ...sessionStatsProjectionDefinition.init(), pendingCalls: { [id]: 100 } },
    } }
    expect(registry.restore(old, events, SessionLogOffset(0), session.header, session.inheritedEventCount)).toEqual(replayed)
    expect(() => registry.restore(old, events.slice(1), SessionLogOffset(1), session.header, session.inheritedEventCount))
      .toThrow(/re-read from seq 0/)
  } finally {
    await ctx.fiber.dispose()
  }
})
