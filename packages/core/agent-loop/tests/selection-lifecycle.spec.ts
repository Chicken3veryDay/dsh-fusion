/** Pre-step exits and cancellation release the step selection exactly once. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

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
  const agent = await ctx.agentLoop.create(SessionId('selection-lifecycle'), { provider: 'mock', model: 'model' })
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

it.each(['short-circuit', 'reject-before', 'reject-after', 'throw-after', 'abort-condition', 'abort-policy', 'abort-assembly', 'abort-after', 'abort-request', 'throw-assembly', 'success'] as const)('closes each selection once on %s', async (path) => {
  const adapter = new MockAdapter([textResponse('done')])
  const h = await harness(adapter)
  h.register('probe')
  const disposals: number[] = []
  const resolve = h.ctx.tools.resolve.bind(h.ctx.tools)
  vi.spyOn(h.ctx.tools, 'resolve').mockImplementation(async (input) => {
    const selected = await resolve(input)
    const index = disposals.push(0) - 1
    return { ...selected, dispose() { disposals[index]++; selected.dispose() } }
  })
  const cancel = () => h.agent.cancel({ kind: 'user' })
  if (path === 'abort-condition') h.ctx.tools.register(defineTool({ name: 'conditional', description: 'Condition cancellation.', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'unused' }), { when: () => { cancel(); return true } })
  if (path === 'throw-assembly') h.ctx.on('system-prompt/assemble', async () => { throw new Error('assembly failure') })
  if (path === 'abort-policy') h.ctx.tools.registerAdmissionPolicy(({ candidates }) => { cancel(); return [...candidates.keys()] })
  if (path === 'abort-assembly') h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { const result = await next(); cancel(); return result })
  if (path === 'abort-request') h.ctx.on('agent/request', async (_event, next) => { const config = await next(); cancel(); return config })
  if (!['abort-condition', 'abort-policy', 'abort-assembly', 'abort-request', 'throw-assembly', 'success'].includes(path)) h.ctx.on('agent/pre-step', async ({ messages }, next) => {
    if (path === 'short-circuit') return { kind: 'enter', messages }
    if (path === 'reject-before') return { kind: 'reject' }
    const result = await next()
    if (path === 'reject-after') return { kind: 'reject' }
    if (path === 'throw-after') throw new Error('listener rejection')
    cancel()
    return result
  })
  await send(h.agent, 'check selection lifetime')
  const endings = h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)
  expect(endings).toEqual([path.startsWith('abort-') ? 'aborted' : path.startsWith('reject-') ? 'blocked' : path.startsWith('throw-') ? 'error' : 'completed'])
  expect(disposals).toEqual(['reject-before', 'abort-condition', 'abort-policy'].includes(path) ? [] : [1])
  expect(adapter.requests).toHaveLength(['short-circuit', 'success'].includes(path) ? 1 : 0)
})
