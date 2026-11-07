/** Conditional tools, wrapper-bounded loads, edited sections, curated catalog groups, and unloadable hidden tools. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import ContextIndexService from '@deepseek-ai/dsh-experimental-context-index'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, type LlmResolvedModelInfo, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContextTreeService, { ContextTreeTools, type Config } from '../src/index.ts'
import { catalogDigest, catalogMessage, grantOverhead, grantText, type CatalogBranch } from '../src/messages.ts'

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
  readonly errors: string[]
}

async function world(config: Config = {}, options: { tools?: boolean; agentsFile?: string } = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-tree-sweep-')))
  roots.push(root)
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'agents-home'))
  write(join(project, 'AGENTS.md'), options.agentsFile ?? '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest.\n')

  const ctx = new Context()
  contexts.push(ctx)
  const errors: string[] = []
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
  for (const name of ['read', 'deploy_run', 'deploy_status']) ctx.tools.register(probeTool(name))
  vi.spyOn(ctx.logger, 'error').mockImplementation((message: unknown) => { errors.push(String(message)) })
  await ctx.plugin(ContextTreeService, config)
  if (options.tools !== false) await ctx.plugin(ContextTreeTools)
  const session = Session.create(SessionId(`sweep-${Math.random().toString(36).slice(2)}`))
  const agent = { session, options: {}, id: session.id } as Agent
  return { ctx, tree: ctx.contextTree, project, session, agent, errors }
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

async function sectionsOf(w: World) {
  return (await w.ctx.contextIndex.snapshot({ workingDirectory: w.project })).sections
}

describe('grant message forms', () => {
  const frame = { path: 'Instructions/Project/AGENTS.md/sec', anchor: 'AGENTS.md#Rules', hash: 'sha256:new', supersedes: 'sha256:old' }

  it('shows the full frame with an out-of-date notice, a compact frame, or a bare one', () => {
    expect(grantText(frame, 'Body', false, 'full')).toBe(
      '<context-grant path="Instructions/Project/AGENTS.md/sec" section="AGENTS.md#Rules" hash="sha256:new" replaces="sha256:old">\n'
      + '[An earlier copy of this section in the conversation is out of date; this text replaces it.]\nBody\n</context-grant>',
    )
    expect(grantText(frame, 'Bo', true, 'compact')).toBe('<context-grant path="Instructions/Project/AGENTS.md/sec" replaces="sha256:old">\nBo\n[cut]\n</context-grant>')
    expect(grantText(frame, 'B', true, 'bare')).toBe('<context-grant>\nB\n[cut]\n</context-grant>')
  })

  it('names no replaced copy for a first grant and counts the frame bytes without the text', () => {
    const first = { path: frame.path, anchor: frame.anchor, hash: frame.hash }
    expect(grantText(first, 'Body', true, 'full')).toBe(
      '<context-grant path="Instructions/Project/AGENTS.md/sec" section="AGENTS.md#Rules" hash="sha256:new">\n'
      + 'Body\n[Cut here: the load budget ended inside this section; the rest is in the file.]\n</context-grant>',
    )
    expect(grantText(first, 'Body', false, 'compact')).toBe('<context-grant path="Instructions/Project/AGENTS.md/sec">\nBody\n</context-grant>')
    expect(grantOverhead(first, false, 'bare')).toBe(Buffer.byteLength('<context-grant>\n\n</context-grant>'))
  })
})

describe('catalog group lines', () => {
  const line = (name: string, summary: string) => `  - Instructions/Project/${name}: ${summary}`
  const branches = (count: number): CatalogBranch[] => [{
    path: 'Instructions/Project',
    summary: 'Project rules.',
    groups: Array.from({ length: count }, (_, index) => ({ path: `Instructions/Project/g${index}`, summary: `Use for topic ${index} ${'x'.repeat(60)}.` })),
  }]
  const bytes = (text: string) => Buffer.byteLength(text) + 1

  it('lists every curated group under its folder when the lines fit', () => {
    const text = textOf(catalogMessage(branches(2), false, [], 4096))
    expect(text).toContain(`- Instructions/Project: Project rules.\n${line('g0', `Use for topic 0 ${'x'.repeat(60)}.`)}\n${line('g1', `Use for topic 1 ${'x'.repeat(60)}.`)}\n</context_tree>`)
  })

  it('counts the groups past the byte bound on one line', () => {
    const first = line('g0', `Use for topic 0 ${'x'.repeat(60)}.`)
    const plural = '  - and 2 more curated groups; context_browse lists them'
    expect(textOf(catalogMessage(branches(3), false, [], bytes(first) + bytes(plural)))).toContain(`${first}\n${plural}\n</context_tree>`)
    const singular = '  - and 1 more curated group; context_browse lists them'
    expect(textOf(catalogMessage(branches(2), false, [], bytes(first) + bytes(singular)))).toContain(`${first}\n${singular}\n</context_tree>`)
    const all = '  - and 2 more curated groups; context_browse lists them'
    expect(textOf(catalogMessage(branches(2), false, [], bytes(all)))).toContain(`- Instructions/Project: Project rules.\n${all}\n</context_tree>`)
  })

  it('shows no group line when not even the count fits', () => {
    expect(textOf(catalogMessage(branches(2), false))).toContain('- Instructions/Project: Project rules.\n</context_tree>')
  })

  it('keeps the digest of a catalog without groups and changes it when a group appears', () => {
    const plain = [{ path: 'Instructions/Project', summary: 'Project rules.' }]
    expect(catalogDigest([{ ...plain[0]!, groups: [] }])).toBe(catalogDigest(plain))
    expect(catalogDigest(branches(1))).not.toBe(catalogDigest(plain))
  })
})

describe('loads bounded with their frames', () => {
  it('grants nothing when no frame fits the load budget and reports every section as omitted', async () => {
    const w = await world({ maxLoadBytes: 1 })
    const outcome = await w.tree.load(w.agent, { paths: ['Instructions/Project/AGENTS.md'] })
    expect(outcome.contexts).toEqual([])
    expect(outcome.result.granted).toEqual([])
    expect(outcome.result.omittedSections).toHaveLength(2)
  })

  it('grants nothing when the cut ends inside the first character', async () => {
    const bare = grantOverhead({ path: '', anchor: '', hash: '' }, true, 'bare')
    const w = await world({ maxLoadBytes: bare + 1 }, { agentsFile: '界界界界\n' })
    const outcome = await w.tree.load(w.agent, { paths: ['Instructions/Project/AGENTS.md'] })
    expect(outcome.contexts).toEqual([])
    expect(outcome.result.omittedSections).toHaveLength(1)
  })

  it('marks the earlier copy out of date when a loaded section is loaded again after an edit', async () => {
    const w = await world()
    const testing = (await sectionsOf(w)).find(section => section.headingPath.at(-1) === 'Testing')!
    const first = await w.tree.load(w.agent, { paths: [testing.id] })
    for (const message of first.contexts) w.session.append('user/message', message, { surfaceOp: 'append' })
    expect((await w.tree.load(w.agent, { paths: [testing.id] })).result.granted).toEqual([])

    write(join(w.project, 'AGENTS.md'), '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest twice.\n')
    const again = await w.tree.load(w.agent, { paths: [testing.id] })
    expect(again.contexts).toHaveLength(1)
    const message = again.contexts[0]!
    expect(message.source).toMatchObject({ kind: 'context-grant', key: testing.id, supersedes: testing.hash })
    expect(textOf(message)).toContain(`replaces="${testing.hash}"`)
    expect(textOf(message)).toContain('is out of date; this text replaces it.')
    expect(textOf(message)).toContain('Run vitest twice.')
  })
})

describe('tools gated by their own condition', () => {
  it('lists and activates a conditional tool only while its condition admits the agent', async () => {
    const w = await world()
    let planning = false
    w.ctx.tools.register(probeTool('plan_only'), { when: () => planning, origin: 'global' })
    const shown = async () => (await w.tree.browse(w.agent, { path: 'Tools', depth: 3 })).nodes.map(node => node.path).filter(path => path.endsWith('/plan_only'))

    await declared(w)
    expect(await shown()).toEqual([])
    expect((await w.tree.load(w.agent, { paths: ['Tools/@/plan_only'] })).result.missing).toEqual(['Tools/@/plan_only'])

    planning = true
    await declared(w)
    expect(await shown()).toEqual(['Tools/Global/other/plan_only'])
    const loaded = await w.tree.load(w.agent, { paths: ['Tools/@/plan_only'] })
    expect(loaded.result.activated).toEqual([{ path: 'Tools/@/plan_only', tools: ['plan_only'] }])
    for (const message of loaded.contexts) w.session.append('user/message', message, { surfaceOp: 'append' })
    expect(await declared(w)).toContain('plan_only')
  })
})

describe('hidden tools without the tree tools', () => {
  it('reports once per agent', async () => {
    const w = await world({}, { tools: false })
    await declared(w)
    await declared(w)
    expect(w.errors.filter(line => line.includes('context_browse or context_load is not registered'))).toEqual([
      expect.stringContaining('context tree hides deploy_run, deploy_status from agent'),
    ])
  })

  it('stays quiet when the tree tools are registered', async () => {
    const w = await world()
    await declared(w)
    expect(w.errors).toEqual([])
  })
})

describe('eager core after an edit', () => {
  it('moves the charge of the replaced copy to the new grant and grants nothing more while both copies stay', async () => {
    const file = (version: string) => `# Safety\n\nVersion ${version}. ${'Rule. '.repeat(300)}\n\n## Style\n\n${'Short. '.repeat(150)}\n`
    const w = await world({ coreBytes: 3200 }, { agentsFile: file('one') })
    const sections = (await sectionsOf(w)).filter(section => section.kind === 'project-instructions')
    expect(sections.map(section => section.headingPath.at(-1))).toEqual(['Safety', 'Style'])
    expect(sections[0]!.bytes + sections[1]!.bytes).toBeLessThanOrEqual(3200)
    expect(2 * sections[0]!.bytes + sections[1]!.bytes).toBeGreaterThan(3200)
    w.tree.registerEagerCore(() => sections.map(section => section.id))
    const grants = (messages: UserMessage[]) => messages.filter(message => message.source.kind === 'context-grant')

    expect(grants(await preStep(w, 2))).toHaveLength(2)
    write(join(w.project, 'AGENTS.md'), file('two'))
    const regrant = grants(await preStep(w, 3))
    expect(regrant).toHaveLength(1)
    expect(regrant[0]!.source).toMatchObject({ key: sections[0]!.id, supersedes: sections[0]!.hash })
    expect(textOf(regrant[0]!)).toContain('Version two.')
    expect(grants(await preStep(w, 4))).toEqual([])
  })
})
