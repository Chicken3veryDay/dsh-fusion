/** Compaction after the pre-step final handler revokes the request's declarations and dispatch together. */
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
import LlmRuntime, { createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
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
  const agent = await ctx.agentLoop.create(SessionId('revoked-tool-request'), { provider: 'mock', model: 'model' })
  // Count every selection's disposals: a replaced selection must close exactly once.
  const disposals: number[] = []
  const resolve = ctx.tools.resolve.bind(ctx.tools)
  vi.spyOn(ctx.tools, 'resolve').mockImplementation(async (input) => {
    const selected = await resolve(input)
    const index = disposals.push(0) - 1
    return { ...selected, dispose() { disposals[index]++; selected.dispose() } }
  })
  const calls: string[] = []
  const register = (name: string) => ctx.tools.register(defineTool({
    name, description: `Operation ${name}.`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push(name); return 'done' },
  }))
  return { ctx, agent, register, calls, disposals }
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
    return { ...await super.resolveModel(provider, model), context: { contextWindow: model === 'small' ? 4_000 : 100_000 } }
  }
}

type Mode = 'switch' | 'overflow' | 'pre-step-unwind'

/** Activate `probe`, finish one long turn, and arm the compaction that the next turn's `mode` triggers. */
async function activated(mode: Mode) {
  const adapter = new WindowMockAdapter([
    textResponse('activation received'),
    ...(mode === 'overflow' ? [[{ type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'context full' } } }]] : []),
    toolCallResponse('after-compaction', 'probe', {}), textResponse('done'),
  ])
  const h = await harness(adapter)
  h.register('probe')
  const root = mkdtempSync(join(tmpdir(), 'dsh-revoked-request-'))
  roots.push(root)
  mkdirSync(join(root, '.git'))
  vi.stubEnv('DSH_HOME', join(root, 'empty-home'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'empty-agents'))
  await h.ctx.plugin(TokenMeter)
  await h.ctx.plugin(SummaryEngine, { auto: true, thresholdRatio: 0.5, retainTokens: 1, headroomTokens: 0, maxTokens: 128 })
  await h.ctx.plugin(LocalFileSystem, { cwd: '/' })
  await h.ctx.plugin(ContextIndex)
  await h.ctx.plugin(FixedDirectory, { path: root })
  await h.ctx.plugin(ContextTree)
  const loaded = await h.ctx.contextTree.load(h.agent, { paths: ['Tools'] })
  for (const message of loaded.contexts) h.agent.inject(message)
  await send(h.agent, 'context '.repeat(5000))
  expect(h.ctx.contextTree.activeTools(h.agent).has('probe')).toBe(true)
  expect(adapter.requests).toHaveLength(1)
  if (mode === 'switch') h.agent.model.select({ provider: 'mock', model: 'small' })
  let compacted = false
  if (mode === 'pre-step-unwind') h.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (!compacted) {
      compacted = true
      await h.ctx.compaction.compactIfNeeded(agent, 'context-overflow', signal)
    }
    return decision
  })
  return { ...h, adapter }
}

it.each(['switch', 'overflow', 'pre-step-unwind'] as const)('revokes the selection after %s compaction', async (mode) => {
  const h = await activated(mode)
  const adapter = h.adapter
  await send(h.agent, 'try the historical tool')
  expect(h.agent.session.snapshotEvents().filter(event => event.type === 'compaction/end').map(event => event.data.error)).toEqual([undefined])
  expect(h.ctx.contextTree.activeTools(h.agent).size).toBe(0)
  const request = adapter.requests[mode === 'overflow' ? 2 : 1]
  expect(request).toBeDefined()
  expect({ declarations: (request?.tools ?? []).map(tool => tool.name), calls: h.calls })
    .toEqual({ declarations: [], calls: [] })
  // The step replaced its selection after compaction; every selection, replaced or final, closed once.
  expect(h.disposals.every(count => count === 1)).toBe(true)
})

it('closes the replaced selection once when reselection after compaction fails', async () => {
  const h = await activated('switch')
  const adapter = h.adapter
  let compacted = false
  h.ctx.on('session/event', (_session, event) => { if (event.type === 'compaction/end') compacted = true })
  h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    if (compacted) throw new Error('reselection failure')
    return next()
  })
  await send(h.agent, 'try the historical tool')
  expect(h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed', 'error'])
  expect(adapter.requests).toHaveLength(1)
  expect(h.calls).toEqual([])
  expect(h.disposals.every(count => count === 1)).toBe(true)
})
