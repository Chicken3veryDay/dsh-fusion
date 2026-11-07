/** Final request admission must survive asynchronous prompt assembly. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
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
  const agent = await ctx.agentLoop.create(SessionId('review-r8-admission-race'), { provider: 'mock', model: 'model' })
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

it('does not declare a registration withdrawn while request-time assembly is suspended', async () => {
  const adapter = new MockAdapter([textResponse('done')])
  const h = await harness(adapter)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let withdraw: (() => void) | undefined
  let assemblies = 0
  h.ctx.on('agent/request', (_event, next) => {
    withdraw = h.register('late')
    return next()
  })
  h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    assemblies++
    const result = await next()
    if (assemblies === 2) { entered.resolve(undefined); await release.promise }
    return result
  })
  const running = send(h.agent)
  try {
    await entered.promise
    withdraw?.()
  } finally { release.resolve(undefined) }
  await running
  expect(assemblies).toBe(2)
  expect(h.ctx.tools.get('late', h.agent)).toBeUndefined()
  expect(adapter.requests.flatMap(request => request.tools?.map(tool => tool.name) ?? []),
    'withdrawn registration must never reach a model declaration').not.toContain('late')
})

it('does not execute a tool revoked by history committed during request-time assembly', async () => {
  const adapter = new MockAdapter([toolCallResponse('revoked-call', 'probe', {}), textResponse('done')])
  const h = await harness(adapter)
  const revoke = 'probe revoked'
  h.ctx.tools.registerAdmissionPolicy(({ agent, candidates }) =>
    agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === revoke))
      ? [...candidates.keys()].filter(name => name !== 'probe') : candidates.keys())
  let first = true
  h.ctx.on('agent/request', (_event, next) => {
    if (first) { first = false; h.register('late') }
    return next()
  })
  let assemblies = 0
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    if (++assemblies === 2) { entered.resolve(undefined); await release.promise }
    return result
  })
  h.ctx.on('llm/stream', (request, next) => {
    expect(request.messages).toEqual(Session.create(h.agent.id, h.agent.session.snapshotEvents()).deriveMessages())
    return next()
  })
  const running = send(h.agent)
  try {
    await entered.promise
    h.agent.session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: revoke }],
    }), { surfaceOp: 'append' })
  } finally { release.resolve(undefined) }
  await running
  expect(h.agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === revoke))).toBe(true)
  if (adapter.requests[0] !== undefined) expect(adapter.requests[0].messages.some(message => message.content.some(block => block.type === 'text' && block.text === revoke))).toBe(true)
  expect({ declared: adapter.requests.some(request => request.tools?.some(tool => tool.name === 'probe')), calls: h.calls })
    .toEqual({ declared: false, calls: [] })
})


it('control: unchanged live registrations survive request-time reassembly', async () => {
  const adapter = new MockAdapter([toolCallResponse('allowed', 'late', {}), textResponse('done')])
  const h = await harness(adapter)
  let first = true
  h.ctx.on('agent/request', (_event, next) => {
    if (first) { first = false; h.register('late') }
    return next()
  })
  await send(h.agent)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['late', 'probe'])
  expect(h.calls).toEqual(['late'])
})

it('control: reconciliation that changes history triggers withdrawal validation', async () => {
  const adapter = new MockAdapter([textResponse('done')])
  const h = await harness(adapter)
  let withdraw: (() => void) | undefined
  let assemblies = 0
  let fact = 'initial'
  h.ctx.systemPrompt.context({ name: 'fact', order: 0, text: () => fact })
  h.ctx.on('agent/request', (_event, next) => {
    withdraw = h.register('late')
    return next()
  })
  h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    if (++assemblies === 2) { withdraw?.(); fact = 'changed'; return { ...result, contexts: [{ name: 'fact', text: fact }] } }
    return result
  })
  await send(h.agent)
  expect(adapter.requests).toHaveLength(0)
  expect(h.agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TOOL_ADMISSION_FAILED' } } },
  })
})

it('does not carry a withdrawn declaration into a same-step retry with an unchanged header', async () => {
  const adapter = new MockAdapter([
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSIENT', message: 'retry' } } }],
    textResponse('done'),
  ])
  const h = await harness(adapter)
  const withdraw = h.register('retry_tool')
  let fact = 'before retry'
  h.ctx.systemPrompt.context({ name: 'retry-fact', order: 0, text: () => fact })
  h.ctx.on('agent/request-error', async () => { fact = 'after retry'; return { kind: 'retry' } })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let assemblies = 0
  h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    if (++assemblies === 2) { entered.resolve(undefined); await release.promise }
    return result
  })
  const running = send(h.agent)
  try {
    await entered.promise
    withdraw()
  } finally { release.resolve(undefined) }
  await running
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('retry_tool')
  expect(adapter.requests.slice(1).flatMap(request => request.tools?.map(tool => tool.name) ?? []),
    'retry must not declare the withdrawn registration').not.toContain('retry_tool')
})
