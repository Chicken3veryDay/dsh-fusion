/** An admission restart judges the request series against the state before the abandoned attempt. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const LATE = 'late message'
const REVOKE = 'revoke fetch'

async function harness(script: ConstructorParameters<typeof MockAdapter>[0], toolUpdate?: 'in-history') {
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
  const adapter = new MockAdapter(script)
  adapter.systemPromptUpdate = 'in-history'
  if (toolUpdate !== undefined) adapter.toolUpdate = toolUpdate
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('admission-restart-carry'), { provider: 'mock', model: 'model' })
  const register = (name: string) => ctx.tools.register(defineTool({
    name, description: 'Test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve('done'),
  }))
  return { ctx, adapter, agent, register }
}

async function send(agent: Agent) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }] }))
  await agent.whenIdle()
}

/** Append `text` during the attempt's final await, after the next `request/context` commit. */
function appendAfterContext(h: Awaited<ReturnType<typeof harness>>, text: string): Promise<void> {
  const reached = Promise.withResolvers<undefined>()
  h.ctx.on('session/event', (session, event) => {
    if (session === h.agent.session && event.type === 'request/context') reached.resolve(undefined)
  })
  return reached.promise.then(() => {
    h.agent.session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text }],
    }), { surfaceOp: 'append' })
  })
}

it('treats the restarted attempt\'s nodes as sent when a transient failure retries the step', async () => {
  const h = await harness([textResponse('first'), () => { throw new LlmError('busy', 'RATE_LIMIT') }, textResponse('done')], 'in-history')
  h.register('probe')
  await send(h.agent)
  h.register('fetch')
  h.ctx.on('agent/request-error', () => {
    h.register('extra')
    return Promise.resolve({ kind: 'retry' as const })
  })
  const appended = appendAfterContext(h, LATE)
  h.agent.model.select({ provider: 'mock', model: 'model-2' })
  await send(h.agent)
  await appended
  expect(h.adapter.requests).toHaveLength(3)
  const events = h.agent.session.snapshotEvents()
  const notices = events.filter(event => event.type === 'developer/message')
  // The notice the failed request carried stays; the retry appends its own change instead of rewriting it.
  expect(notices.map(event => event.data.message.content)).toEqual([
    [{ type: 'tool-addition', toolName: 'fetch' }], [{ type: 'tool-addition', toolName: 'extra' }],
  ])
  expect(notices.map(event => event.surfaceOp)).toEqual(['append', 'append'])
})

it('declares the restarted tools on a route without tool updates, judging them against the carried header', async () => {
  const h = await harness([textResponse('first'), textResponse('second')])
  h.register('probe')
  await send(h.agent)
  h.register('fetch')
  const appended = appendAfterContext(h, LATE)
  h.agent.model.select({ provider: 'mock', model: 'model-2' })
  await send(h.agent)
  await appended
  // The restart reads the header the model last saw for the series decision, not the abandoned header; the
  // route has no tool updates, so the request declares the full set and carries no tool notice.
  expect(h.adapter.requests).toHaveLength(2)
  expect(h.adapter.requests[1]?.tools?.map(tool => tool.name).toSorted()).toEqual(['fetch', 'probe'])
  expect(h.adapter.requests[1]?.messages.some(message => message.role === 'developer')).toBe(false)
})

it('replaces an abandoned tool notice with the change from the header the model last saw', async () => {
  const h = await harness([textResponse('first'), textResponse('second')], 'in-history')
  h.register('probe')
  await send(h.agent)
  h.register('fetch')
  h.register('other')
  h.ctx.tools.registerAdmissionPolicy(({ agent, candidates }) =>
    agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === REVOKE))
      ? [...candidates.keys()].filter(name => name !== 'fetch') : candidates.keys())
  const appended = appendAfterContext(h, REVOKE)
  h.agent.model.select({ provider: 'mock', model: 'model-2' })
  await send(h.agent)
  await appended
  expect(h.adapter.requests[1]?.tools?.map(tool => tool.name).toSorted()).toEqual(['other', 'probe'])
  const events = h.agent.session.snapshotEvents()
  const notices = events.filter(event => event.type === 'developer/message')
  const [abandoned, restarted] = notices
  const headers = events.filter(event => event.type === 'request/header')
  // The abandoned notice declared `fetch` and `other`; the restarted one replaces it and names only the
  // change from the first request's header, citing the restarted header.
  expect(abandoned?.data.message.content).toEqual([
    { type: 'tool-addition', toolName: 'fetch' }, { type: 'tool-addition', toolName: 'other' },
  ])
  expect(restarted?.data.message.content).toEqual([{ type: 'tool-addition', toolName: 'other' }])
  expect(restarted?.surfaceOp).toEqual({ op: 'replace', startSeq: abandoned?.seq, endSeq: abandoned?.seq })
  expect(restarted?.data.headerSeq).toBe(headers.at(-1)?.seq)
})
