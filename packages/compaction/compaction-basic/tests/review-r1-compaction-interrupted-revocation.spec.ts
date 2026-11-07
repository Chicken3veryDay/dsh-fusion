import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import ContextIndex from '@deepseek-ai/dsh-experimental-context-index'
import ContextTree from '@deepseek-ai/dsh-experimental-context-tree'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { contextTreeProjectionDefinition } from '../../../experimental/context-tree/src/projection.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
class Adapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 100_000 } }
  }
  override async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}
class Engine extends BasicCompactionEngine {
  protected override async summarize(_input: SummarizationInput): ReturnType<BasicCompactionEngine['summarize']> {
    return { summary: [{ type: 'text', text: 'checkpoint' }], provider: 'test', model: 'summary' }
  }
}
class Directory extends Service {
  constructor(ctx: Context, private readonly config: { path: string }) { super(ctx, 'workingDirectory') }
  async ensure(): Promise<string> { return this.config.path }
}
function agent(session: Session): Agent { return { session, options: {}, id: session.id } as Agent }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-compaction-'))
  roots.push(root)
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, 'AGENTS.md'), '# Project\n\nUse pnpm.\n')
  vi.stubEnv('DSH_HOME', join(root, 'empty-home'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'empty-agents'))
  const ctx = new Context()
  contexts.push(ctx)
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter(['test'], new Adapter())
  const engine = new Engine(ctx, { auto: false, headroomTokens: 0, maxTokens: 128 })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ContextIndex)
  await ctx.plugin(Directory, { path: root })
  ctx.tools.register(defineTool({ name: 'probe', description: 'Probe.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: async () => 'ok',
  }))
  await ctx.plugin(ContextTree)
  const session = Session.create(SessionId('interrupted-compaction'))
  const owner = agent(session)
  session.append('turn/start', { turn: 1 })
  const first = session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'history '.repeat(1000) }],
  }), { surfaceOp: 'append' })
  const loaded = await ctx.contextTree.load(owner, { paths: ['Tools', 'Instructions/Project/AGENTS.md'] })
  expect(loaded.contexts.some(message => message.source.kind === 'context-grant')).toBe(true)
  for (const message of loaded.contexts) session.append('user/message', message, { surfaceOp: 'append' })
  const last = session.surface.nodes.at(-1)!
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'test', model: 'test' } }, reason: 'initial' })
  session.append('step/end', { turn: 1, step: 1 })
  expect([...ctx.contextTree.activeTools(owner)]).toEqual(['probe'])
  await engine.compactRegion(first.seq, last, owner)
  const events = JSON.parse(JSON.stringify(session.snapshotEvents())) as SessionEvent[]
  const summaryIndex = events.findIndex(event => event.type === 'compaction/summary')
  expect(summaryIndex).toBeGreaterThan(0)
  return { ctx, events, summaryIndex, loaded }
}
it('control: a committed replacement removes the activation', async () => {
  const { ctx, events } = await fixture()
  const replayed = Session.create(SessionId('complete'), events)
  expect([...ctx.contextTree.activeTools(agent(replayed))]).toEqual([])
  expect(replayed.deriveMessages().some(message => message.source.kind === 'context-activation')).toBe(false)
})
it('keeps a still-visible activation when restart recovers only through compaction/summary', async () => {
  const { ctx, events, summaryIndex } = await fixture()
  const replayed = Session.create(SessionId('interrupted'), events.slice(0, summaryIndex + 1))
  expect(replayed.deriveMessages().some(message => message.source.kind === 'context-activation')).toBe(true)
  const owner = agent(replayed)
  const selected = await ctx.tools.resolve({ agent: owner, modelSelection: { provider: 'test', model: 'test' }, signal: new AbortController().signal })
  try {
    expect({ active: [...ctx.contextTree.activeTools(owner)], declarations: ctx.tools.schemas(owner, selected).map(tool => tool.name) })
      .toEqual({ active: ['probe'], declarations: ['probe'] })
  } finally {
    selected.dispose()
  }
})
it('keeps a still-visible section held when restart recovers only through compaction/summary', async () => {
  const { ctx, events, summaryIndex } = await fixture()
  const replayed = Session.create(SessionId('interrupted-grant'), events.slice(0, summaryIndex + 1))
  expect(replayed.deriveMessages().some(message => message.source.kind === 'context-grant')).toBe(true)
  const result = await ctx.contextTree.load(agent(replayed), { paths: ['Instructions/Project/AGENTS.md'] })
  expect(result.contexts.filter(message => message.source.kind === 'context-grant')).toEqual([])
})

it('keeps grants, declarations, and dropped-section state when the replacement is rejected', async () => {
  const { ctx, events, summaryIndex } = await fixture()
  const summary = events[summaryIndex]!
  const replacement = events[summaryIndex + 1]!
  if (summary.type !== 'compaction/summary' || replacement.type !== 'user/message') throw new Error('missing compaction pair')
  const replayed = Session.create(SessionId('rejected-replacement'), events.slice(0, summaryIndex + 1))
  const owner = agent(replayed)
  const before = replayed.surface.nodes
  const handle = await ctx.sessionProjections.register(contextTreeProjectionDefinition)
  const prefix = events.slice(0, summaryIndex + 1).reduce<ReturnType<typeof contextTreeProjectionDefinition.apply>>(
    (state, event) => contextTreeProjectionDefinition.apply(state, event),
    contextTreeProjectionDefinition.init(),
  )
  const pending = contextTreeProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(prefix)))
  // The summary seq is log-only, so Session must reject it as a replacement endpoint.
  expect(() => replayed.append('user/message', replacement.data, {
    surfaceOp: { op: 'replace', startSeq: summary.data.shadowedRange.start, endSeq: summary.seq },
    sourceEventSeqs: [summary.seq, ...summary.data.shadowedSeqs],
  })).toThrow()
  expect(replayed.surface.nodes).toEqual(before)
  const selected = await ctx.tools.resolve({ agent: owner, modelSelection: { provider: 'test', model: 'test' }, signal: new AbortController().signal })
  try {
    expect([...ctx.contextTree.activeTools(owner)]).toEqual(['probe'])
    expect(ctx.tools.schemas(owner, selected).map(tool => tool.name)).toEqual(['probe'])
  } finally { selected.dispose() }
  const loaded = await ctx.contextTree.load(owner, { paths: ['Instructions/Project/AGENTS.md'] })
  expect(loaded.contexts.filter(message => message.source.kind === 'context-grant')).toEqual([])
  expect(handle.stateOf(replayed).dropped).toEqual([])
  expect(pending.dropped).toEqual([])
  expect(pending.pendingCompaction).not.toBeNull()
  expect(ctx.sessionProjections.restoreFloor({ contextTree: { ver: 5, seq: summary.seq, val: pending } })).toBe(0)
  expect(replacement.surfaceOp).toMatchObject({ op: 'replace' })
  const committed = contextTreeProjectionDefinition.apply(pending, replacement)
  expect(committed.activations).toEqual([])
  expect(committed.grants).toEqual([])
  expect(committed.dropped.length).toBeGreaterThan(0)
  expect(committed).toEqual(handle.stateOf(Session.create(SessionId('complete-checkpoint'), events.slice(0, summaryIndex + 2))))
})
