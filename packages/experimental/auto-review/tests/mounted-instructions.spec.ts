/** The mounted strict instruction plugin's output, not a hand-built baseline, reaches the review request. */
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import {
  createMessage, createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import PermissionPresetService, { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as AutoReview from '@deepseek-ai/dsh-experimental-auto-review'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const DENY = '{"risk":"medium","decision":"deny"}'
const ALLOW = '{"risk":"low","decision":"allow"}'

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Answers the worker agent's turns with text and the reviewer's requests with a denial, recording each side.
 * The reviewer runs on the session's own route, so its request is recognized by the environment item it opens with.
 */
class RoutedAdapter extends LlmAdapter {
  readonly worker: GenerateOptions[] = []
  readonly review: GenerateOptions[] = []
  /** Scripted worker responses in order; an exhausted script answers with plain text. */
  readonly workerScript: StreamChunk[][] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const first = options.messages[0]?.content[0]
    if (first?.type === 'text' && first.text.startsWith('ENVIRONMENT\n')) {
      this.review.push(options)
      const pending = options.messages.at(-1)?.content[0]
      // Reading a file is allowed so the touch can project; every other reviewed call is denied.
      const allowed = pending?.type === 'text' && (JSON.parse(pending.text) as { name?: string }).name === 'read'
      yield* textChunks(allowed ? ALLOW : DENY)
      return
    }
    this.worker.push(options)
    yield* this.workerScript.shift() ?? textChunks('noted')
  }
}

const contexts: Context[] = []
const scratch: string[] = []

beforeEach(() => {
  vi.stubEnv('DSH_AGENTS_HOME', '/nonexistent-dsh-agents-home')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** A workspace with a root rule under Commands, a local overlay, a nested rule, a user-global file, and an untouched deeper rule. */
async function workspace(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mounted-review-'))
  const home = await mkdtemp(join(tmpdir(), 'dsh-mounted-review-home-'))
  scratch.push(root, home)
  await mkdir(join(root, '.git'), { recursive: true })
  await write(join(root, 'AGENTS.md'), '# Project\n\n## Commands\n\n- required: run the check before push\n- deny: never force push\n')
  await write(join(root, 'AGENTS.local.md'), 'local overlay: scratch only\n')
  await write(join(root, 'pkg/AGENTS.md'), 'nested: pkg needs the addon\n')
  await write(join(root, 'pkg/deep/AGENTS.md'), 'deep rule: never edit generated files\n')
  await write(join(root, 'pkg/deep/file.txt'), 'hello')
  await write(join(home, 'AGENTS.md'), 'user-global: answer briefly\n')
  vi.stubEnv('DSH_HOME', home)
  return { root, cwd: join(root, 'pkg') }
}

async function mounted() {
  const ctx = new Context()
  contexts.push(ctx)
  const adapter = new RoutedAdapter()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('this test executes no shell request') },
    run() { throw new Error('this test executes no shell request') },
    start() { throw new Error('this test executes no shell request') },
  })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(PermissionPresetService, {
    presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'Workspace write' } },
    defaultPreset: 'workspace-write',
  })
  await ctx.plugin(ToolFs)
  await ctx.plugin(AgentInstructions, { maxBytes: 65536, mode: 'strict' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AutoReview)
  ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'A reviewed operation.', parameters: { path: { type: 'string' } },
    execute: () => Promise.resolve([{ type: 'text', text: 'ran' }]),
  }))
  return { ctx, adapter }
}

/** Entries of one review request: the environment first, then each retained item as JSON, ending at the pending call. */
function reviewedHistory(request: GenerateOptions): { role: string; source: { kind: string }; content: { text?: string }[] }[] {
  const items = request.messages.slice(1).map((message) => {
    const block = message.content[0]
    if (block?.type !== 'text') throw new Error('review item is not text')
    return JSON.parse(block.text) as { kind: string; role: string; source: { kind: string }; content: { text?: string }[] }
  })
  return items.filter(item => item.kind === 'user-message')
}

const constraintText = (history: ReturnType<typeof reviewedHistory>): string =>
  history.filter(item => item.role === 'constraint').flatMap(item => item.content.map(block => block.text ?? '')).join('\n')

