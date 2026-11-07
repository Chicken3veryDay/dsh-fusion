/** Shared world for the project map specs: real agents, sessions, index, tree, and subagent spawn over scripted models. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ContextIndexService from '@deepseek-ai/dsh-experimental-context-index'
import type { ContextSectionId, ContextSectionMeta } from '@deepseek-ai/dsh-experimental-context-index/types'
import ContextTreeService, { ContextTreeTools } from '@deepseek-ai/dsh-experimental-context-tree'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ReasoningEffortId, ToolCallId, type LlmModelInfo, type LlmResolvedModelInfo, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ContextMapService, { ContextMapTools, DefaultContextCurator, type Config, type CuratorConfig } from '../src/index.ts'

export const SIGNAL = new AbortController().signal

/** Catalog of the test provider: one big model the owner runs on, one small one, one too small to curate. */
export const MODELS: Readonly<Record<string, { window: number; efforts: readonly string[]; defaultEffort: string }>> = {
  big: { window: 200_000, efforts: ['low', 'high'], defaultEffort: 'high' },
  small: { window: 40_000, efforts: ['low', 'high'], defaultEffort: 'high' },
  tiny: { window: 8_000, efforts: ['low'], defaultEffort: 'low' },
}

type Script = ConstructorParameters<typeof MockAdapter>[0]

/** Scripted adapter that also advertises {@link MODELS}. */
export class CatalogAdapter extends MockAdapter {
  constructor(script: Script, private readonly models: typeof MODELS = MODELS) {
    super(script)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(Object.keys(this.models).map(id => ({ provider, id, name: id })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.models[model]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...entry === undefined ? {} : {
        context: { contextWindow: entry.window },
        reasoning: {
          efforts: entry.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
          defaultEffort: ReasoningEffortId(entry.defaultEffort),
        },
      },
    })
  }
}

/** Working directory stand-in answering one fixed project root for every agent. */
class FixedWorkingDirectory extends Service {
  constructor(ctx: Context, private readonly root: { path: string }) {
    super(ctx, 'workingDirectory')
  }

  get(): string { return this.root.path }

  ensure(): Promise<string> { return Promise.resolve(this.root.path) }

  set(): Promise<string> { return Promise.resolve(this.root.path) }
}

const contexts: Context[] = []
const directories: string[] = []

/** Dispose every world made since the last call. */
export async function disposeWorlds(): Promise<void> {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Everything one spec needs. */
export interface World {
  readonly ctx: Context
  readonly owner: Agent
  readonly project: string
  readonly adapter: CatalogAdapter
  readonly home: string
  /** Create another live root agent, such as a future assistant that claims the role. */
  readonly spawnRoot: (name: string) => Promise<Agent>
  /** Dispose one agent made by {@link spawnRoot}. */
  readonly disposeRoot: (agent: Agent) => Promise<void>
  readonly sections: () => Promise<readonly ContextSectionMeta[]>
  readonly projectSections: () => Promise<ContextSectionId[]>
  readonly curatorFiber: { dispose(): Promise<void> } | undefined
  /** Write a project file; the next index read sees it. */
  readonly write: (relative: string, content: string) => void
}

/** Options for {@link world}. */
export interface WorldOptions {
  readonly map?: Config
  /** Mount the default curator with this configuration; omit for a world with no automatic curator. */
  readonly curator?: CuratorConfig
  /** Script of the test provider; entries are consumed by whichever agent calls the model first. */
  readonly script?: Script
  readonly ownerModel?: string
  readonly models?: typeof MODELS
  /** Subagent activation capacity; omit for the shipped default. */
  readonly maxActiveSubagents?: number
}

/**
 * Build a world: a root agent, the project files, the context tree, the map, and optionally the default curator.
 * @param options - map and curator configuration and the model script.
 * @returns the world; dispose with {@link disposeWorlds}.
 */
export async function world(options: WorldOptions = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-map-')))
  directories.push(root)
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'agents-home'))
  const write = (relative: string, content: string): void => {
    const path = join(project, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  writeFileSync(join(home, 'AGENTS.md'), '# Personal\n\nAlways answer briefly.\n')
  write('AGENTS.md', '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest.\n')
  write('docs/architecture.md', '# Architecture\n\nServices are Cordis plugins.\n\n## Seams\n\nThree roles.\n')

  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  void new TokenMeter(ctx)
  void new BasicCompactionEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 8192 })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(FixedWorkingDirectory, { path: project })
  await ctx.plugin(ContextIndexService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents, options.maxActiveSubagents === undefined ? {} : { maxActiveSubagents: options.maxActiveSubagents })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(ContextTreeService)
  await ctx.plugin(ContextTreeTools)
  await ctx.plugin(ContextMapService, options.map ?? {})
  await ctx.plugin(ContextMapTools)
  const curatorFiber = options.curator === undefined ? undefined : await ctx.plugin(DefaultContextCurator, options.curator)
  const adapter = new CatalogAdapter(options.script ?? [], options.models ?? MODELS)
  ctx.llm.registerAdapter(['mock'], adapter)
  const owner = (await ctx.agents.create({
    sessionId: SessionId('owner'),
    agentOptions: { provider: 'mock', model: options.ownerModel ?? 'big' },
  })).agent
  const handles = new Map<Agent, { dispose(): Promise<void> }>()
  const sections = async (): Promise<readonly ContextSectionMeta[]> => {
    return (await ctx.contextIndex.snapshot({ workingDirectory: project })).sections
  }
  return {
    ctx, owner, project, adapter, home, curatorFiber, write, sections,
    projectSections: async () => (await sections()).filter(section => section.kind === 'project-instructions').map(section => section.id),
    spawnRoot: async (name) => {
      const handle = await ctx.agents.create({ sessionId: SessionId(name), agentOptions: { provider: 'mock', model: 'big' } })
      handles.set(handle.agent, handle)
      return handle.agent
    },
    disposeRoot: async (agent) => { await handles.get(agent)?.dispose() },
  }
}

