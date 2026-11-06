/** Admission order reaches the model request unchanged, and declarations and dispatch share one post-pre-step selection. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool, orderedAdmission } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function harness(adapter: MockAdapter, systemPrompt: Record<string, unknown> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '', ...systemPrompt })
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('tool-declaration-order'), { provider: 'mock', model: 'model' })
  const calls: string[] = []
  const register = (name: string) => ctx.tools.register(defineTool({
    name, description: `Operation ${name}.`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push(name); return 'done' },
  }))
  return { ctx, agent, register, calls }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

const declared = (adapter: MockAdapter) => adapter.requests.map(request => request.tools?.map(tool => tool.name))

it('keeps the admission sequence as an append-only declaration prefix in real model requests', async () => {
  const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
  const h = await harness(adapter)
  h.register('zulu')
  h.register('alpha')
  let active = ['zulu']
  h.ctx.tools.registerAdmissionPolicy(() => orderedAdmission(active))
  await send(h.agent, 'first')
  active = ['zulu', 'alpha']
  await send(h.agent, 'second')
  expect(declared(adapter)).toEqual([['zulu'], ['zulu', 'alpha']])
})

it('declares base tools, then curator-managed tools, then activations in activation order', async () => {
  const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
  const h = await harness(adapter)
  for (const name of ['read', 'edit', 'context_load', 'zeta_managed', 'alpha_managed', 'mid_activated', 'early_activated']) h.register(name)
  const base = ['read', 'edit', 'context_load']
  const managed = ['zeta_managed', 'alpha_managed']
  let activations: string[] = []
  h.ctx.tools.registerAdmissionPolicy(() => orderedAdmission([...base, ...managed, ...activations]))
  await send(h.agent, 'one')
  activations = ['mid_activated']
  await send(h.agent, 'two')
  activations = ['mid_activated', 'early_activated']
  await send(h.agent, 'three')
  expect(declared(adapter)).toEqual([
    [...base, ...managed],
    [...base, ...managed, 'mid_activated'],
    [...base, ...managed, 'mid_activated', 'early_activated'],
  ])
})

it('keeps canonical name order for a policy that does not order and for no policy at all', async () => {
  const adapter = new MockAdapter([textResponse('plain'), textResponse('none')])
  const h = await harness(adapter)
  h.register('zulu')
  h.register('alpha')
  h.register('mike')
  const dispose = h.ctx.tools.registerAdmissionPolicy(() => ['zulu', 'mike', 'alpha'])
  await send(h.agent, 'plain')
  dispose()
  await send(h.agent, 'none')
  expect(declared(adapter)).toEqual([['alpha', 'mike', 'zulu'], ['alpha', 'mike', 'zulu']])
})

it('lets a configured toolOrder place listed tools while a policy sequences the unlisted rest', async () => {
  const adapter = new MockAdapter([textResponse('configured')])
  const h = await harness(adapter, { toolOrder: ['mike', '<unlisted-tools>'] })
  for (const name of ['zulu', 'alpha', 'mike', 'bravo']) h.register(name)
  h.ctx.tools.registerAdmissionPolicy(() => orderedAdmission(['zulu', 'bravo', 'mike', 'alpha']))
  await send(h.agent, 'configured')
  expect(declared(adapter)).toEqual([['mike', 'zulu', 'bravo', 'alpha']])
})

it('refuses a tool that a pre-step listener revokes, in the declarations and at dispatch of the same step', async () => {
  const adapter = new MockAdapter([toolCallResponse('call-1', 'probe', {}), textResponse('done')])
  const h = await harness(adapter)
  h.register('probe')
  h.register('stay')
  let revoked = false
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => [...candidates.keys()].filter(name => !(revoked && name === 'probe')))
  h.ctx.on('agent/pre-step', (_event, next) => {
    revoked = true
    return next()
  })
  await send(h.agent, 'try the revoked tool')
  expect(declared(adapter)[0]).toEqual(['stay'])
  expect(h.calls).toEqual([])
})
