/**
 * Claimed input delivery: a batch the inbox claimed reaches the log exactly
 * once, live after a failed step and on resume after a process loss, and the
 * reserved prompt head keeps the rendered system prompt at surface node 0.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const PROMPT = 'You are a test agent.'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claimed-delivery-'))
  dirs.push(root)
  return root
}

async function mount(adapter: MockAdapter, root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: PROMPT, personaSuffix: '' })
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const userText = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const options = { provider: 'mock', model: 'model' }

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(userText(text))
  await agent.whenIdle()
}

function userTexts(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? []).filter(message => message.role === 'user' && message.source?.kind === 'user')
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

function systemHead(request: GenerateOptions | undefined): string | undefined {
  const head = request?.messages[0]
  return head?.role === 'system' ? head.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : undefined
}

function committedUserCount(events: readonly SessionEvent[], text: string): number {
  return events.filter(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === text)).length
}

/** Seed a new stored Session with `events`, as a process lost after writing them leaves it. */
async function seedCrash(root: string, id: SessionId, events: readonly SessionEvent[]): Promise<void> {
  const seedCtx = await mount(new MockAdapter([]), root)
  const handle = await seedCtx.sessionPersistence.create(seedCtx.sessions.prepare(id).header)
  await handle.append(events.map(event => structuredClone(event)))
  await handle.close()
  await seedCtx.fiber.dispose()
}

describe('claimed input delivery', () => {
  it('keeps the prompt at the surface head after a failed first turn and across a resume', async () => {
    const root = await tempRoot()
    const id = SessionId('claimed-first-turn')
    const live = await mount(new MockAdapter([]), root)
    let armed = true
    live.on('agent/pre-step', (_payload, next) => {
      if (armed) throw new Error('transient pre-step failure')
      return next()
    })
    const agent = await live.agentLoop.create(id, options)
    await send(agent, 'hello')
    armed = false
    expect(agent.session.snapshotEvents().filter(event => event.type !== 'agent/inbox/spliced').map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message', 'step/end', 'turn/end',
    ])
    await live.fiber.dispose()

    // The stored log passes the format reader and the reserved head takes the rendered prompt in place.
    const adapter = new MockAdapter([textResponse('reply')])
    const resumed = await mount(adapter, root)
    try {
      const { agent: again } = await resumed.agents.resume({ resumeSessionId: id, agentOptions: options })
      await send(again, 'second')
      expect(systemHead(adapter.requests[0])).toContain(PROMPT)
      expect(adapter.requests[0]?.messages.filter(message => message.role === 'system')).toHaveLength(1)
      expect(userTexts(adapter.requests[0])).toEqual(['hello', 'second'])
    } finally {
      await resumed.fiber.dispose()
    }
  })

  it('commits a batch once when the step fails after its user/message commit', async () => {
    const adapter = new MockAdapter([() => { throw new Error('upstream unavailable') }, textResponse('reply')])
    const ctx = await mount(adapter, await tempRoot())
    try {
      const agent = await ctx.agentLoop.create(SessionId('claimed-after-commit'), options)
      await send(agent, 'hello')
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
      expect(committedUserCount(agent.session.snapshotEvents(), 'hello')).toBe(1)
      await send(agent, 'second')
      expect(userTexts(adapter.requests.at(-1))).toEqual(['hello', 'second'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('commits a claim inside the step that was open when the process stopped', async () => {
    const root = await tempRoot()
    // A completed first turn gives the Session its prompt; the second turn crashes after step/start.
    const live = await mount(new MockAdapter([textResponse('first reply')]), root)
    const agent = await live.agentLoop.create(SessionId('claimed-open-step-live'), options)
    await send(agent, 'first')
    let crashAt = -1
    live.on('agent/request', () => {
      crashAt = agent.session.snapshotEvents().length
      throw new Error('process stops here')
    })
    await send(agent, 'hello')
    const prefix = agent.session.snapshotEvents().slice(0, crashAt)
    expect(prefix.slice(-3).map(event => event.type)).toEqual(['turn/start', 'agent/inbox/spliced', 'step/start'])
    await live.fiber.dispose()

    const id = SessionId('claimed-open-step')
    await seedCrash(root, id, prefix)
    const adapter = new MockAdapter([textResponse('reply')])
    const resumed = await mount(adapter, root)
    try {
      const { agent: again } = await resumed.agents.resume({ resumeSessionId: id, agentOptions: options })
      const repaired = again.session.snapshotEvents().slice(prefix.length)
      expect(repaired.slice(0, 3).map(event => event.type)).toEqual(['user/message', 'step/end', 'turn/end'])
      expect(again.inbox.nextTurn).toEqual([])
      await send(again, 'second')
      expect(userTexts(adapter.requests[0])).toEqual(['first', 'hello', 'second'])
      expect(committedUserCount(again.session.snapshotEvents(), 'hello')).toBe(1)
    } finally {
      await resumed.fiber.dispose()
    }
  })

  it('does not wake a resumed Session for queued next-step input alone', async () => {
    const root = await tempRoot()
    await seedCrash(root, SessionId('claimed-inject-resume'), [{
      type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
      data: { target: 'next-step', start: 0, inserted: [userText('background note')] },
    }])

    const adapter = new MockAdapter([textResponse('reply')])
    const resumed = await mount(adapter, root)
    try {
      const { agent: again } = await resumed.agents.resume({ resumeSessionId: SessionId('claimed-inject-resume'), agentOptions: options })
      await again.whenIdle()
      await new Promise((resolve) => { setImmediate(resolve) })
      expect(adapter.requests).toHaveLength(0)
      expect(again.inbox.nextStep.map(message => message.content)).toEqual([[{ type: 'text', text: 'background note' }]])
    } finally {
      await resumed.fiber.dispose()
    }
  })
})
