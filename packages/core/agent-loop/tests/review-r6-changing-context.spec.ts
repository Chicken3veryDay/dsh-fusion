/** Round-6 review: request-time validation versus ordinary changing runtime facts. */
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
import { MockAdapter, textResponse } from './mock-adapter.ts'

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
  const agent = await ctx.agentLoop.create(SessionId('review-r6-changing-context'), { provider: 'mock', model: 'model' })
  ctx.tools.register(defineTool({
    name: 'probe', description: 'Test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'done',
  }))
  return { ctx, adapter, agent }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function turnEnds(agent: Agent): unknown[] {
  return agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason)
}

// The system-prompt README says "Put changing facts in context providers; registered context text is
// read again before admission." Neither provider below touches tool admission: no policy or condition
// reads it, and the tool set never changes. Each provider is evaluated at assembly and admission refresh,
// exactly as the PromptContext contract says.
it.each([
  ['history size', (agent: Agent | undefined) => agent === undefined ? '' : `Messages so far: ${agent.session.deriveMessages().length}.`],
  ['wall clock', (() => { let seconds = 0; return () => `Elapsed seconds: ${seconds++}.` })()],
] as const)('dispatches an ordinary turn whose %s runtime fact changes between reads', async (_label, text) => {
  const h = await harness(new MockAdapter([textResponse('one'), textResponse('two')]))
  h.ctx.systemPrompt.context({ name: 'changing-fact', order: 0, text: ({ agent }) => text(agent) })
  await send(h.agent, 'first')
  await send(h.agent, 'second')
  expect({ requests: h.adapter.requests.length, turnEnds: turnEnds(h.agent) })
    .toEqual({ requests: 2, turnEnds: [{ kind: 'completed' }, { kind: 'completed' }] })
})

it('control: the same turns complete with a static runtime fact', async () => {
  const h = await harness(new MockAdapter([textResponse('one'), textResponse('two')]))
  h.ctx.systemPrompt.context({ name: 'static-fact', order: 0, text: 'Messages so far: unknown.' })
  await send(h.agent, 'first')
  await send(h.agent, 'second')
  expect({ requests: h.adapter.requests.length, turnEnds: turnEnds(h.agent) })
    .toEqual({ requests: 2, turnEnds: [{ kind: 'completed' }, { kind: 'completed' }] })
})
