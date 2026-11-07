/**
 * Fable sweep (seams-loop): accepted input that the inbox durably claimed must
 * reach the model or return to the queue. Each case fails the step between the
 * durable claim splice and the `user/message` commit and checks what survives.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
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
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const userText = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(userText(text))
  await agent.whenIdle()
}

function userTexts(
  messages: readonly { role: string; content: readonly { type: string; text?: string }[]; source?: { kind: string } }[],
): string[] {
  return messages.filter(message => message.role === 'user' && message.source?.kind === 'user')
    .flatMap(message => message.content.map(block => block.type === 'text' ? block.text ?? '' : ''))
}

/** Where the step fails after the inbox claim and before the accepted message commits. */
type FailurePoint = 'agent/pre-step listener' | 'tool admission' | 'request-context provider'

function installFailure(ctx: Context, point: FailurePoint, armed: { current: boolean }): void {
  switch (point) {
    case 'agent/pre-step listener':
      ctx.on('agent/pre-step', (_payload, next) => {
        if (armed.current) throw new Error('transient pre-step failure')
        return next()
      })
      break
    case 'tool admission':
      ctx.tools.registerAdmissionPolicy(({ candidates }) => {
        if (armed.current) throw new Error('transient admission failure')
        return candidates.keys()
      })
      break
    case 'request-context provider':
      ctx.on('system-prompt/request-context', (_context, _pending, next) => {
        if (armed.current) throw new Error('transient request-context failure')
        return next()
      })
      break
  }
}

describe('claimed input survives a failed step preparation', () => {
  it.each<FailurePoint>(['agent/pre-step listener', 'tool admission', 'request-context provider'])(
    'keeps the accepted message when %s fails before the user/message commit',
    async (point) => {
      const adapter = new MockAdapter([textResponse('reply')])
      const ctx = await mount(adapter)
      try {
        const armed = { current: true }
        installFailure(ctx, point, armed)
        const agent = await ctx.agentLoop.create(SessionId(`fable-claimed-${point.replaceAll(/\W+/g, '-')}`), { provider: 'mock', model: 'model' })
        await send(agent, 'hello')
        const events = agent.session.snapshotEvents()
        const turnEnd = events.findLast(event => event.type === 'turn/end')?.data.reason
        expect(turnEnd?.kind).toBe('error')
        expect(adapter.requests).toHaveLength(0)

        // The failed turn committed nothing model-visible; the claim splice durably removed the message.
        const committed = events.some(event => event.type === 'user/message' && event.data.source.kind === 'user')
        const queued = agent.inbox.nextTurn.some(message => message.content.some(block => block.type === 'text' && block.text === 'hello'))
        expect({ committed, queued }, 'an accepted message must be committed or stay queued after a transient failure')
          .not.toEqual({ committed: false, queued: false })

        // After the transient failure clears, the next turn's request must carry the accepted message.
        armed.current = false
        await send(agent, 'second')
        expect(userTexts(adapter.requests[0]?.messages ?? [])).toEqual(['hello', 'second'])
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('restores a claimed message after a crash between the claim and the user/message commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fable-claimed-crash-'))
    dirs.push(root)
    // Capture the exact durable prefix the live loop writes up to the claim.
    const armed = { current: true }
    const live = await mount(new MockAdapter([]), root)
    installFailure(live, 'agent/pre-step listener', armed)
    const agent = await live.agentLoop.create(SessionId('fable-claimed-live'), { provider: 'mock', model: 'model' })
    await send(agent, 'hello')
    const events = agent.session.snapshotEvents()
    const claimIndex = events.findIndex(event => event.type === 'agent/inbox/spliced' && event.data.removedCount === 1 && event.data.outcome === undefined)
    expect(claimIndex).toBeGreaterThan(0)
    const crashPrefix: SessionEvent[] = events.slice(0, claimIndex + 1).map(event => structuredClone(event))
    expect(crashPrefix.map(event => event.type)).toEqual(['agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced'])
    await live.fiber.dispose()

    // A process loss right after the claim leaves exactly that prefix on disk.
    const crashed = SessionId('fable-claimed-crashed')
    const seedCtx = await mount(new MockAdapter([]), root)
    const detached = seedCtx.sessions.prepare(crashed)
    const handle = await seedCtx.sessionPersistence.create(detached.header)
    await handle.append(crashPrefix)
    await handle.close()
    await seedCtx.fiber.dispose()

    const adapter = new MockAdapter([textResponse('reply')])
    const resumed = await mount(adapter, root)
    try {
      const resumedHandle = await resumed.agents.resume({ resumeSessionId: crashed, agentOptions: { provider: 'mock', model: 'model' } })
      const resumedAgent = resumedHandle.agent
      const history = resumedAgent.session.snapshotEvents()
      expect(history.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('interrupted')
      const committed = history.some(event => event.type === 'user/message' && event.data.source.kind === 'user')
      const queued = resumedAgent.inbox.nextTurn.some(message => message.content.some(block => block.type === 'text' && block.text === 'hello'))
      expect({ committed, queued }, 'a claimed message must survive a crash before its commit')
        .not.toEqual({ committed: false, queued: false })
      await send(resumedAgent, 'second')
      expect(userTexts(adapter.requests[0]?.messages ?? [])).toEqual(['hello', 'second'])
    } finally {
      await resumed.fiber.dispose()
    }
  })
})
