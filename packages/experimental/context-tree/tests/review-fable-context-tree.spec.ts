/** Review sweep (Fable): eager core after a source edit, grant message bounds, silent admission, catalog identity. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import ContextIndexService from '@deepseek-ai/dsh-experimental-context-index'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, ToolCallId, type LlmResolvedModelInfo, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContextTreeService, { ContextTreeTools, type Config } from '../src/index.ts'

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
  constructor(ctx: Context, private readonly root: { path: string }) {
    super(ctx, 'workingDirectory')
  }

  ensure(): Promise<string> {
    return Promise.resolve(this.root.path)
  }
}

const roots: string[] = []
const contexts: Context[] = []

beforeEach(() => {
  vi.stubEnv('DSH_HOME', '')
  vi.stubEnv('DSH_AGENTS_HOME', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const probeTool = (name: string) => defineTool({
  name,
  description: `Operation ${name}.`,
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute() { return Promise.resolve(`ran:${name}`) },
})

interface World {
  readonly ctx: Context
  readonly tree: ContextTreeService
  readonly project: string
  readonly session: Session
  readonly agent: Agent
  readonly warnings: string[]
}

function agentOf(session: Session): Agent {
  return { session, options: {}, id: session.id } as Agent
}

async function world(config: Config = {}, options: { tools?: boolean; agentsFile?: string } = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-fable-tree-')))
  roots.push(root)
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'agents-home'))
  write(join(home, 'AGENTS.md'), '# Personal\n\nAlways answer briefly.\n')
  write(join(project, 'AGENTS.md'), options.agentsFile ?? '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest.\n')
  write(join(project, 'docs', 'architecture.md'), '# Architecture\n\nServices are Cordis plugins.\n')

  const ctx = new Context()
  contexts.push(ctx)
  const warnings: string[] = []
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new WindowAdapter())
  void new SpyEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 8192 })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ContextIndexService)
  await ctx.plugin(FixedWorkingDirectory, { path: project })
  for (const name of ['read', 'bash', 'deploy_run', 'deploy_status']) ctx.tools.register(probeTool(name))
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)) })
  vi.spyOn(ctx.logger, 'error').mockImplementation((message: unknown) => { warnings.push(String(message)) })
  await ctx.plugin(ContextTreeService, config)
  if (options.tools !== false) await ctx.plugin(ContextTreeTools)
  const session = Session.create(SessionId(`review-${Math.random().toString(36).slice(2)}`))
  return { ctx, tree: ctx.contextTree, project, session, agent: agentOf(session), warnings }
}

async function declared(w: World): Promise<string[]> {
  const toolSet = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
  return w.ctx.tools.schemas(w.agent, toolSet).map(schema => schema.name)
}

async function preStep(w: World, step: number): Promise<UserMessage[]> {
  const decision = await agentEvents(w.ctx, w.agent).waterfall(
    'agent/pre-step', { modelSelection: SELECTION, messages: [], turn: 1, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  const messages = decision.kind === 'enter' ? [...decision.messages] : []
  for (const message of messages) w.session.append('user/message', message, { surfaceOp: 'append' })
  return messages
}

function textOf(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

describe('eager core after a source edit', () => {
  it('grants the current text of a core section again after its file changed on disk', async () => {
    const rule = (version: string) => `# Safety\n\nNever print secret values. Version ${version}.\n${'Rule detail. '.repeat(160)}\n`
    const w = await world({ coreBytes: 4096 }, { agentsFile: rule('one') })
    const sections = (await w.ctx.contextIndex.snapshot({ workingDirectory: w.project })).sections
    const safety = sections.find(section => section.headingPath[0] === 'Safety')!
    expect(safety.bytes).toBeGreaterThan(2048)
    expect(safety.bytes).toBeLessThan(4096)
    w.tree.registerEagerCore(() => [safety.id])

    const first = await preStep(w, 2)
    const firstGrant = first.find(message => message.source.kind === 'context-grant')
    expect(firstGrant, 'the core is granted on the first step').toBeDefined()
    expect(textOf(firstGrant!)).toContain('Version one.')

    write(join(w.project, 'AGENTS.md'), rule('two'))
    const changed = (await w.ctx.contextIndex.snapshot({ workingDirectory: w.project })).sections.find(section => section.id === safety.id)!
    expect(changed.hash).not.toBe(safety.hash)

    const second = await preStep(w, 3)
    const regrant = second.find(message => message.source.kind === 'context-grant')
    const visible = w.session.deriveMessages().map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n')
    expect(visible).toContain('Version one.')
    expect(regrant, 'the edited core section must be granted again with its current text (or the stale grant marked)').toBeDefined()
    expect(textOf(regrant!)).toContain('Version two.')
  })
})

describe('grant message bounds', () => {
  it('keeps the complete logged grant message within maxLoadBytes', async () => {
    const w = await world({ maxLoadBytes: 48 })
    const toolSet = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
    const result = await executeModelToolFixture(w.ctx, {
      agent: w.agent, name: 'context_load', arguments: { paths: ['Instructions/Project/AGENTS.md'] },
      callId: ToolCallId('load-1'), signal: SIGNAL, toolSet,
    })
    const contexts = result.additionalContexts ?? []
    expect(contexts.length).toBeGreaterThan(0)
    const bytes = contexts.reduce((sum, message) => sum + Buffer.byteLength(textOf(message), 'utf8'), 0)
    expect(bytes, `grant messages total ${String(bytes)} bytes against maxLoadBytes 48`).toBeLessThanOrEqual(48)
  })
})

describe('zero configuration', () => {
  it('fails loud when the tree hides tools but no context_browse or context_load is registered', async () => {
    const w = await world({}, { tools: false })
    const names = await declared(w)
    expect(names).toEqual(['read', 'bash'])
    const messages = await preStep(w, 2)
    expect(messages, 'no catalog is published without the tree tools').toEqual([])
    expect(w.warnings.some(line => /context_browse|context_load|context tree/i.test(line)),
      `hiding deploy_run and deploy_status with no way to load them must be reported; warnings: ${JSON.stringify(w.warnings)}`).toBe(true)
  })
})

describe('catalog identity', () => {
  it('republishes the catalog when the curated groups change', async () => {
    const w = await world()
    let groups: { root: 'Instructions'; origin: 'project'; name: string; title: string; summary: string; sections: string[]; tools: string[] }[] = []
    const sections = (await w.ctx.contextIndex.snapshot({ workingDirectory: w.project })).sections
    const testing = sections.find(section => section.headingPath.at(-1) === 'Testing')!
    w.tree.registerCuratedGroups(() => groups as never)
    const first = await preStep(w, 2)
    expect(first.map(message => message.source.kind)).toEqual(['context-tree-catalog'])
    groups = [{ root: 'Instructions', origin: 'project', name: 'testing', title: 'Testing', summary: 'Use when running tests.', sections: [testing.id], tools: [] }]
    expect((await w.tree.browse(w.agent, { path: 'Instructions/Project' })).nodes.map(node => node.path)).toContain('Instructions/Project/testing')
    const second = await preStep(w, 3)
    expect(second.map(message => message.source.kind), 'README: the tree republishes its catalog when the map changes').toEqual(['context-tree-catalog'])
  })
})

describe('loaded sections that no longer exist', () => {
  it('reports a stub reload of a deleted section as missing and still grants the rest', async () => {
    const w = await world()
    const sections = (await w.ctx.contextIndex.snapshot({ workingDirectory: w.project })).sections
    const doc = sections.find(section => section.kind === 'doc')!
    const project = sections.find(section => section.kind === 'project-instructions')!
    rmSync(join(w.project, 'docs', 'architecture.md'))
    const outcome = await w.tree.load(w.agent, { paths: [doc.id, project.id] })
    expect(outcome.result.missing).toEqual([doc.id])
    expect(outcome.result.granted).toHaveLength(1)
  })
})

describe('tools with a when-condition', () => {
  it('does not list or activate a tool whose when-condition excludes the agent, or declares it after activation', async () => {
    const w = await world()
    const gated = defineTool({
      name: 'plan_only',
      description: 'Only while planning.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() { return Promise.resolve('ran:plan_only') },
    })
    w.ctx.tools.register(gated, { when: () => false, origin: 'global' })
    expect(await declared(w)).not.toContain('plan_only')
    const listing = await w.tree.browse(w.agent, { path: 'Tools', depth: 3 })
    const shown = listing.nodes.map(node => node.path).filter(path => path.endsWith('/plan_only'))
    const toolSet = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
    const result = await executeModelToolFixture(w.ctx, {
      agent: w.agent, name: 'context_load', arguments: { paths: [...shown, 'plan_only'] },
      callId: ToolCallId('load-gated'), signal: SIGNAL, toolSet,
    })
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    for (const context of result.additionalContexts ?? []) w.session.append('user/message', context, { surfaceOp: 'append' })
    const after = await declared(w)
    // Either the tree never offers the tool, or what it tells the model matches what the next step declares.
    expect({ shown, activated: text.includes('Activated'), declared: after.includes('plan_only') },
      `the model is told a tool is callable from the next step that the step never declares: ${text}`)
      .toEqual({ shown: [], activated: false, declared: false })
  })
})
