/** The desktop facade runs only the Cua Driver MCP server's own registrations, past admission policies, under either executor. */
import { mkdtemp, rm } from 'node:fs/promises'
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

async function mount(options: { unrelated: boolean; executor: typeof executors[number] }) {
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
  await ctx.plugin(Provider, { command: process.execPath, args: [fixture, root], reconnect: { enabled: false } })
  const agent = { ctx, id: SessionId('cua-isolation'), session: Session.create(SessionId('cua-isolation')) } as Agent
  const signal = new AbortController().signal
  const session: InteractionSession = await provider!.open(agent, signal)
  return { ctx, agent, signal, session, calls, runtime: ctx.ptcRuntime as ScriptRuntime }
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
