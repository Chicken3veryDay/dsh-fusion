import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import ContextIndexService, { ContextSectionIdOf } from '@deepseek-ai/dsh-experimental-context-index'
import type { ContextSectionMeta, ContextSourceMeta } from '@deepseek-ai/dsh-experimental-context-index/types'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, {
  createMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContextTreeService, { ContextTreeError, ContextTreeTools, DEFAULT_BASE_TOOLS, type Config } from '../src/index.ts'
import { catalogMessage } from '../src/messages.ts'
import { contextTreeProjectionDefinition } from '../src/projection.ts'
import { buildTree, findNode, viewOf } from '../src/tree.ts'

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

/** Working-directory service stand-in that answers one fixed project root. */
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

const HIDDEN = ['mcp__github__list_issues', 'mcp__github__create_issue', 'deploy_run', 'deploy_status', 'lonely']

const probeTool = (name: string, calls: string[]) => defineTool({
  name,
  description: `Operation ${name}. Extra detail that should not be in the summary.`,
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute() { calls.push(name); return Promise.resolve(`ran:${name}`) },
})

interface World {
  readonly ctx: Context
  readonly engine: SpyEngine
  readonly tree: ContextTreeService
  readonly project: string
  readonly home: string
  readonly calls: string[]
  readonly session: Session
  readonly agent: Agent
  readonly fiber: { dispose(): Promise<void> }
  readonly toolsFiber: { dispose(): Promise<void> }
  /** Messages deferred by tools and waiting in the next-step inbox, as the agent loop queues them. */
  readonly queued: UserMessage[]
}

function agentOf(session: Session): Agent {
  return { session, options: {}, id: session.id } as Agent
}

async function world(config: Config = {}, options: { registerTools?: boolean } = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-tree-')))
  roots.push(root)
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'agents-home'))
  write(join(home, 'AGENTS.md'), '# Personal\n\nAlways answer briefly.\n\n## Style\n\nNo emoji.\n')
  write(join(project, 'AGENTS.md'), '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest.\n')
  write(join(project, 'docs', 'architecture.md'), '# Architecture\n\nServices are Cordis plugins.\n\n## Seams\n\nThree roles.\n')

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
  const calls: string[] = []
  if (options.registerTools !== false) {
    for (const name of [...DEFAULT_BASE_TOOLS.filter(base => base === 'read' || base === 'bash'), ...HIDDEN]) {
      ctx.tools.register(probeTool(name, calls))
    }
  }
  const fiber = await ctx.plugin(ContextTreeService, config)
  const toolsFiber = await ctx.plugin(ContextTreeTools)
  const session = Session.create(SessionId(`tree-${Math.random().toString(36).slice(2)}`))
  return { ctx, engine, tree: ctx.contextTree, project, home, calls, session, agent: agentOf(session), fiber, toolsFiber, queued: [] }
}

/** Tool declarations of one step, as the loop would resolve them. */
async function declared(w: World): Promise<string[]> {
  const toolSet = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
  return w.ctx.tools.schemas(w.agent, toolSet).map(schema => schema.name)
}

/** Call a tool as the model would and log its deferred contexts like the agent loop does. */
async function call(w: World, name: string, args: Record<string, unknown> = {}, toolSet?: Awaited<ReturnType<Context['tools']['resolve']>>) {
  const set = toolSet ?? await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
  const result = await executeModelToolFixture(w.ctx, {
    agent: w.agent, name, arguments: args, callId: ToolCallId(`call-${Math.random().toString(36).slice(2)}`), signal: SIGNAL, toolSet: set,
  })
  for (const context of result.additionalContexts ?? []) {
    w.session.append('agent/inbox/spliced', { target: 'next-step', start: w.queued.length, inserted: [context] })
    w.queued.push(context)
  }
  return result
}

/** Claim the queued batch and log it, as the next step does before its request. */
function claim(w: World): UserMessage[] {
  const batch = w.queued.splice(0)
  if (batch.length > 0) w.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: batch.length, inserted: [] })
  return batch
}

function enterStep(w: World): void {
  for (const message of claim(w)) w.session.append('user/message', message, { surfaceOp: 'append' })
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('\n')
}

