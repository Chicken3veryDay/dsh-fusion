/** Catalog and eager-core republication through `system-prompt/request-context`. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ContextTree, { ContextTreeTools } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

const CORE_RULE = 'Never print secret values R5CORE.'

async function setup() {
  const adapter = new WindowMockAdapter([textResponse('first'), textResponse('second')])
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
  const agent = await ctx.agentLoop.create(SessionId('r5-request-context'), { provider: 'mock', model: 'model' })
  ctx.on('llm/stream', (request, next) => {
    // Control: everything sent replays from the Session log.
    expect(request.messages).toEqual(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages())
    return next()
  })
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'dsh-r5-request-context-'))
  roots.push(root)
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'AGENTS.md'), `# Safety\n\n${CORE_RULE}\n`)
  vi.stubEnv('DSH_HOME', join(root, 'empty-home'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'empty-agents'))
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SummaryEngine, { auto: true, thresholdRatio: 0.5, retainTokens: 1, headroomTokens: 0, maxTokens: 128 })
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ContextIndex)
  await ctx.plugin(FixedDirectory, { path: root })
  await ctx.plugin(ContextTree)
  await ctx.plugin(ContextTreeTools)
  const snapshot = await ctx.contextIndex.snapshot({ workingDirectory: root })
  const core = snapshot.sections.map(section => section.id)
  expect(core.length).toBeGreaterThan(0)
  ctx.contextTree.registerEagerCore(() => core)
  return { ctx, agent, adapter, core }
}

function catalogsIn(
  messages: readonly { readonly source?: { readonly kind?: string }; readonly content: readonly unknown[] }[] | undefined,
): string[] {
  return (messages ?? [])
    .filter(message => message.source?.kind === 'context-tree-catalog')
    .map(message => JSON.stringify(message.content))
}

it('R5-m1 the catalog republished after compaction does not call the eager core dropped while the same request grants it again', async () => {
  const { agent, adapter, core } = await setup()
  await send(agent, 'context '.repeat(5000))
  agent.model.select({ provider: 'mock', model: 'small' })
  await send(agent, 'next task')
  const sent = adapter.requests.at(-1)?.messages
  const text = JSON.stringify(sent)
  // Preconditions: compaction ran, and the request carries both the core rule and a republished catalog.
  expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/end')).toHaveLength(1)
  expect({ core: text.includes(CORE_RULE), catalogs: catalogsIn(sent).length }).toEqual({ core: true, catalogs: 1 })
  const catalog = catalogsIn(sent)[0] ?? ''
  expect(catalog, 'the core section is in this same request, so it was not dropped').not.toContain(core[0])
})

it('R5-m2 one request carries one catalog when the step adds a catalog and request preparation compacts', async () => {
  const { ctx, agent, adapter } = await setup()
  await send(agent, 'context '.repeat(5000))
  // A new extra tool adds a Tools/Global branch, so the next pre-step publishes a new catalog.
  ctx.tools.register(defineTool({
    name: 'deploy_run', description: 'Deploy the service.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'done',
  }))
  agent.model.select({ provider: 'mock', model: 'small' })
  await send(agent, 'next task')
  const sent = adapter.requests.at(-1)?.messages
  expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/end')).toHaveLength(1)
  expect(catalogsIn(sent).length, `the request carries ${catalogsIn(sent).length} catalogs:\n${catalogsIn(sent).join('\n---\n')}`).toBe(1)
})
