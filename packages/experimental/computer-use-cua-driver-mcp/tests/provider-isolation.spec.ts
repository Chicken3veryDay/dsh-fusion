/** The desktop facade runs only the Cua Driver MCP server's own registrations, past admission policies, under either executor. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import type { InteractionProvider, InteractionSession } from '@deepseek-ai/dsh-interaction'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import * as Provider from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/driver.mjs', import.meta.url))
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A PTC runtime whose program is a test callback over the admitted bindings. */
class ScriptRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = () => Promise.resolve({ logs: [] })
  resolve(request: PtcRunRequest) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  run(request: PtcRunRequest) { return this.behavior(request) }
}

const executors = ['native', 'ptc'] as const

async function mount(options: { unrelated: boolean; executor: typeof executors[number]; mode?: string }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-isolation-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx, root)
  let provider: InteractionProvider | undefined
  ctx.provide('interaction', { register(registered: InteractionProvider) { provider = registered; return () => Promise.resolve() } })
  await ctx.plugin(ComputerUse)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(ScriptRuntime)
  await (options.executor === 'ptc' ? ctx.plugin(PtcToolExecutor) : ctx.plugin(NativeToolExecutor))
  const calls: string[] = []
  if (options.unrelated) {
    ctx.tools.register(defineTool({
      name: 'mcp__unrelated__screenshot', description: 'An unrelated operation sharing the raw name.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { calls.push('unrelated'); return 'unrelated result' },
    }))
  }
  await ctx.plugin(Provider, { command: process.execPath, args: [fixture, root, options.mode ?? 'default'], reconnect: { enabled: false } })
  const agent = { ctx, id: SessionId('cua-isolation'), session: Session.create(SessionId('cua-isolation')) } as Agent
  const signal = new AbortController().signal
  const session: InteractionSession = await provider!.open(agent, signal)
  return { ctx, agent, signal, session, calls, root, provider: provider!, runtime: ctx.ptcRuntime as ScriptRuntime }
}

it.each(executors)('does not run an admission-hidden unrelated tool whose name ends in the requested raw operation (%s)', async (executor) => {
  const { ctx, session, calls } = await mount({ unrelated: true, executor })
  ctx.tools.registerAdmissionPolicy(() => [])
  const result = await session.execute({ domain: 'desktop', method: 'screenshot' }, new AbortController().signal)
  expect(calls).toEqual([])
  expect(JSON.stringify(result)).not.toContain('unrelated result')
})

it.each(executors)('still reaches its own admission-hidden tool when an unrelated tool shares the raw operation name (%s)', async (executor) => {
  const { ctx, session } = await mount({ unrelated: true, executor })
  ctx.tools.registerAdmissionPolicy(() => [])
  const result = await session.execute({ domain: 'desktop', method: 'screenshot' }, new AbortController().signal)
  expect(result).toMatchObject({ isError: false })
  expect(JSON.stringify(result)).toContain('Display')
  expect(JSON.stringify(result)).not.toContain('unrelated result')
})

it.each(executors)('runs the provider operation an admitted facade reaches from a model call (%s)', async (executor) => {
  const h = await mount({ unrelated: false, executor })
  h.ctx.tools.register(defineTool({
    name: 'desktop_facade', description: 'Read the desktop fixture screenshot.', parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (_args, exec) => h.session.execute({ domain: 'desktop', method: 'screenshot' }, exec.signal),
  }))
  h.ctx.tools.registerAdmissionPolicy(() => ['desktop_facade'])
  let observed: unknown
  h.runtime.behavior = async (request) => {
    // The facade runs as a nested call of the model's program.
    observed = await request.bindings[0]!.functions.desktop_facade!({})
    return { logs: [] }
  }
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'test', model: 'test' } })
  try {
    const call = executor === 'ptc'
      ? { name: 'run_code', arguments: '{"code":"test","description":"Read the screen"}' }
      : { name: 'desktop_facade', arguments: '{}' }
    const batch = await h.ctx.tools.execute({ agent: h.agent, signal: h.signal, toolSet, calls: [{ type: 'tool-call', id: ToolCallId('model'), ...call }] })
    expect(batch.results[0]?.result.isError).toBe(false)
    const value = executor === 'ptc' ? observed : batch.results[0]?.result.value
    expect(value).toMatchObject({ isError: false })
    expect(JSON.stringify(value)).toContain('Display')
  } finally {
    toolSet.dispose()
  }
})

