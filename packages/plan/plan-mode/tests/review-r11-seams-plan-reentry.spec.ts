/** Late accepted plan selections must update guidance even after the exit tool was disclosed. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const SECTION = 'Plan carefully before implementing.'

it.each([false, true])('includes accepted late-entry guidance after previouslyEntered=%s', async (previouslyEntered) => {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(Tools)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(PlanModeController, { section: SECTION })
    const adapter = new MockAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`review-r11-plan-reentry-${previouslyEntered}`), {
      provider: 'mock', model: 'model',
    })
    if (previouslyEntered) {
      expect(ctx.planMode.set(agent, true)).toBe('committed')
      expect(ctx.planMode.set(agent, false)).toBe('committed')
    }
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      const decision = await next()
      if (subject === agent) expect(ctx.planMode.set(agent, true)).toBe('queued')
      return decision
    })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'plan the task' }] }))
    await agent.whenIdle()

    expect(ctx.planMode.get(agent)).toEqual({ active: true })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'plan/mode').at(-1)?.data).toEqual({ active: true })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('exit_plan_mode')
    const system = adapter.requests[0]?.messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      .join('\n')
    expect(system, 'accepted plan mode must carry its guidance').toContain(SECTION)
  } finally {
    await ctx.fiber.dispose()
  }
})
