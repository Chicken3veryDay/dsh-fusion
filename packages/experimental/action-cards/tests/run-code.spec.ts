/** A card skill loaded and a card proposed from `run_code` programs, through the real loop and Node PTC runtime. */
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import Skills from '@deepseek-ai/dsh-skill'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ActionCards from '../src/index.ts'
import { ACTION, INVITATION, proposal, provideSkills, SKILL } from './fixture.ts'

it('turns a propose_action call made from run_code into a card after a skill load made from run_code', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'ptc' } })
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(NodeRuntime)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Skills)
  await ctx.plugin(SkillTool)
  provideSkills(ctx, SKILL)
  await ctx.plugin(ActionCards)
  await ctx.plugin({ name: 'test-kind', inject: ['actionCards'], apply: (inner: Context) => {
    inner.actionCards.register({
      action: ACTION, skill: SKILL, invitation: INVITATION, details: z.object({ value: z.string() }), verbs: {},
      act: (_agent, card) => Promise.resolve({ status: 'settled', decision: { callId: card.callId, action: ACTION, phase: 'done' } }),
    })
  } })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([
    toolCallResponse('load', 'run_code', { code: `await tools.skill({ name: '${SKILL}' })`, description: 'Load the card skill' }),
    toolCallResponse('card', 'run_code', { code: `return await tools.propose_action(${JSON.stringify(proposal)})`, description: 'Offer a card' }),
    textResponse('The card is below.'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('cards-in-program'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'I want a counter.' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const events = agent.session.snapshotEvents()
  const card = events.find(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'propose_action')
  if (card?.type !== 'tool/ptc-dispatch') throw new Error('expected the nested propose_action settlement')
  expect(card.data.isError).toBe(false)
  expect(JSON.stringify(card.data.content)).toContain(INVITATION)
  const callId = card.data.subCallId
  expect(ctx.actionCards.view(agent.session).proposals).toEqual({ [callId]: { callId, turn: 1, ...proposal } })
})
