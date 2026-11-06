/** Catalog reloads and declaration order across curator role changes. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import ContextIndexService from '@deepseek-ai/dsh-experimental-context-index'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
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
const FILLER = 'conversation filler '.repeat(40).trim()

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'r4-tree-')))
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
  for (const name of ['read', 'bash', 'deploy_run', 'deploy_status', 'curate']) ctx.tools.register(probe(name))
  await ctx.plugin(ContextTreeService)
  await ctx.plugin(ContextTreeTools)
  const session = Session.create(SessionId(`r4-tree-${Math.random().toString(36).slice(2)}`))
  const agent = { session, options: {}, id: session.id } as Agent
  return { ctx, engine, tree: ctx.contextTree, session, agent }
}

type World = Awaited<ReturnType<typeof world>>

async function declared(w: World): Promise<string[]> {
  const toolSet = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
  try { return w.ctx.tools.schemas(w.agent, toolSet).map(schema => schema.name) }
  finally { toolSet.dispose() }
}

/** Log turns of filler, with extra messages in the first turn; returns the first and last surface seq. */
function turns(session: Session, count: number, first: readonly UserMessage[] = []): { start: SessionSeq; end: SessionSeq } {
  let end = SessionSeq(0)
  let start: SessionSeq | undefined
  for (let turn = 1; turn <= count; turn += 1) {
    session.append('turn/start', { turn })
    const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `${FILLER} user ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    start ??= user.seq
    if (turn === 1) for (const message of first) session.append('user/message', message, { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (session.requestHeader() === undefined) session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    end = session.append('assistant/message', {
      stream: [], turn, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: `${FILLER} assistant ${turn}` }], source: { kind: 'model', provider: MODEL, model: MODEL } }),
    }, { surfaceOp: 'append' }).seq
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { start: start ?? end, end }
}

async function compact(w: World, region: { start: SessionSeq; end: SessionSeq }): Promise<void> {
  w.session.append('turn/start', { turn: 99 })
  await w.engine.compactRegion(region.start, region.end, w.agent, SIGNAL)
  w.session.append('turn/end', { turn: 99, reason: { kind: 'completed' } })
}

async function preStepMessages(w: World): Promise<UserMessage[]> {
  const decision = await agentEvents(w.ctx, w.agent).waterfall(
    'agent/pre-step', { modelSelection: SELECTION, messages: [], turn: 9, step: 2, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  return decision.kind === 'enter' ? decision.messages : []
}

const text = (messages: readonly UserMessage[]): string => messages.flatMap(message => message.content).map(block => block.type === 'text' ? block.text : '').join('\n')

it('R4-m1 a republished catalog does not list a tool as dropped after the model loaded it again on its own', async () => {
  const w = await world()
  const catalog = await preStepMessages(w)
  const group = await w.tree.load(w.agent, { paths: ['Tools/Global/deploy'] })
  const first = turns(w.session, 4, [...catalog, ...group.contexts])
  expect([...w.tree.activeTools(w.agent)].sort()).toEqual(['deploy_run', 'deploy_status'])
  await compact(w, first)
  expect(w.tree.activeTools(w.agent).size).toBe(0)

  // The catalog comes back with both tools listed as dropped; the model reloads only one of them by its stub path.
  const republished = await preStepMessages(w)
  expect(text(republished)).toContain('Tools/@/deploy_run')
  const reload = await w.tree.load(w.agent, { paths: ['Tools/@/deploy_run'] })
  expect(reload.result.activated.flatMap(entry => entry.tools)).toEqual(['deploy_run'])
  const second = turns(w.session, 4, [...republished])
  turns(w.session, 1, reload.contexts)
  expect([...w.tree.activeTools(w.agent)]).toEqual(['deploy_run'])

  // A second compaction removes the old catalog but keeps the newer reload; the catalog is published again.
  await compact(w, second)
  expect([...w.tree.activeTools(w.agent)], 'the reload is retained').toEqual(['deploy_run'])
  const again = text(await preStepMessages(w))
  expect(again).toContain('Dropped by compaction')
  expect(again, 'deploy_run is callable, so it was not dropped').not.toContain('Tools/@/deploy_run')
  await expect(again + '\n').toMatchFileSnapshot('./expected/reloaded-tool-catalog.txt')
})

it('R4-m2 admitting curator-managed tools appends to the declarations instead of shifting activated tools', async () => {
  const w = await world()
  let holder = false
  w.tree.registerManagedTools(['curate'], () => holder)
  const group = await w.tree.load(w.agent, { paths: ['Tools/Global/deploy'] })
  turns(w.session, 1, group.contexts)
  const before = await declared(w)
  expect(before).toEqual(['read', 'bash', 'context_browse', 'context_load', 'deploy_run', 'deploy_status'])
  holder = true
  const after = await declared(w)
  expect(after.slice(0, before.length), 'earlier declarations stay a cache-stable prefix').toEqual(before)
})
