/** Review probe: base-tool declaration order across a provider reload under the context-tree policy. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import ContextIndexService from '@deepseek-ai/dsh-experimental-context-index'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import ContextTreeService, { ContextTreeTools } from '../src/index.ts'

const MODEL = 'test-model'
const SELECTION = { provider: MODEL, model: MODEL }
const SIGNAL = new AbortController().signal

class WindowAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class SpyEngine extends BasicCompactionEngine {
  protected override summarize(_input: SummarizationInput): ReturnType<BasicCompactionEngine['summarize']> {
    return Promise.resolve({ summary: [{ type: 'text', text: 'small checkpoint' }], provider: 'summary-provider', model: 'summary-model' })
  }
}

class FixedWorkingDirectory extends Service {
  constructor(ctx: Context, private readonly root: { path: string }) { super(ctx, 'workingDirectory') }
  ensure(): Promise<string> { return Promise.resolve(this.root.path) }
}

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const probe = (name: string) => defineTool({
  name, description: `Operation ${name}.`, parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: () => Promise.resolve(`ran:${name}`),
})

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opus-order-')))
  roots.push(root)
  const project = join(root, 'project')
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(project, 'AGENTS.md'), '# Project rules\n\nUse pnpm.\n')
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'agents-home'))
  const ctx = new Context()
  contexts.push(ctx)
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new WindowAdapter())
  const engine = new SpyEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 8192 })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ContextIndexService)
  await ctx.plugin(FixedWorkingDirectory, { path: project })
  const reader = ctx.plugin(Object.assign((inner: Context) => { inner.tools.register(probe('read')) }, { inject: ['tools'] }))
  await reader
  for (const name of ['bash', 'deploy_run', 'deploy_status']) ctx.tools.register(probe(name))
  await ctx.plugin(ContextTreeService)
  await ctx.plugin(ContextTreeTools)
  const session = Session.create(SessionId(`opus-order-${Math.random().toString(36).slice(2)}`))
  const agent = { session, options: {}, id: session.id } as Agent
  return { ctx, engine, tree: ctx.contextTree, session, agent, reader }
}

type World = Awaited<ReturnType<typeof world>>

async function declared(w: World): Promise<string[]> {
  const toolSet = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
  try {
    const assembly = await w.ctx.systemPrompt.assemble({ scope: w.agent, modelSelection: SELECTION, toolSet, signal: SIGNAL })
    return assembly.tools.map(schema => schema.name)
  } finally { toolSet.dispose() }
}

it('keeps the base-tool declaration sequence when an unchanged base tool provider reloads (HMR)', async () => {
  const w = await world()
  const before = await declared(w)
  expect(before).toContain('read')
  // HMR reloads the provider of `read` with an identical definition.
  await w.reader.dispose()
  await w.ctx.plugin(Object.assign((inner: Context) => { inner.tools.register(probe('read')) }, { inject: ['tools'] }))
  const after = await declared(w)
  expect(after, 'the request head must not change for an identical tool set').toEqual(before)
})
