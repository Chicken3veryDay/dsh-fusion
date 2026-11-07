/** Admission checks must cover the complete interval through request freezing. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('review-r9-freeze-gap'), { provider: 'mock', model: 'model' })
  const calls: string[] = []
  const register = (name: string) => ctx.tools.register(defineTool({
    name, description: 'Test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push(name); return 'done' },
  }))
  register('probe')
  return { ctx, agent, calls, register }
}

async function send(agent: Agent) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }] }))
  await agent.whenIdle()
}

it('does not declare a tool withdrawn after final validation returns but before request freezing', async () => {
  const adapter = new MockAdapter([textResponse('done')])
  const h = await harness(adapter)
  const withdraw = h.register('late')
  const reached = Promise.withResolvers<undefined>()
  h.ctx.on('session/event', (session, event) => {
    if (session === h.agent.session && event.type === 'request/context') reached.resolve(undefined)
  })
  const externalWithdrawal = reached.promise.then(() => { withdraw() })
  await send(h.agent)
  await externalWithdrawal
  expect(h.ctx.tools.get('late', h.agent)).toBeUndefined()
  expect(adapter.requests.flatMap(request => request.tools?.map(tool => tool.name) ?? []),
    'a withdrawn registration must not reach the adapter').not.toContain('late')
})

it('does not execute a tool revoked by history appended between final validation and freezing', async () => {
  const adapter = new MockAdapter([toolCallResponse('revoked', 'probe', {}), textResponse('done')])
  const h = await harness(adapter)
  const revoke = 'probe revoked'
  h.ctx.tools.registerAdmissionPolicy(({ agent, candidates }) =>
    agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === revoke))
      ? [...candidates.keys()].filter(name => name !== 'probe') : candidates.keys())
  const reached = Promise.withResolvers<undefined>()
  h.ctx.on('session/event', (session, event) => {
    if (session === h.agent.session && event.type === 'request/context') reached.resolve(undefined)
  })
  const externalAppend = reached.promise.then(() => {
    h.agent.session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: revoke }],
    }), { surfaceOp: 'append' })
  })
  await send(h.agent)
  await externalAppend
  expect(adapter.requests[0]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text === revoke))).toBe(true)
  expect(h.calls, 'history-revoked tool body must not execute').toEqual([])
})

it('control: unchanged registrations and history dispatch and execute normally', async () => {
  const adapter = new MockAdapter([toolCallResponse('allowed', 'probe', {}), textResponse('done')])
  const h = await harness(adapter)
  await send(h.agent)
  expect(h.calls).toEqual(['probe'])
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['probe'])
})
