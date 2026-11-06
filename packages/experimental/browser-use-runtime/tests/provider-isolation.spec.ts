/** The browser facade dispatches only the session MCP server's own tools, even past admission policies. */
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
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
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