describe('browse', () => {
  it('lists the three roots at depth 1 with a summary each and no bodies', async () => {
    const w = await world()
    const result = await w.tree.browse(w.agent)
    expect(result.nodes.map(node => node.path)).toEqual(['Instructions', 'Sources', 'Tools'])
    expect(result.depth).toBe(1)
    expect(result.depthCapped).toBe(false)
    for (const node of result.nodes) expect(node.summary).toMatch(/^Use /)
    expect(JSON.stringify(result)).not.toContain('Always answer briefly')
  })

  it('lists two levels at depth 2 and caps a deeper request at the configured maximum', async () => {
    const w = await world({ maxBrowseDepth: 2 })
    const two = await w.tree.browse(w.agent, { path: 'Instructions', depth: 2 })
    expect(two.nodes.map(node => node.path)).toEqual([
      'Instructions/Global',
      'Instructions/Global/$DSH_HOME%2FAGENTS.md',
      'Instructions/Project',
      'Instructions/Project/AGENTS.md',
    ])
    const capped = await w.tree.browse(w.agent, { depth: 9 })
    expect(capped.depth).toBe(2)
    expect(capped.depthCapped).toBe(true)
    expect(capped.nodes.every(node => node.path.split('/').length <= 2)).toBe(true)
  })

  it('bounds the rendered listing by nodes and bytes and reports the remainder', async () => {
    const w = await world({ maxBrowseNodes: 3, maxBrowseDepth: 3 })
    const listing = await w.tree.browse(w.agent, { depth: 3 })
    expect(listing.nodes).toHaveLength(3)
    expect(listing.remaining).toBe(listing.total - 3)
    const next = await w.tree.browse(w.agent, { depth: 3, offset: 3 })
    expect(next.nodes[0]!.path).not.toBe(listing.nodes[0]!.path)

    const tiny = await world({ maxBrowseBytes: 320 })
    const text = textOf(await call(tiny, 'context_browse', { depth: 3 }))
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(320)
    expect(text).toContain('more not listed')
  })

  it('rejects an unknown path and a malformed depth with typed errors', async () => {
    const w = await world()
    await expect(w.tree.browse(w.agent, { path: 'Nope' })).rejects.toMatchObject({ code: 'CONTEXT_TREE_INVALID_INPUT' })
    await expect(w.tree.browse(w.agent, { depth: 0 })).rejects.toBeInstanceOf(ContextTreeError)
    await expect(w.tree.browse(w.agent, { offset: -1 })).rejects.toBeInstanceOf(ContextTreeError)
  })

  it('answers identically for the same files and tools in separate worlds', async () => {
    const [a, b] = [await world(), await world()]
    const strip = (value: unknown): string => JSON.stringify(value)
    expect(strip(await a.tree.browse(a.agent, { depth: 3 }))).toBe(strip(await b.tree.browse(b.agent, { depth: 3 })))
  })
})

describe('placement from origin', () => {
  it('puts user-level files under Global and workspace files under Project', async () => {
    const w = await world()
    const global = await w.tree.browse(w.agent, { path: 'Instructions/Global' })
    const project = await w.tree.browse(w.agent, { path: 'Instructions/Project' })
    expect(global.nodes.map(node => node.title)).toEqual(['$DSH_HOME/AGENTS.md'])
    expect(project.nodes.map(node => node.title)).toEqual(['AGENTS.md'])
    const sources = await w.tree.browse(w.agent, { path: 'Sources/Project' })
    expect(sources.nodes.map(node => node.title)).toEqual(['docs/architecture.md'])
  })

  it('places tools by a registered hint, not by their name, and lists the rest as unresolved', async () => {
    const w = await world()
    w.tree.registerToolGroup({ names: ['deploy_run', 'deploy_status'], origin: 'project', group: 'deploy', summary: 'Use when shipping this workspace.' })
    const project = await w.tree.browse(w.agent, { path: 'Tools/Project', depth: 2 })
    expect(project.nodes.map(node => node.path)).toEqual(['Tools/Project/deploy', 'Tools/Project/deploy/deploy_run', 'Tools/Project/deploy/deploy_status'])
    expect(project.nodes[0]!.summary).toBe('Use when shipping this workspace.')
    const global = await w.tree.browse(w.agent, { path: 'Tools/Global', depth: 2 })
    expect(global.nodes.map(node => node.path)).toContain('Tools/Global/mcp-github/mcp__github__list_issues')
    expect(await w.tree.unresolvedToolOrigins(w.agent)).toEqual(['mcp__github__list_issues', 'mcp__github__create_issue', 'lonely'])
  })

  it('places tools by the origin their registration recorded and stops listing them as unresolved', async () => {
    const w = await world()
    w.ctx.tools.register(probeTool('ws_build', w.calls), { origin: 'project' })
    w.ctx.tools.register(probeTool('ws_test', w.calls), { origin: 'project' })
    w.ctx.tools.register(probeTool('user_notes', w.calls), { origin: 'global' })
    w.ctx.tools.register(probeTool('global_a', w.calls), { origin: 'global' })
    const project = await w.tree.browse(w.agent, { path: 'Tools/Project', depth: 2 })
    expect(project.nodes.map(node => node.path)).toEqual(['Tools/Project/ws', 'Tools/Project/ws/ws_build', 'Tools/Project/ws/ws_test'])
    const global = await w.tree.browse(w.agent, { path: 'Tools/Global', depth: 2 })
    expect(global.nodes.map(node => node.path)).toContain('Tools/Global/other/user_notes')
    expect(global.nodes.map(node => node.path)).not.toContain('Tools/Global/ws')
    expect(await w.tree.unresolvedToolOrigins(w.agent)).toEqual(['mcp__github__list_issues', 'mcp__github__create_issue', 'deploy_run', 'deploy_status', 'lonely'])
  })

  it('lets a hint override the recorded origin and keeps an unrecorded origin under Global', async () => {
    const w = await world()
    w.ctx.tools.register(probeTool('ws_build', w.calls), { origin: 'project' })
    w.tree.registerToolGroup({ names: ['ws_build'], origin: 'global', group: 'builders' })
    const global = await w.tree.browse(w.agent, { path: 'Tools/Global/builders', depth: 1 })
    expect(global.nodes.map(node => node.path)).toEqual(['Tools/Global/builders/ws_build'])
    expect((await w.tree.browse(w.agent, { path: 'Tools/Project' })).nodes).toEqual([])
    expect(await w.tree.unresolvedToolOrigins(w.agent)).not.toContain('ws_build')
    expect(await w.tree.unresolvedToolOrigins(w.agent)).toContain('lonely')
  })

  it('groups unhinted tools deterministically and never lists base tools', async () => {
    const w = await world()
    const all = await w.tree.browse(w.agent, { path: 'Tools', depth: 3 })
    const paths = all.nodes.map(node => node.path)
    expect(paths).toContain('Tools/Global/mcp-github')
    expect(paths).toContain('Tools/Global/deploy')
    expect(paths).toContain('Tools/Global/other')
    expect(paths.some(path => path.endsWith('/read') || path.endsWith('/bash'))).toBe(false)
  })

  it('rejects an unusable hint', async () => {
    const w = await world()
    expect(() => w.tree.registerToolGroup({ origin: 'project', group: 'x' })).toThrow(ContextTreeError)
    expect(() => w.tree.registerToolGroup({ names: ['a'], origin: 'project', group: 'a/b' })).toThrow(ContextTreeError)
  })
})