it.each([
  { domain: 'browser', method: 'screenshot' },
  { domain: 'desktop', method: 'act', action: null },
  { domain: 'desktop', method: 'act', action: [] },
  { domain: 'desktop', method: 'act', action: 'click' },
  { domain: 'desktop', method: 'act', action: {} },
  { domain: 'desktop', method: 'act', action: { kind: '' } },
  { domain: 'desktop', method: 'act', action: { kind: 'execute_shell' } },
  { domain: 'desktop', method: 'act', action: { kind: 'scroll' } },
  { domain: 'desktop', method: 'observe', applicationId: '9' },
  { domain: 'desktop', method: 'observe', applicationId: '9', windowId: '7' },
  { domain: 'desktop', method: 'observe', applicationId: 'abc', windowId: '7' },
] satisfies import('@deepseek-ai/dsh-interaction').InteractionOperation[])('rejects unsupported normalized operations before invoking MCP input (%j)', async (operation) => {
  const h = await mount({ unrelated: false, executor: 'native' })
  await expect(h.session.execute(operation, h.signal)).rejects.toThrow()
  expect(await readFile(join(h.root, 'driver.ndjson'), 'utf8')).not.toContain('"event":"call"')
})

interface DriverEvent { event: string; name?: string; arguments?: Record<string, unknown> }

async function driverCalls(root: string): Promise<DriverEvent[]> {
  const events = (await readFile(join(root, 'driver.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as DriverEvent)
  return events.filter(event => event.event === 'call')
}

// get_window_state and click take integer pid/window_id; the decorated desktop_click in the catalog is never selected.
it.each(['observe', 'screenshot', 'act'] as const)('maps %s to its own fallback catalog and forwards target fields', async (method) => {
  const h = await mount({ unrelated: false, executor: 'native', mode: 'interaction' })
  const target = { domain: 'desktop' as const, applicationId: '9', windowId: '7' }
  const operation = method === 'act'
    ? { ...target, method, action: { kind: 'click', x: 3 } }
    : { ...target, method }
  await expect(h.session.execute(operation, h.signal)).resolves.toMatchObject({ isError: false })
  const calls = await driverCalls(h.root)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ name: method === 'act' ? 'click' : 'get_window_state' })
  expect(calls[0]!.arguments).toEqual({ pid: 9, window_id: 7, ...method === 'act' ? { x: 3 } : method === 'screenshot' ? { include_screenshot: true, include_accessibility_tree: false } : {} })
  await h.session.close()
})

it.each(['observe', 'screenshot'] as const)('maps %s without ids to the whole-display observation tool', async (method) => {
  const h = await mount({ unrelated: false, executor: 'native' })
  await expect(h.session.execute({ domain: 'desktop', method }, h.signal)).resolves.toMatchObject({ isError: false })
  expect(await driverCalls(h.root)).toMatchObject([{ name: 'get_desktop_state', arguments: {} }])
  expect(h.provider.describe()).toMatchObject({ methods: ['observe', 'screenshot'], actionKinds: [] })
})

it('advertises only what its live catalog executes', async () => {
  const h = await mount({ unrelated: false, executor: 'native', mode: 'interaction' })
  expect(h.provider.describe()).toMatchObject({ methods: ['observe', 'screenshot', 'act'], actionKinds: ['click'], availability: 'ready' })
})

it('rejects an act action that repeats a target id or passes an undeclared argument', async () => {
  const h = await mount({ unrelated: false, executor: 'native', mode: 'interaction' })
  const target = { domain: 'desktop' as const, method: 'act' as const, applicationId: '9', windowId: '7' }
  await expect(h.session.execute({ ...target, action: { kind: 'click', pid: 9 } }, h.signal)).rejects.toThrow('must not repeat')
  await expect(h.session.execute({ ...target, action: { kind: 'click', button: 'left' } }, h.signal)).rejects.toThrow('does not accept')
  expect(await driverCalls(h.root)).toEqual([])
})

it('refuses normalized calls until its MCP connection is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-startup-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const registered = Promise.withResolvers<InteractionProvider>()
  ctx.provide('interaction', { register(provider: InteractionProvider) { registered.resolve(provider); return () => Promise.resolve() } })
  await ctx.plugin(ComputerUse)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  const starting = ctx.plugin(Provider, { command: process.execPath, args: [fixture, root], reconnect: { enabled: false } })
  const provider = await registered.promise
  const agent = { ctx, id: SessionId('cua-startup'), session: Session.create(SessionId('cua-startup')) } as Agent
  expect(provider.describe()).toMatchObject({ methods: [], actionKinds: [], availability: 'ready' })
  const session = await provider.open(agent, new AbortController().signal)
  await expect(session.execute({ domain: 'desktop', method: 'screenshot' }, new AbortController().signal)).rejects.toThrow('not connected')
  await starting
})
