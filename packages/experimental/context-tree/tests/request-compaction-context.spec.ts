/** Request-time compaction must preserve the eager core and catalog. */
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
import LlmRuntime, { createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
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

const CORE_RULE = 'Never print secret values R4CORE.'

it.each(['switch', 'overflow'] as const)(
  'R4-M1 the request sent after %s compaction still carries the eager core and the catalog',
  async (mode) => {
    const adapter = new WindowMockAdapter([
      textResponse('first'),
      ...(mode === 'overflow' ? [[{ type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'context full' } } }]] : []),
      textResponse('second'),
    ])
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
    const agent = await ctx.agentLoop.create(SessionId('r4-request-compaction'), { provider: 'mock', model: 'model' })
    const root = mkdtempSync(join(tmpdir(), 'dsh-r4-core-'))
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

    await send(agent, 'context '.repeat(5000))
    const first = JSON.stringify(adapter.requests[0]?.messages)
    // Control: the first request carries the core rule and the catalog.
    expect({ core: first.includes(CORE_RULE), catalog: first.includes('<context_tree>') }).toEqual({ core: true, catalog: true })

    if (mode === 'switch') agent.model.select({ provider: 'mock', model: 'small' })
    await send(agent, 'next task')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/end').map(event => event.data.error)).toEqual([undefined])
    const after = adapter.requests.at(-1)
    const text = JSON.stringify(after?.messages)
    expect({ core: text.includes(CORE_RULE), catalog: text.includes('<context_tree>') }, 'the always-on core and the catalog are re-published after compaction').toEqual({ core: true, catalog: true })
  },
)