describe('tool admission', () => {
  it('declares base tools and the two context tools and hides everything else', async () => {
    const w = await world()
    expect(await declared(w)).toEqual(['read', 'bash', 'context_browse', 'context_load'])
  })

  it('rejects a call to a hidden tool at dispatch until it is loaded', async () => {
    const w = await world()
    const toolSet = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
    const hidden = await call(w, 'deploy_run', {}, toolSet)
    expect(hidden.isError).toBe(true)
    expect(hidden.error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(w.calls).toEqual([])
    expect((await call(w, 'read', {}, toolSet)).isError).toBe(false)
  })

  it('makes loaded tools callable from the next step, not the current one', async () => {
    const w = await world()
    const first = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
    const loaded = await call(w, 'context_load', { paths: ['Tools/Global/deploy'] }, first)
    expect(loaded.isError).toBe(false)
    expect(textOf(loaded)).toContain('Activated from Tools/Global/deploy: deploy_run, deploy_status')
    expect((await call(w, 'deploy_run', {}, first)).error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(await declared(w)).toEqual(['read', 'bash', 'context_browse', 'context_load', 'deploy_run', 'deploy_status'])
    expect((await call(w, 'deploy_run')).isError).toBe(false)
    expect(w.calls).toEqual(['deploy_run'])
  })

  it('treats several loads in one step as one change and appends them in activation order', async () => {
    const w = await world()
    const first = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
    await Promise.all([
      call(w, 'context_load', { paths: ['Tools/Global/mcp-github/mcp__github__create_issue'] }, first),
      call(w, 'context_load', { paths: ['Tools/Global/deploy', 'Tools/Global/other'] }, first),
    ])
    const names = await declared(w)
    expect(names).toEqual(['read', 'bash', 'context_browse', 'context_load', 'mcp__github__create_issue', 'deploy_run', 'deploy_status', 'lonely'])
    expect([...w.tree.activeTools(w.agent)].sort()).toEqual(['deploy_run', 'deploy_status', 'lonely', 'mcp__github__create_issue'])
  })

  it('declares activated tools after the base set in activation order and leaves the earlier declarations byte-identical', async () => {
    const w = await world()
    const declarations = async (): Promise<string[]> => {
      const toolSet = await w.ctx.tools.resolve({ agent: w.agent, modelSelection: SELECTION, signal: SIGNAL })
      return w.ctx.tools.schemas(w.agent, toolSet).map(schema => JSON.stringify(schema))
    }
    const base = await declarations()
    expect(base.map(entry => (JSON.parse(entry) as { name: string }).name)).toEqual(['read', 'bash', 'context_browse', 'context_load'])

    await call(w, 'context_load', { paths: ['Tools/Global/deploy/deploy_status'] })
    enterStep(w)
    const first = await declarations()
    expect(first.slice(0, base.length)).toEqual(base)

    await call(w, 'context_load', { paths: ['Tools/Global/deploy/deploy_run'] })
    enterStep(w)
    const second = await declarations()
    expect(second.slice(0, first.length)).toEqual(first)
    expect(second.slice(base.length).map(entry => (JSON.parse(entry) as { name: string }).name)).toEqual(['deploy_status', 'deploy_run'])
  })

  it('keeps a tool admitted from the queue through the claim until the logged message takes over', async () => {
    const w = await world()
    await call(w, 'context_load', { paths: ['Tools/Global/deploy'] })
    expect(w.tree.activeTools(w.agent).has('deploy_run')).toBe(true)
    const batch = claim(w)
    expect(batch).toHaveLength(1)
    expect(await declared(w)).toContain('deploy_run')
    for (const message of batch) w.session.append('user/message', message, { surfaceOp: 'append' })
    expect(await declared(w)).toContain('deploy_run')
    expect([...w.tree.activeTools(w.agent)]).toEqual(['deploy_run', 'deploy_status'])
  })

  it('drops an activation the inbox cancelled and one a turn claimed without logging', async () => {
    const w = await world()
    await call(w, 'context_load', { paths: ['Tools/Global/deploy/deploy_run'] })
    w.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    w.queued.splice(0)
    expect(w.tree.activeTools(w.agent).size).toBe(0)

    await call(w, 'context_load', { paths: ['Tools/Global/deploy/deploy_status'] })
    claim(w)
    expect(w.tree.activeTools(w.agent).has('deploy_status')).toBe(true)
    w.session.append('turn/start', { turn: 1 })
    w.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(w.tree.activeTools(w.agent).size).toBe(0)
  })

  it('logs one activation message per load call and none when everything is already active', async () => {
    const w = await world()
    const one = await call(w, 'context_load', { paths: ['Tools/Global/deploy', 'Tools/Global/deploy/deploy_run'] })
    expect(one.additionalContexts).toHaveLength(1)
    const again = await call(w, 'context_load', { paths: ['Tools/Global/deploy'] })
    expect(again.additionalContexts ?? []).toHaveLength(0)
    expect(textOf(again)).toContain('Already callable: deploy_run, deploy_status')
  })

  it('reports unknown paths without failing the call', async () => {
    const w = await world()
    const result = await call(w, 'context_load', { paths: ['Tools/Global/nothing', 'Tools/Global/deploy'] })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('No such node: Tools/Global/nothing')
    expect(w.tree.activeTools(w.agent).has('deploy_run')).toBe(true)
  })

  it('honours a configured base set and always keeps the context tools', async () => {
    const w = await world({ baseTools: ['bash'] })
    expect(await declared(w)).toEqual(['bash', 'context_browse', 'context_load'])
  })

  it('limits activations per load and names what was left out', async () => {
    const w = await world({ maxActivatedTools: 1 })
    const result = await call(w, 'context_load', { paths: ['Tools/Global/deploy'] })
    expect(textOf(result)).toContain('Not activated, per-load limit reached: deploy_status')
    expect([...w.tree.activeTools(w.agent)]).toEqual(['deploy_run'])
  })
})

describe('section grants', () => {
  it('injects the section text as a logged message and reports it', async () => {
    const w = await world()
    const result = await call(w, 'context_load', { paths: ['Instructions/Project/AGENTS.md'] })
    enterStep(w)
    expect(textOf(result)).toContain('Loaded Instructions/Project/AGENTS.md/')
    const logged = w.session.deriveMessages().map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
    expect(logged.some(text => text.includes('<context-grant') && text.includes('Use pnpm.'))).toBe(true)
    expect(logged.some(text => text.includes('Run vitest.'))).toBe(true)
  })

  it('does not load the same unchanged section twice', async () => {
    const w = await world()
    await call(w, 'context_load', { paths: ['Instructions/Global'] })
    enterStep(w)
    const again = await call(w, 'context_load', { paths: ['Instructions/Global'] })
    expect(again.additionalContexts ?? []).toHaveLength(0)
    expect(textOf(again)).toContain('Already in the conversation')
  })

  it('does not grant a section twice when the first load is still queued or claimed but not yet logged', async () => {
    const w = await world()
    await call(w, 'context_load', { paths: ['Instructions/Global'] })
    const queued = await call(w, 'context_load', { paths: ['Instructions/Global'] })
    expect(queued.additionalContexts ?? []).toHaveLength(0)
    expect(textOf(queued)).toContain('Already in the conversation')

    // A step claims the batch; before it logs the messages a third load still sees the grant.
    const batch = w.queued.splice(0)
    w.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: batch.length, inserted: [] })
    const claimed = await call(w, 'context_load', { paths: ['Instructions/Global'] })
    expect(claimed.additionalContexts ?? []).toHaveLength(0)

    // Once the turn ends without logging them, the grant is gone and a load grants again.
    w.session.append('turn/end', { turn: 1, reason: 'completed' } as never)
    const again = await call(w, 'context_load', { paths: ['Instructions/Global'] })
    expect((again.additionalContexts ?? []).length).toBeGreaterThan(0)
  })

  it('cuts a load at the byte budget and says which sections were left for a separate call', async () => {
    const w = await world({ maxLoadBytes: 120 })
    const result = await call(w, 'context_load', { paths: ['Instructions', 'Sources'] })
    const text = textOf(result)
    expect(text).toMatch(/Not loaded, byte budget reached|cut at the load budget/)
  })
})

