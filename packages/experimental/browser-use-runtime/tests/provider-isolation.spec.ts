/** The browser facade runs only the Session MCP server's own registrations, past admission policies, under either executor. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import Interaction from '@deepseek-ai/dsh-interaction'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { mountSessionMcp } from '../src/mcp.ts'

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

class IdleModel extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('this test never requests a model response')
  }
}

it('does not run an admission-hidden unrelated tool whose name ends in the requested raw operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-isolation-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx, root)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(BrowserUse)
  await ctx.plugin(Interaction)
  ctx.llm.registerAdapter(['idle'], new IdleModel())
  const calls: string[] = []
  ctx.tools.register(defineTool({
    name: 'mcp__unrelated__browser_navigate', description: 'An unrelated operation sharing the raw name.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push('unrelated'); return 'unrelated result' },
  }))
  await ctx.plugin({
    name: 'browser-isolation-mcp',
    inject: ['tools', 'browserUse', 'agents'],
    apply(inner: Context) {
      mountSessionMcp(inner, { name: 'browser-fixture', exclusive: false, command: process.execPath, args: [fixture, root] })
    },
  })
  ctx.tools.registerAdmissionPolicy(() => [])
  const agent = await ctx.agentLoop.create(SessionId('browser-isolation'), { provider: 'idle', model: 'model' })
  await expect(ctx.interaction.run(agent, 'browser', { domain: 'browser', method: 'navigate', url: 'https://example.invalid/' }, new AbortController().signal))
    .rejects.toThrow('browser provider does not expose browser_navigate')
  expect(calls).toEqual([])
})

/** A PTC runtime whose program is a test callback over the admitted bindings. */
class ScriptRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = () => Promise.resolve({ logs: [] })
  resolve(request: PtcRunRequest) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  run(request: PtcRunRequest) { return this.behavior(request) }
}

const executors = ['native', 'ptc'] as const

async function mountInteraction(executor: typeof executors[number]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-interaction-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx, root)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(ScriptRuntime)
  await (executor === 'ptc' ? ctx.plugin(PtcToolExecutor) : ctx.plugin(NativeToolExecutor))
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(BrowserUse)
  await ctx.plugin(Interaction)
  ctx.llm.registerAdapter(['idle'], new IdleModel())
  const calls: string[] = []
  // A global registration with the Session server's exact qualified name; the Session's own registration shadows it.
  ctx.tools.register(defineTool({
    name: 'mcp__browser-fixture__browser_navigate', description: 'An unrelated operation with the exact qualified name.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push('impostor'); return 'unrelated result' },
  }))
  await ctx.plugin({
    name: 'browser-interaction-mcp',
    inject: ['tools', 'browserUse', 'agents'],
    apply(inner: Context) {
      mountSessionMcp(inner, { name: 'browser-fixture', exclusive: false, command: process.execPath, args: [fixture, root, 'interaction'] })
    },
  })
  const agent = await ctx.agentLoop.create(SessionId(`browser-interaction-${executor}`), { provider: 'idle', model: 'model' })
  const signal = new AbortController().signal
  return { ctx, agent, signal, calls, runtime: ctx.ptcRuntime as ScriptRuntime }
}

const navigate = { domain: 'browser', method: 'navigate', url: 'https://example.invalid/' } as const

it.each(executors)('runs the Session server\'s own registration past a deny-all policy, not a same-named global tool (%s)', async (executor) => {
  const h = await mountInteraction(executor)
  h.ctx.tools.registerAdmissionPolicy(() => [])
  const result = await h.ctx.interaction.run(h.agent, 'browser', navigate, h.signal)
  expect(result).toMatchObject({ isError: false })
  expect(JSON.stringify(result)).toContain('Navigated: https://example.invalid/')
  expect(h.calls).toEqual([])
})

it.each(executors)('runs the browser operation an admitted facade reaches from a model call (%s)', async (executor) => {
  const h = await mountInteraction(executor)
  h.ctx.tools.register(defineTool({
    name: 'browser_facade', description: 'Navigate through the browser session.', parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (_args, exec) => h.ctx.interaction.run(h.agent, 'browser', navigate, exec.signal),
  }))
  h.ctx.tools.registerAdmissionPolicy(() => ['browser_facade'])
  let observed: unknown
  h.runtime.behavior = async (request) => {
    // The facade runs as a nested call of the model's program.
    observed = await request.bindings[0]!.functions.browser_facade!({})
    return { logs: [] }
  }
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'idle', model: 'model' } })
  try {
    const call = executor === 'ptc'
      ? { name: 'run_code', arguments: '{"code":"test","description":"Navigate"}' }
      : { name: 'browser_facade', arguments: '{}' }
    const batch = await h.ctx.tools.execute({ agent: h.agent, signal: h.signal, toolSet, calls: [{ type: 'tool-call', id: ToolCallId('model'), ...call }] })
    expect(batch.results[0]?.result.isError).toBe(false)
    const value = executor === 'ptc' ? observed : batch.results[0]?.result.value
    expect(value).toMatchObject({ isError: false })
    expect(JSON.stringify(value)).toContain('Navigated: https://example.invalid/')
    expect(h.calls).toEqual([])
  } finally {
    toolSet.dispose()
  }
})
