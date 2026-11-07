/** A pending plan selection is appended only by an accepted pre-step, even when an outer listener rejects afterwards. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const SECTION = 'Plan carefully before implementing.'
const NOTICE = 'The user switched this session to plan mode.'

function texts(messages: readonly RequestMessage[], role: RequestMessage['role']): string {
  return messages.filter(message => message.role === role)
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('\n')
}

it.each([
  { outerRejects: false },
  { outerRejects: true },
])('a selection queued in a step whose outer pre-step listener rejects=$outerRejects', async ({ outerRejects }) => {
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
    // Registered before plan mode, so it wraps plan mode's listener, as goal-round-driver
    // (synchronous apply, listed earlier in the base bundle) does when its post-decision check fails.
    let rejectNext = false
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (!rejectNext) return decision
      rejectNext = false
      return { kind: 'reject' }
    })
    await ctx.plugin(PlanModeController, { section: SECTION })
    const adapter = new MockAdapter([textResponse('first'), textResponse('second'), textResponse('third')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`review-r13-plan-outer-reject-${outerRejects}`), {
      provider: 'mock', model: 'model',
    })
    const prompt = (text: string): void => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    }

    // Turn 1 logs a request header in default mode, so a later switch is narrated.
    prompt('first')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)

    // Turn 2: the user selects plan mode while the turn is open, before plan mode's listener reads it.
    let selecting = true
    const stopSelect = ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === agent && selecting) {
        selecting = false
        expect(ctx.planMode.set(agent, true)).toBe('queued')
      }
      return next()
    }, { prepend: true })
    rejectNext = outerRejects
    prompt('second')
    await agent.whenIdle()
    stopSelect()
    const modes = agent.session.snapshotEvents().filter(event => event.type === 'plan/mode').map(event => event.data)
    const afterTurn2 = { modes, state: ctx.planMode.get(agent) }

    if (!outerRejects) {
      // Control: the accepted step appends the selection and narrates it in the same request.
      expect(afterTurn2).toEqual({ modes: [{ active: true }], state: { active: true } })
      expect(adapter.requests).toHaveLength(2)
      expect(texts(adapter.requests[1]?.messages ?? [], 'system')).toContain(SECTION)
      expect(texts(adapter.requests[1]?.messages ?? [], 'user')).toContain(NOTICE)
      return
    }

    expect(adapter.requests, 'the rejected step makes no request').toHaveLength(1)
    // Turn 3 is accepted: it carries the guidance, and should carry the user-switch notice.
    prompt('third')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const third = adapter.requests[1]?.messages ?? []
    expect(texts(third, 'system')).toContain(SECTION)

    // Documented: the service "appends `plan/mode` from `agent/pre-step` only when the step is accepted".
    expect.soft(afterTurn2, 'a rejected step must not append the selection').toEqual({
      modes: [], state: { active: false, pending: true },
    })
    expect.soft(texts(third, 'user'), 'the first accepted step in plan mode must narrate the user switch').toContain(NOTICE)
  } finally {
    await ctx.fiber.dispose()
  }
})
