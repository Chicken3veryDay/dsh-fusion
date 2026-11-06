/** Automatic pre-step compaction revokes an activation before the step declares or dispatches its tools. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import ContextIndex from '@deepseek-ai/dsh-experimental-context-index'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ContextTree from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
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
  const agent = await ctx.agentLoop.create(SessionId('revoked-tool-step'), { provider: 'mock', model: 'model' })
  const calls: string[] = []
  const register = (name: string) => ctx.tools.register(defineTool({
    name, description: `Operation ${name}.`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push(name); return 'done' },
  }))
  return { ctx, agent, register, calls }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

class SummaryEngine extends BasicCompactionEngine {
  protected override summarize(_input: SummarizationInput): ReturnType<BasicCompactionEngine['summarize']> {
    return Promise.resolve({ summary: [{ type: 'text', text: 'checkpoint' }], provider: 'test', model: 'summary' })
  }
}

class FixedDirectory extends Service {
  constructor(ctx: Context, private readonly root: { path: string }) { super(ctx, 'workingDirectory') }
  ensure(): Promise<string> { return Promise.resolve(this.root.path) }
}

class WindowMockAdapter extends MockAdapter {
  override async resolveModel(provider: string, model: string) {
    return { ...await super.resolveModel(provider, model), context: { contextWindow: 50_000 } }
  }
}

it('refuses a tool whose activation automatic pre-step compaction removes, in the declarations and at dispatch', async () => {
  const adapter = new WindowMockAdapter([
    textResponse('activation received'),
    toolCallResponse('after-compaction', 'probe', {}), textResponse('done'),
  ])
  const h = await harness(adapter)
  h.register('probe')
  const root = mkdtempSync(join(tmpdir(), 'revoked-tool-step-'))
  roots.push(root)
  mkdirSync(join(root, '.git'))
  vi.stubEnv('DSH_HOME', join(root, 'empty-home'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'empty-agents'))
  await h.ctx.plugin(TokenMeter)
  await h.ctx.plugin(SummaryEngine, { auto: true, thresholdRatio: 0.01, retainTokens: 1, headroomTokens: 0, maxTokens: 8192 })
  await h.ctx.plugin(LocalFileSystem, { cwd: '/' })
  await h.ctx.plugin(ContextIndex)
  await h.ctx.plugin(FixedDirectory, { path: root })
  await h.ctx.plugin(ContextTree)
  const loaded = await h.ctx.contextTree.load(h.agent, { paths: ['Tools'] })
  expect(loaded.contexts.some(message => message.source.kind === 'context-activation')).toBe(true)
  for (const message of loaded.contexts) h.agent.inject(message)
  await send(h.agent, 'context '.repeat(1000))
  expect(h.ctx.contextTree.activeTools(h.agent).has('probe')).toBe(true)
  await send(h.agent, 'try the historical tool')
  expect(h.agent.session.snapshotEvents().filter(event => event.type === 'compaction/end').map(event => event.data.error)).toEqual([undefined])
  expect(h.ctx.contextTree.activeTools(h.agent).size).toBe(0)
  expect({ declarations: (adapter.requests[1]?.tools ?? []).map(tool => tool.name), calls: h.calls })
    .toEqual({ declarations: [], calls: [] })
})
