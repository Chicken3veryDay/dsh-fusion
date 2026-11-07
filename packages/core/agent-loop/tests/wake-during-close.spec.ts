/** A wake refused by a closing initiator scope leaves the Agent idle with its input queued, and root unload completes. */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

function message(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>(resolve => setTimeout(() => { resolve('pending') }, ms)),
  ])
}

async function mount(): Promise<{ ctx: Context; agent: Agent; statuses: string[] }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('unexpected')]))
  const handle = await ctx.agents.create({ sessionId: SessionId('wake-during-close'), agentOptions: { provider: 'mock', model: 'mock' } })
  const statuses: string[] = []
  ctx.on('agent/status', ({ agent, status }) => { if (agent === handle.agent) statuses.push(status) })
  return { ctx, agent: handle.agent, statuses }
}

describe('wake while the initiator scope closes', () => {
  it('refuses a follow-up during root unload without a running phase, keeps it queued, and completes unload', async () => {
    const { ctx, agent, statuses } = await mount()
    const late = message('late wake')
    const observed: { status?: string; inbox?: unknown; idle?: string } = {}
    ctx.effect(() => async () => {
      agent.followup(late)
      observed.status = agent.status
      observed.inbox = ctx.sessionProjections.snapshot(agent.session).values.inbox
      observed.idle = await settlesWithin(agent.whenIdle(), 500)
    }, 'test.lateWake()')

    expect(await settlesWithin(ctx.fiber.dispose(), 3000)).toBe('settled')
    expect(observed).toEqual({ status: 'idle', inbox: { 'next-step': [], 'next-turn': [late] }, idle: 'settled' })
    expect(statuses).toEqual([])
  })
})