/** Log a pending `probe` call on the agent's session and run it through the real review path; the reviewer denies it. */
async function reviewProbe(ctx: Context, agent: Agent, adapter: RoutedAdapter): Promise<GenerateOptions> {
  const { session } = agent
  const turn = 1000 + adapter.review.length
  const callId = ToolCallId(`review-call-${String(adapter.review.length)}`)
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{"path":"target"}' }],
      source: { kind: 'model', provider: 'mock', model: 'worker' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'probe', arguments: '{"path":"target"}' })
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal, callId, name: 'probe', arguments: { path: 'target' }, agent,
  })
  expect(result.isError).toBe(true)
  return adapter.review.at(-1)!
}

async function workerAgent(ctx: Context, cwd: string): Promise<Agent> {
  const agent = await ctx.agentLoop.create(SessionId('mounted-review'), { provider: 'mock', model: 'worker' }, { cwd })
  ctx.permissionPresets.set(agent.session, AUTO_PRESET)
  return agent
}

async function runTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', input: { kind: 'acp' } } }))
  await agent.whenIdle()
}

describe('mounted strict instructions in the review request', () => {
  const RULES = [
    'user-global: answer briefly', 'required: run the check before push', 'deny: never force push',
    'local overlay: scratch only', 'nested: pkg needs the addon',
  ]

  /** Review a denied probe and return the retained user messages the reviewer sees. */
  async function reviewed(ctx: Context, agent: Agent, adapter: RoutedAdapter) {
    return reviewedHistory(await reviewProbe(ctx, agent, adapter))
  }

  it('sends the baseline the mounted plugin loaded, whole, as a constraint beside the direct input', async () => {
    const { cwd } = await workspace()
    const { ctx, adapter } = await mounted()
    const agent = await workerAgent(ctx, cwd)
    await runTurn(agent, 'Please publish.')

    const history = await reviewed(ctx, agent, adapter)
    expect(history.filter(item => item.role === 'user-instruction').map(item => item.content[0]?.text)).toEqual(['Please publish.'])
    const constraints = history.filter(item => item.role === 'constraint')
    expect(constraints.map(item => item.source.kind)).toEqual(['agent-instructions'])
    for (const rule of RULES) expect(constraintText(history)).toContain(rule)
    expect(constraintText(history)).not.toContain('deep rule')
  })

  it('adds a nested rule that a tool touched mid-session as a further constraint, keeping every earlier rule', async () => {
    const { cwd, root } = await workspace()
    const { ctx, adapter } = await mounted()
    const agent = await workerAgent(ctx, cwd)
    await runTurn(agent, 'Please publish.')
    adapter.workerScript.push(
      toolCallResponse('read-deep', 'read', { file_path: join(root, 'pkg/deep/file.txt') }), textChunks('read it'),
    )
    await runTurn(agent, 'Read the deep file.')

    const history = await reviewed(ctx, agent, adapter)
    const constraints = history.filter(item => item.role === 'constraint')
    expect(constraints.length).toBeGreaterThanOrEqual(2)
    expect(constraints.every(item => item.source.kind === 'agent-instructions')).toBe(true)
    for (const rule of [...RULES, 'deep rule: never edit generated files']) expect(constraintText(history)).toContain(rule)
    // The reviewed read itself passed review, so the update followed a real tool result.
    expect(adapter.review.length).toBe(2)
  })

  it('restores the complete baseline as a constraint after compaction replaced the conversation', async () => {
    const { cwd, root } = await workspace()
    const { ctx, adapter } = await mounted()
    const agent = await workerAgent(ctx, cwd)
    await runTurn(agent, 'Please publish.')
    adapter.workerScript.push(
      toolCallResponse('read-deep', 'read', { file_path: join(root, 'pkg/deep/file.txt') }), textChunks('read it'),
    )
    await runTurn(agent, 'Read the deep file.')
    const nodes = [...agent.session.surface.nodes]
    const first = nodes.find(seq => agent.session.eventAt(seq)?.type === 'user/message')!
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint summary' }], source: compactCheckpointSource(CompactionId('mounted-1')),
    }), { surfaceOp: { op: 'replace', startSeq: first, endSeq: nodes.at(-1)! }, sourceEventSeqs: nodes.filter(seq => seq >= first) })
    await runTurn(agent, 'After compaction.')

    const history = await reviewed(ctx, agent, adapter)
    expect(history.map(item => item.role)).toEqual(expect.arrayContaining(['checkpoint', 'user-instruction', 'constraint']))
    // Compaction replaced the earlier task text; only the checkpoint and the new input remain, and the rules come back whole.
    expect(history.filter(item => item.role === 'user-instruction').map(item => item.content[0]?.text)).toEqual(['After compaction.'])
    for (const rule of RULES) expect(constraintText(history)).toContain(rule)
  })
})