/** Run the pre-step hooks of an agent the way the loop would before a request. */
export async function preStep(ctx: Context, agent: Agent, turn = 1, step = 2): Promise<UserMessage[]> {
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { modelSelection: { provider: 'mock', model: 'big' }, messages: [], turn, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  return decision.kind === 'enter' ? decision.messages : []
}

/** Call a tool as the model would, with the set resolved now unless one is given. */
export async function call(
  w: World,
  agent: Agent,
  name: string,
  args: Record<string, unknown> = {},
  toolSet?: Awaited<ReturnType<Context['tools']['resolve']>>,
) {
  const set = toolSet ?? await w.ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'big' }, signal: SIGNAL })
  return executeModelToolFixture(w.ctx, {
    agent, name, arguments: args, callId: ToolCallId(`call-${Math.random().toString(36).slice(2)}`), signal: SIGNAL, toolSet: set,
  })
}

/** Names of the tools an agent is offered for its next step. */
export async function declared(w: World, agent: Agent): Promise<string[]> {
  const set = await w.ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'big' }, signal: SIGNAL })
  return w.ctx.tools.schemas(agent, set).map(schema => schema.name)
}

/** Text of a tool result. */
export function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('\n')
}

/** Logged events of a session after its pending writes are flushed. */
export async function logged(ctx: Context, id: SessionId): Promise<{ type: string; data: unknown }[]> {
  const session: Session | undefined = ctx.sessions.get(id)
  if (session !== undefined) await ctx.sessions.flush(session)
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try { return [...(await handle.read(0)).events] } finally { await handle.close() }
}

/** Observe provider entry without imposing a shorter deadline than the test lane. */
export function requestsOf(w: World): (count: number) => Promise<void> {
  const pending = new Map<number, PromiseWithResolvers<undefined>>()
  const stream = w.adapter.stream.bind(w.adapter)
  const settle = (): void => {
    for (const [count, barrier] of pending) if (w.adapter.requests.length >= count) barrier.resolve(undefined)
  }
  vi.spyOn(w.adapter, 'stream').mockImplementation(async function* (options) {
    // A failing model never yields a chunk; the request still reached the provider.
    try {
      for await (const chunk of stream(options)) {
        settle()
        yield chunk
      }
    } finally { settle() }
  })
  return (count) => {
    if (w.adapter.requests.length >= count) return Promise.resolve()
    const barrier = pending.get(count) ?? Promise.withResolvers<undefined>()
    pending.set(count, barrier)
    return barrier.promise
  }
}