describe('catalog publication', () => {
  const preStep = (w: World, step: number) => agentEvents(w.ctx, w.agent).waterfall(
    'agent/pre-step', { modelSelection: SELECTION, messages: [], turn: 1, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )

  it('adds one catalog message on the first step and none while it stays in history', async () => {
    const w = await world()
    const first = await preStep(w, 2)
    expect(first.kind).toBe('enter')
    expect(first.kind === 'enter' ? first.messages : []).toHaveLength(1)
    const message = (first.kind === 'enter' ? first.messages : [])[0]!
    expect(message.source.kind).toBe('context-tree-catalog')
    const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('Instructions/Global')
    expect(text).toContain('Tools/Global')
    expect(text).not.toContain('Always answer briefly')
    w.session.append('user/message', message, { surfaceOp: 'append' })
    const second = await preStep(w, 3)
    expect(second.kind === 'enter' ? second.messages : []).toHaveLength(0)
  })

  it('leaves a first step that claims nothing empty', async () => {
    const w = await world()
    const decision = await preStep(w, 1)
    expect(decision.kind === 'enter' ? decision.messages : ['x']).toHaveLength(0)
  })
})

/** Four closed turns; turns 2 and 3 hold the context messages, turn 4 is the retained tail. */
function conversation(session: Session, perTurn: Record<number, readonly UserMessage[]>): { start: SessionSeq; end: SessionSeq } {
  let end = SessionSeq(0)
  for (let turn = 1; turn <= 4; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `${FILLER} user ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    for (const message of perTurn[turn] ?? []) session.append('user/message', message, { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    const reply = session.append('assistant/message', {
      stream: [], turn, step: 1,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: `${FILLER} assistant ${turn}` }], source: { kind: 'model', provider: MODEL, model: MODEL } }),
    }, { surfaceOp: 'append' })
    if (turn === 3) end = reply.seq
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 5 })
  return { start: session.surface.nodes[0]!, end }
}

async function loadedContexts(w: World, paths: readonly string[]): Promise<UserMessage[]> {
  const outcome = await w.tree.load(w.agent, { paths })
  return [...outcome.contexts]
}

function texts(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content).map(block => block.type === 'text' ? block.text : '').join('\n')
}

describe('compaction', () => {
  it('revokes grants and activations, leaves stubs, hides the tools again, and republishes the catalog', async () => {
    const w = await world()
    const catalog = await agentEvents(w.ctx, w.agent).waterfall(
      'agent/pre-step', { modelSelection: SELECTION, messages: [], turn: 1, step: 2, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    const published = catalog.kind === 'enter' ? catalog.messages : []
    const spanMessages = [
      ...published,
      ...await loadedContexts(w, ['Instructions/Project/AGENTS.md', 'Tools/Global/deploy']),
    ]
    const { start, end } = conversation(w.session, { 2: spanMessages })
    expect([...w.tree.activeTools(w.agent)].sort()).toEqual(['deploy_run', 'deploy_status'])
    expect(await declared(w)).toContain('deploy_run')

    await w.engine.compactRegion(start, end, w.agent, SIGNAL)

    expect(w.tree.activeTools(w.agent).size).toBe(0)
    expect(await declared(w)).toEqual(['read', 'bash', 'context_browse', 'context_load'])
    const derived = texts(w.session.deriveMessages())
    expect(derived).not.toContain('Run vitest.')
    expect(derived).not.toContain('<context-activation>')
    expect(derived).toContain('reload with context_load("Instructions/Project/AGENTS.md/')
    expect(derived).toContain('tools no longer callable: deploy_run, deploy_status')

    const republished = await agentEvents(w.ctx, w.agent).waterfall(
      'agent/pre-step', { modelSelection: SELECTION, messages: [], turn: 5, step: 2, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    const again = (republished.kind === 'enter' ? republished.messages : [])[0]
    expect(again?.source.kind).toBe('context-tree-catalog')
    expect(JSON.stringify(again?.source)).toContain('"update":true')
  })

  it('allows loading the same material again after compaction', async () => {
    const w = await world()
    const { start, end } = conversation(w.session, { 2: await loadedContexts(w, ['Tools/Global/deploy', 'Instructions/Project/AGENTS.md']) })
    await w.engine.compactRegion(start, end, w.agent, SIGNAL)
    const reload = await call(w, 'context_load', { paths: ['Tools/Global/deploy', 'Instructions/Project/AGENTS.md'] })
    enterStep(w)
    // Two sections of AGENTS.md plus one activation message.
    expect(reload.additionalContexts).toHaveLength(3)
    expect(await declared(w)).toContain('deploy_run')
    expect(texts(w.session.deriveMessages())).toContain('Run vitest.')
  })

  it('keeps a grant and an activation that sit in the retained tail', async () => {
    const w = await world()
    const { start, end } = conversation(w.session, { 4: await loadedContexts(w, ['Tools/Global/deploy', 'Instructions/Project/AGENTS.md']) })
    await w.engine.compactRegion(start, end, w.agent, SIGNAL)
    expect([...w.tree.activeTools(w.agent)].sort()).toEqual(['deploy_run', 'deploy_status'])
    expect(texts(w.session.deriveMessages())).toContain('Run vitest.')
  })
})

describe('replay', () => {
  it('derives the same activations from the same log in an independent registry', async () => {
    const w = await world()
    await call(w, 'context_load', { paths: ['Tools/Global/deploy', 'Instructions/Global'] })
    enterStep(w)
    const other = new Context()
    contexts.push(other)
    new SessionProjectionRegistry(other)
    const handle = await other.sessionProjections.register(contextTreeProjectionDefinition)
    const own = await w.ctx.sessionProjections.register(contextTreeProjectionDefinition)
    expect(handle.stateOf(w.session)).toEqual(own.stateOf(w.session))
    expect([...handle.stateOf(w.session).activations.flatMap(entry => entry.tools)]).toEqual(['deploy_run', 'deploy_status'])
  })

  it('ignores a message whose source fields are not this plugin\'s', async () => {
    const w = await world()
    w.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'foreign' }],
      source: { kind: 'context-activation', form: 'notice', summary: 'x', key: 'k', nodes: [], tools: 'not-an-array' } as never,
    }), { surfaceOp: 'append' })
    expect(w.tree.activeTools(w.agent).size).toBe(0)
  })
})

describe('disposal', () => {
  it('removes the admission policy, the revocable sources, the hook and the assigners with the service', async () => {
    const w = await world()
    const release = w.tree.registerToolGroup({ names: ['deploy_run'], origin: 'project', group: 'deploy' })
    expect(await declared(w)).not.toContain('deploy_run')
    await w.fiber.dispose()

    expect(await declared(w)).toEqual(['read', 'bash', ...HIDDEN, 'context_browse', 'context_load'].filter(name => name !== 'context_browse' && name !== 'context_load'))
    const decision = await agentEvents(w.ctx, w.agent).waterfall(
      'agent/pre-step', { modelSelection: SELECTION, messages: [], turn: 1, step: 2, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision.kind === 'enter' ? decision.messages : ['x']).toHaveLength(0)
    await release()

    // The kinds can be registered again, so the first registrations were released.
    const again = await w.ctx.plugin(ContextTreeService)
    expect(again).toBeDefined()
  })

  it('removes the model tools with the tools service', async () => {
    const w = await world()
    expect(w.ctx.tools.schemas(w.agent).map(schema => schema.name)).toContain('context_load')
    await w.toolsFiber.dispose()
    const names = w.ctx.tools.schemas(w.agent).map(schema => schema.name)
    expect(names).not.toContain('context_load')
    expect(names).not.toContain('context_browse')
  })

  it('fails loudly on a service used after disposal', async () => {
    const w = await world()
    await w.fiber.dispose()
    await expect(w.tree.browse(w.agent)).rejects.toMatchObject({ code: 'CONTEXT_TREE_DISPOSED' })
  })
})

const sectionId = (n: number) => ContextSectionIdOf(`sec_${n.toString(16).padStart(16, '0')}`)

describe('tree shaping', () => {
  const shape = async (w: World, edit: (sources: readonly ContextSourceMeta[], sections: readonly ContextSectionMeta[]) => {
    sources: ContextSourceMeta[]
    sections: ContextSectionMeta[]
  }, tools: { name: string; description: string; origin?: 'global' | 'project' | 'unknown' }[] = []) => {
    const snapshot = await w.ctx.contextIndex.snapshot({ workingDirectory: w.project })
    const shaped = edit(snapshot.sources, snapshot.sections)
    const tree = buildTree({ ...shaped, tools: tools.map(tool => ({ ...tool, origin: tool.origin ?? 'unknown' })), baseTools: new Set(), assigners: [], maxSummaryBytes: 160 })
    return (path: string[]) => {
      const found = findNode(tree, path)
      return found === undefined ? undefined : viewOf(found)
    }
  }

  it('says where an instruction file applies and counts sections it cannot name', async () => {
    const w = await world()
    const view = await shape(w, (sources, sections) => {
      const project = sources.filter(source => source.kind === 'project-instructions')[0]!
      const nested = { ...project, path: 'packages/app/AGENTS.md' }
      const doc = sources.filter(source => source.kind === 'doc')[0]!
      const unnamed = sections
        .filter(section => section.sourceId === project.id)
        .slice(0, 1)
        .map(section => ({ ...section, headingPath: [], level: 0 }))
      return { sources: [project, nested, doc], sections: unnamed }
    })
    expect(view(['Instructions', 'Project', 'AGENTS.md'])?.summary).toBe('Use for rules that apply at the project root: 1 section')
    expect(view(['Instructions', 'Project', 'packages/app/AGENTS.md'])?.summary).toBe('Use for rules that apply under packages/app: 1 section')
    expect(view(['Sources', 'Project', 'docs/architecture.md'])?.summary).toBe('Use for: 0 sections')
  })

  it('titles intro text and split parts, and names at most four distinct headings of level two or less', async () => {
    const w = await world()
    const view = await shape(w, (sources, sections) => {
      const project = sources.filter(source => source.kind === 'project-instructions')[0]!
      const template = sections.filter(section => section.sourceId === project.id)[0]!
      const make = (id: number, headingPath: string[], level: number, part = 1, partCount = 1): ContextSectionMeta => (
        { ...template, id: sectionId(id), headingPath, level, part, partCount }
      )
      return {
        sources: [project],
        sections: [
          make(1, [], 0),
          make(2, ['One'], 1),
          make(3, ['One'], 2),
          make(4, ['One', 'Deep'], 3),
          make(5, ['Two'], 2, 1, 2),
          make(6, ['Three'], 2),
          make(7, ['Four'], 2),
          make(8, ['Five'], 2),
        ],
      }
    })
    expect(view(['Instructions', 'Project', 'AGENTS.md'])?.summary).toBe('Use for rules that apply at the project root: One; Two; Three; Four')
    expect(view(['Instructions', 'Project', 'AGENTS.md', String(sectionId(1))])?.summary).toContain('"(intro)"')
    expect(view(['Instructions', 'Project', 'AGENTS.md', String(sectionId(5))])?.summary).toContain('"Two [part 1/2]"')
  })

  it('shows a tool without a description as a bare name', async () => {
    const w = await world()
    const view = await shape(w, (sources, sections) => ({ sources: [...sources], sections: [...sections] }), [
      { name: 'solo_a', description: '' },
      { name: 'solo_b', description: 'Second. Detail.' },
      { name: 'zeta', description: 'Alone.' },
    ])
    expect(view(['Tools', 'Global', 'solo', 'solo_a'])?.summary).toBe('')
    expect(view(['Tools', 'Global', 'solo', 'solo_b'])?.summary).toBe('Second.')
    expect(view(['Tools', 'Global', 'other', 'zeta'])?.summary).toBe('Alone.')
  })
})

describe('hints and limits', () => {
  it('covers tools by prefix and carries a title and summary into the tree', async () => {
    const w = await world()
    w.tree.registerToolGroup({ prefix: 'deploy_', origin: 'project', group: 'ship', title: 'Shipping', summary: 'Use to ship.' })
    const project = await w.tree.browse(w.agent, { path: 'Tools/Project/ship', depth: 1 })
    expect(project.nodes.map(node => node.path)).toEqual(['Tools/Project/ship/deploy_run', 'Tools/Project/ship/deploy_status'])
    const parent = await w.tree.browse(w.agent, { path: 'Tools/Project', depth: 1 })
    expect(parent.nodes[0]).toMatchObject({ title: 'Shipping', summary: 'Use to ship.' })
  })

  it('rejects a hint that names nothing', async () => {
    const w = await world()
    expect(() => w.tree.registerToolGroup({ names: [], prefix: '', origin: 'global', group: 'x' })).toThrow(ContextTreeError)
    expect(() => w.tree.registerToolGroup({ names: [], origin: 'global', group: 'x' })).toThrow(ContextTreeError)
  })

  it('ignores an empty prefix next to a name list', async () => {
    const w = await world()
    w.tree.registerToolGroup({ names: ['lonely'], prefix: '', origin: 'project', group: 'solo' })
    const project = await w.tree.browse(w.agent, { path: 'Tools/Project/solo' })
    expect(project.nodes.map(node => node.title)).toEqual(['lonely'])
  })

  it('answers whether a tool is in the base set', async () => {
    const w = await world()
    expect(w.tree.isBaseTool('read')).toBe(true)
    expect(w.tree.isBaseTool('deploy_run')).toBe(false)
  })

  it('refuses a load with no paths or too many paths', async () => {
    const w = await world({ maxLoadPaths: 2 })
    await expect(w.tree.load(w.agent, { paths: [] })).rejects.toThrow(ContextTreeError)
    await expect(w.tree.load(w.agent, { paths: ['a', 'b', 'c'] })).rejects.toThrow(/1 to 2 entries/)
  })

  it('reports empty, malformed, and unknown paths as missing and loads overlapping paths once', async () => {
    const w = await world()
    const outcome = await w.tree.load(w.agent, {
      paths: ['', 'Tools//Global', 'No/Such', 'Instructions/Project', 'Instructions/Project/AGENTS.md', 'Tools/Global/deploy', 'Tools/Global/deploy/deploy_run'],
    })
    expect(outcome.result.missing).toEqual(['', 'Tools//Global', 'No/Such'])
    const paths = outcome.result.granted.map(section => section.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(outcome.result.activated).toEqual([{ path: 'Tools/Global/deploy', tools: ['deploy_run', 'deploy_status'] }])
  })

  it('skips index results it did not ask for and still reports the ones it did', async () => {
    const w = await world()
    const real = await w.ctx.contextIndex.snapshot({ workingDirectory: w.project })
    const section = real.sections[0]!
    const read = await w.ctx.contextIndex.read({ workingDirectory: w.project }, [section.id], { maxBytes: 4096 })
    const stray = sectionId(255)
    vi.spyOn(w.ctx.contextIndex, 'read').mockResolvedValue({
      ...read,
      sections: read.sections.map(body => ({ ...body, id: stray })),
      omitted: [stray],
      missing: [stray],
    })
    const outcome = await w.tree.load(w.agent, { paths: ['Instructions/Project/AGENTS.md'] })
    expect(outcome.result.granted).toEqual([])
    expect(outcome.result.omittedSections).toEqual([stray])
    expect(outcome.result.missing).toEqual([stray])
  })
})

describe('tools without a caller', () => {
  it('browses with every argument and refuses to run without an Agent', async () => {
    const w = await world()
    const browsed = await call(w, 'context_browse', { path: 'Tools', depth: 2, offset: 1 })
    expect(browsed.isError).toBe(false)
    expect(textOf(browsed)).toContain('Context tree at Tools, depth 2')
    expect(textOf(await call(w, 'context_browse', { path: 'Tools' }))).toContain('Context tree at Tools, depth 1')
    const result = await executeModelToolFixture(w.ctx, { name: 'context_browse', arguments: {}, callId: ToolCallId('no-agent'), signal: SIGNAL })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('require a live calling Agent')
  })
})

describe('catalog edge cases', () => {
  const preStep = (w: World, next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }>) => agentEvents(w.ctx, w.agent).waterfall(
    'agent/pre-step', { modelSelection: SELECTION, messages: [], turn: 1, step: 2, signal: SIGNAL }, next,
  )

  it('passes a rejection through untouched', async () => {
    const w = await world()
    expect(await preStep(w, () => Promise.resolve({ kind: 'reject' as const }))).toEqual({ kind: 'reject' })
  })

  it('does not add a second catalog next to one that is already in the step', async () => {
    const w = await world()
    const existing = catalogMessage([{ path: 'Tools/Global', summary: 's' }], false)
    const decision = await preStep(w, () => Promise.resolve({ kind: 'enter' as const, messages: [existing] }))
    expect(decision.kind === 'enter' ? decision.messages : []).toEqual([existing])
  })

  it('publishes nothing when the model cannot call context_browse', async () => {
    const w = await world()
    await w.toolsFiber.dispose()
    const decision = await preStep(w, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    expect(decision.kind === 'enter' ? decision.messages : ['x']).toHaveLength(0)
  })

  it('publishes nothing when the tree has nothing to browse', async () => {
    const w = await world({}, { registerTools: false })
    vi.spyOn(w.ctx.contextIndex, 'snapshot').mockResolvedValue({ sources: [], sections: [], diagnostics: [] } as never)
    const decision = await preStep(w, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    expect(decision.kind === 'enter' ? decision.messages : ['x']).toHaveLength(0)
  })
})

describe('projection edge cases', () => {
  it('ignores queue changes that are not for the next step', async () => {
    const w = await world()
    const [message] = (await w.tree.load(w.agent, { paths: ['Tools/Global/deploy'] })).contexts
    w.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message!] })
    expect(w.tree.activeTools(w.agent).size).toBe(0)
  })

  it('keeps a catalog that sits in the retained tail while grants before it are revoked', async () => {
    const w = await world()
    const published = await agentEvents(w.ctx, w.agent).waterfall(
      'agent/pre-step', { modelSelection: SELECTION, messages: [], turn: 1, step: 2, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    const catalog = published.kind === 'enter' ? published.messages : []
    const { start, end } = conversation(w.session, { 2: await loadedContexts(w, ['Instructions/Project/AGENTS.md']), 4: catalog })
    await w.engine.compactRegion(start, end, w.agent, SIGNAL)
    expect(texts(w.session.deriveMessages())).not.toContain('Run vitest.')
    const decision = await agentEvents(w.ctx, w.agent).waterfall(
      'agent/pre-step', { modelSelection: SELECTION, messages: [], turn: 5, step: 2, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision.kind === 'enter' ? decision.messages : ['x']).toHaveLength(0)
  })
})
