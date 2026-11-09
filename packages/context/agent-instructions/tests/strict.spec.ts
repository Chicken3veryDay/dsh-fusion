import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture, mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Config as AgentInstructionsConfig } from '@deepseek-ai/dsh-agent-instructions'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import { AgentInstructionsError, loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { resolveConfig } from '../src/config.ts'
import { renderInstructionChanges, renderStrictInstructionSet, renderAgentInstructionSet } from '../src/render.ts'

const signal = new AbortController().signal
const loopCtx = new Context()
provideWorkingDirectoryFixture(loopCtx)
await mountAgentLoopTestDependencies(loopCtx)
const loop = await mountAgentLoopTestHarness(loopCtx)
let nextSession = 1
const absentAgentsHome = await mkdtemp(join(tmpdir(), 'dsh-strict-absent-agents-'))
const scratch: string[] = []

beforeEach(() => {
  vi.stubEnv('DSH_AGENTS_HOME', absentAgentsHome)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
})
afterAll(async () => {
  await loopCtx.fiber.dispose()
  await rm(absentAgentsHome, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-strict-instructions-'))
  scratch.push(dir)
  return dir
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** A project with a root rule, a rule nested under a Commands heading, a local overlay, and a user-global file. */
async function workspaceFixture(): Promise<{ root: string; home: string }> {
  const root = await tempDir()
  const home = await tempDir()
  await mkdir(join(root, '.git'), { recursive: true })
  await write(join(root, 'AGENTS.md'), '# Project\n\nroot rule: keep diffs small\n\n## Commands\n\n- required: run pnpm check before push\n- deny: never run rm -rf /\n')
  await write(join(root, 'AGENTS.local.md'), 'local overlay rule: use scratch dirs\n')
  await write(join(root, 'pkg/AGENTS.md'), 'nested rule: pkg tests need the native addon\n')
  await write(join(home, 'AGENTS.md'), 'user-global rule: answer briefly\n')
  vi.stubEnv('DSH_HOME', home)
  return { root, home }
}

function load(root: string, options: { maxBytes: number; maxSourceBytes?: number; strict?: boolean; cwd?: string }) {
  return loadBaselineInstructions({
    cwd: options.cwd ?? join(root, 'pkg'),
    maxBytes: options.maxBytes,
    ...options.maxSourceBytes === undefined ? {} : { maxSourceBytes: options.maxSourceBytes },
    ...options.strict === undefined ? {} : { strict: options.strict },
  })
}

describe('strict workspace instruction loading', () => {
  it('keeps a restriction under Commands, root, nested, user-global, and local overlay rules in full', async () => {
    const { root } = await workspaceFixture()
    const rendered = await load(root, { maxBytes: 65536, strict: true })
    expect(rendered?.omitted).toEqual([])
    expect(rendered?.truncated).toEqual([])
    for (const rule of [
      'required: run pnpm check before push',
      'deny: never run rm -rf /',
      'root rule: keep diffs small',
      'local overlay rule: use scratch dirs',
      'user-global rule: answer briefly',
    ]) expect(rendered?.text).toContain(rule)
  })

  it('refuses before dispatch when a last-position denial rule does not fit a tiny cap, where legacy mode drops it', async () => {
    const { root } = await workspaceFixture()
    await write(join(root, 'pkg/AGENTS.md'), `${'filler line\n'.repeat(200)}deny: never push to main\n`)
    const legacy = await load(root, { maxBytes: 600 })
    expect(legacy?.text).not.toContain('deny: never push to main')
    expect(legacy?.truncated.length).toBeGreaterThan(0)
    const failure = await load(root, { maxBytes: 600, strict: true }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AgentInstructionsError)
    expect((failure as AgentInstructionsError).code).toBe('AGENT_INSTRUCTIONS_BUDGET_EXCEEDED')
    expect((failure as AgentInstructionsError).message).toMatch(/project chain need \d+ bytes .* maxBytes is 600/)
  })

  it('fits exactly at the complete-frame size, counting UTF-8 multibyte bytes, and refuses one byte less', async () => {
    const root = await tempDir()
    vi.stubEnv('DSH_HOME', await tempDir())
    await mkdir(join(root, '.git'), { recursive: true })
    await write(join(root, 'AGENTS.md'), '规则：禁止删除生产数据库 — 永远 🚫\n')
    const files = [{ absolutePath: join(root, 'AGENTS.md'), displayPath: 'AGENTS.md', content: '规则：禁止删除生产数据库 — 永远 🚫\n' }]
    const exact = Buffer.byteLength(renderStrictInstructionSet(files, { maxBytes: 1_000_000 }).rendered.text, 'utf8')
    const fitted = await load(root, { cwd: root, maxBytes: exact, strict: true })
    expect(fitted?.text).toContain('禁止删除生产数据库')
    const failure = await load(root, { cwd: root, maxBytes: exact - 1, strict: true }).catch((error: unknown) => error)
    expect((failure as AgentInstructionsError).code).toBe('AGENT_INSTRUCTIONS_BUDGET_EXCEEDED')
    const legacy = renderAgentInstructionSet(files, { maxBytes: exact - 1 }).rendered
    expect(legacy.truncated.length + legacy.omitted.length).toBeGreaterThan(0)
  })

  it('refuses a discovered source above maxSourceBytes, where legacy mode ignores it', async () => {
    const { root } = await workspaceFixture()
    await write(join(root, 'pkg/AGENTS.md'), `${'x'.repeat(500)}\ndeny: last line\n`)
    const legacy = await load(root, { maxBytes: 65536, maxSourceBytes: 200 })
    expect(legacy?.text).not.toContain('nested')
    const failure = await load(root, { maxBytes: 65536, maxSourceBytes: 200, strict: true }).catch((error: unknown) => error)
    expect((failure as AgentInstructionsError).code).toBe('AGENT_INSTRUCTIONS_SOURCE_TOO_LARGE')
    expect((failure as AgentInstructionsError).message).toContain(join(root, 'pkg/AGENTS.md'))
  })

  it('refuses a discovered file that cannot be read', async () => {
    const { root } = await workspaceFixture()
    await chmod(join(root, 'pkg/AGENTS.md'), 0o000)
    try {
      const legacy = await load(root, { maxBytes: 65536 })
      expect(legacy?.text).not.toContain('nested rule')
      const failure = await load(root, { maxBytes: 65536, strict: true }).catch((error: unknown) => error)
      expect((failure as AgentInstructionsError).code).toBe('AGENT_INSTRUCTIONS_SOURCE_UNREADABLE')
    } finally {
      await chmod(join(root, 'pkg/AGENTS.md'), 0o644)
    }
  })

  it('treats missing candidate files as normal and loads nothing without error', async () => {
    const root = await tempDir()
    vi.stubEnv('DSH_HOME', await tempDir())
    await mkdir(join(root, '.git'), { recursive: true })
    expect(await load(root, { cwd: root, maxBytes: 65536, strict: true })).toBeUndefined()
  })

  it('refuses a dynamic change batch that does not fit, where legacy mode omits the transition', () => {
    const items = [{
      change: { action: 'set' as const, scope: 'pkg', path: 'pkg/AGENTS.md', digest: 'd' },
      file: { absolutePath: '/repo/pkg/AGENTS.md', displayPath: 'pkg/AGENTS.md', content: 'deny: '.padEnd(2000, 'x') },
    }]
    expect(renderInstructionChanges(items, 300).changes).toEqual([])
    expect(() => renderInstructionChanges(items, 300, true)).toThrow(AgentInstructionsError)
    expect(renderInstructionChanges(items, 100_000, true).changes).toHaveLength(1)
  })

  it('rejects strict mode with a disabled budget at configuration', () => {
    expect(() => resolveConfig({ maxBytes: 0, mode: 'strict' })).toThrow(/positive finite maxBytes/)
    expect(() => resolveConfig({ maxBytes: Number.POSITIVE_INFINITY, mode: 'strict' })).toThrow(/positive finite maxBytes/)
    expect(resolveConfig({ maxBytes: 0 }).mode).toBe('legacy')
  })
})

async function mountStrict(ctx: Context, config: AgentInstructionsConfig): Promise<void> {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ToolFs)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentInstructions, config)
}

async function strictAgent(cwd: string): Promise<Agent> {
  const agent = await loop.create(SessionId(`strict-instructions-${String(nextSession++)}`), {}, { cwd })
  agent.session.append('session/end-seed', {})
  return agent
}

function preStep(ctx: Context, agent: Agent) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { modelSelection: { provider: 'mock', model: 'mock' }, messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

describe('strict instruction loading in a mounted plugin', () => {
  it('stops the first request before dispatch when a baseline rule cannot fit', async () => {
    const { root } = await workspaceFixture()
    const ctx = new Context()
    await mountStrict(ctx, { maxBytes: 200, mode: 'strict' })
    const agent = await strictAgent(root)
    const failure = await preStep(ctx, agent).catch((error: unknown) => error)
    expect((failure as AgentInstructionsError).code).toBe('AGENT_INSTRUCTIONS_BUDGET_EXCEEDED')
    expect(agent.inbox.nextStep).toEqual([])
    await ctx.fiber.dispose()
  })

  it('stops the next request after an asynchronous touch failure, retries it, and delivers the rule once fixed', async () => {
    const { root } = await workspaceFixture()
    const ctx = new Context()
    await mountStrict(ctx, { maxBytes: 65536, mode: 'strict', maxSourceBytes: 400 })
    const agent = await strictAgent(root)
    await preStep(ctx, agent)
    agent.inbox.remove(agent.inbox.nextStep[0]!.id)
    const nested = join(root, 'pkg/deep/AGENTS.md')
    await write(nested, `${'y'.repeat(600)}\n`)
    await write(join(root, 'pkg/deep/file.txt'), 'hello')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId('read-deep'),
      name: 'read',
      arguments: { file_path: join(root, 'pkg/deep/file.txt') },
      agent,
    })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    const failure = await preStep(ctx, agent).catch((error: unknown) => error)
    expect((failure as AgentInstructionsError).code).toBe('AGENT_INSTRUCTIONS_SOURCE_TOO_LARGE')
    // The failure persists until the rule can be represented.
    expect(await preStep(ctx, agent).catch((error: unknown) => error)).toBeInstanceOf(AgentInstructionsError)
    await write(nested, 'deep rule: fixed\n')
    const decision = await preStep(ctx, agent)
    expect(decision.kind).toBe('enter')
    expect(JSON.stringify(agent.inbox.nextStep.map(message => message.content))).toContain('deep rule: fixed')
    await ctx.fiber.dispose()
  })
})
