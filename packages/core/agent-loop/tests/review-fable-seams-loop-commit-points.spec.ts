/**
 * Fable sweep (seams-loop): cancellation landing on the commit points of one
 * attempt, steering that arrives from a settlement observer, and the durable
 * queue of a resumed Session.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function mount(adapter: MockAdapter, root?: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  if (root !== undefined) await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  adapter.systemPromptUpdate = 'in-history'
  adapter.toolUpdate = 'in-history'
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineTool({
    name: 'probe', description: 'Test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'done',
  }))
  let tick = 0
  ctx.systemPrompt.context({ name: 'tick', order: 0, text: () => `tick ${++tick}` })
  return ctx
}

const userText = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(userText(text))
  await agent.whenIdle()
}

function texts(messages: readonly { role: string; content: readonly { type: string; text?: string }[]; source?: { kind: string } }[], kind = 'user'): string[] {
  return messages.filter(message => message.role === 'user' && message.source?.kind === kind)
    .flatMap(message => message.content.map(block => block.type === 'text' ? block.text ?? '' : ''))
}

describe('cancellation on the attempt commit points', () => {
  it.each(['user/message', 'system/message', 'request/header', 'request/context'] as const)(
    'cancel observed on the %s commit closes the step and the next turn replays exactly the committed history',
    async (commitType) => {
      const adapter = new MockAdapter([textResponse('reply')])
      const ctx = await mount(adapter)
      try {
        const agent = await ctx.agentLoop.create(SessionId(`fable-cancel-${commitType.replace('/', '-')}`), { provider: 'mock', model: 'model' })
        let armed = true
        ctx.on('session/event', (session, event) => {
          if (session !== agent.session || !armed || event.type !== commitType) return
          armed = false
          agent.cancel({ kind: 'user' })
        })
        await send(agent, 'first')
        const events = agent.session.snapshotEvents()
        expect(events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
        expect(adapter.requests).toHaveLength(0)
        const stepStarts = events.filter(event => event.type === 'step/start').length
        const stepEnds = events.filter(event => event.type === 'step/end').length
        expect({ stepStarts, stepEnds }).toEqual({ stepStarts: 1, stepEnds: 1 })

        await send(agent, 'second')
        const request = adapter.requests[0]
        expect(request).toBeDefined()
        // The committed first message is sent exactly once, in order, before the second.
        expect(texts(request?.messages ?? [])).toEqual(['first', 'second'])
        expect(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages().slice(0, request?.messages.length))
          .toEqual(request?.messages)
        expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )
})

describe('steering from a settlement observer', () => {
  // A synchronous `session/event` observer cannot splice the inbox: Session refuses reentrant appends
  // with a thrown error, so the steer is scheduled after the settlement append returns.
  it('claims a steer sent right after the assistant message commits before the turn closes', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await mount(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('fable-steer-settlement'), { provider: 'mock', model: 'model' })
      let armed = true
      ctx.on('session/event', (session, event) => {
        if (session !== agent.session || !armed || event.type !== 'assistant/message') return
        armed = false
        queueMicrotask(() => { agent.steer(userText('steer')) })
      })
      await send(agent, 'first')
      const events = agent.session.snapshotEvents()
      expect(events.filter(event => event.type === 'step/start')).toHaveLength(2)
      expect(adapter.requests).toHaveLength(2)
      expect(texts(adapter.requests[1]?.messages ?? [])).toEqual(['first', 'steer'])
      expect(agent.inbox.nextStep).toHaveLength(0)
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('durable queue after resume', () => {
  it('drives input that was queued durably before the process stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fable-resume-queue-'))
    dirs.push(root)
    const id = SessionId('fable-resume-queue')
    const seedCtx = await mount(new MockAdapter([]), root)
    const detached = seedCtx.sessions.prepare(id)
    const handle = await seedCtx.sessionPersistence.create(detached.header)
    const queued: SessionEvent[] = [{
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-turn', start: 0, inserted: [userText('queued before restart')] },
    }]
    await handle.append(queued)
    await handle.close()
    await seedCtx.fiber.dispose()

    const adapter = new MockAdapter([textResponse('reply')])
    const ctx = await mount(adapter, root)
    try {
      const resumed = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'model' } })
      expect(resumed.agent.inbox.nextTurn.map(message => message.content[0]?.type === 'text' ? message.content[0].text : '')).toEqual(['queued before restart'])
      await resumed.agent.whenIdle()
      expect(adapter.requests, 'queued input survives restart but nothing drives it').toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
