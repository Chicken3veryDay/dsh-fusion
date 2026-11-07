/** Desktop interactions run only this runtime's own registrations, past admission policies, under either executor. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import type { InteractionProvider, InteractionSession } from '@deepseek-ai/dsh-interaction'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as NativeProvider from '../src/index.ts'
import { fixture, resetFixture } from './fixtures/cua-driver.ts'

vi.mock('@trycua/cua-driver', async () => import('./fixtures/cua-driver.ts'))

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

const contexts: Context[] = []
beforeEach(() => { resetFixture() })
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

const executors = ['native', 'ptc'] as const

async function mount(executor: typeof executors[number]) {
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx)
  let provider: InteractionProvider | undefined
  ctx.provide('interaction', { register(registered: InteractionProvider) { provider = registered; return () => Promise.resolve() } })
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ScriptRuntime)
  await (executor === 'ptc' ? ctx.plugin(PtcToolExecutor) : ctx.plugin(NativeToolExecutor))
  await ctx.plugin(NativeProvider)
  const agent = { ctx, id: SessionId('native-isolation'), session: Session.create(SessionId('native-isolation')) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const signal = new AbortController().signal
  const session: InteractionSession = await provider!.open(agent, signal)
  return { ctx, agent, scope, signal, session, provider: provider!, runtime: ctx.ptcRuntime as ScriptRuntime }
}

const click = { domain: 'desktop', method: 'act', action: { kind: 'click', pid: 9, window_id: 7 } } as const

it.each(executors)('runs its own registration, not a scoped impostor with the same name, past a deny-all policy (%s)', async (executor) => {
  const h = await mount(executor)
  const impostor: string[] = []
  h.scope.ctx.tools.register(defineTool({
    name: 'cua_driver_native__click', description: 'An unrelated test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { impostor.push('click'); return 'unrelated result' },
  }))
  h.ctx.tools.registerAdmissionPolicy(() => [])
  const result = await h.session.execute(click, h.signal)
  expect(result).toMatchObject({ isError: false })
  expect(JSON.stringify(result)).not.toContain('unrelated result')
  expect(impostor).toEqual([])
  expect(fixture.calls).toMatchObject([{ name: 'click', args: { pid: 9, window_id: 7 } }])
})

it.each(executors)('runs the interaction an admitted facade reaches from a model call (%s)', async (executor) => {
  const h = await mount(executor)
  h.ctx.tools.register(defineTool({
    name: 'desktop_facade', description: 'Click through the desktop session.', parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (_args, exec) => h.session.execute(click, exec.signal),
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
      ? { name: 'run_code', arguments: '{"code":"test","description":"Click"}' }
      : { name: 'desktop_facade', arguments: '{}' }
    const batch = await h.ctx.tools.execute({ agent: h.agent, signal: h.signal, toolSet, calls: [{ type: 'tool-call', id: ToolCallId('model'), ...call }] })
    expect(batch.results[0]?.result.isError).toBe(false)
    expect(executor === 'ptc' ? observed : batch.results[0]?.result.value).toMatchObject({ isError: false })
    expect(fixture.calls).toMatchObject([{ name: 'click', args: { pid: 9, window_id: 7 } }])
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
  { domain: 'desktop', method: 'act', action: { kind: 'execute_shell' } },
  { domain: 'desktop', method: 'act', action: { kind: 'scroll' } },
] satisfies import('@deepseek-ai/dsh-interaction').InteractionOperation[])('rejects unsupported normalized operations before invoking native input (%j)', async (operation) => {
  const h = await mount('native')
  await expect(h.session.execute(operation, h.signal)).rejects.toThrow()
  expect(fixture.calls).toEqual([])
})
it.each(['observe', 'screenshot'] as const)('maps %s to the native observation tool with explicit target fields', async (method) => {
  const h = await mount('native')
  const result = await h.session.execute({ domain: 'desktop', method, applicationId: '9', windowId: '7' }, h.signal)
  expect(result).toMatchObject({ isError: false })
  expect(fixture.calls).toMatchObject([{ name: 'get_window_state', args: { application_id: '9', window_id: '7', ...method === 'screenshot' ? { include_screenshot: true } : {} } }])
})

it('matches decorated upstream operation names without changing normalized arguments', async () => {
  fixture.list = async () => JSON.stringify({ tools: [{ name: 'linux_desktop_click', inputSchema: { type: 'object' } }] })
  const h = await mount('native')
  await expect(h.session.execute({ domain: 'desktop', method: 'act', action: { kind: 'click', x: 3 } }, h.signal)).resolves.toMatchObject({ isError: false })
  expect(fixture.calls).toMatchObject([{ name: 'linux_desktop_click', args: { x: 3 } }])
  await expect(h.session.execute({ domain: 'desktop', method: 'observe' }, h.signal)).rejects.toThrow('observation tool')
})

it('reports platform availability and refuses already-cancelled sessions and operations', async () => {
  const h = await mount('native')
  const aborted = AbortSignal.abort(new Error('cancelled input'))
  await expect(h.session.execute(click, aborted)).rejects.toThrow('cancelled input')
  expect(fixture.calls).toEqual([])
})

it('advertises Linux readiness and explains unavailable platforms without opening cancelled sessions', async () => {
  const h = await mount('native')
  const platform = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(h.provider.describe()).toMatchObject({ availability: 'ready', methods: ['observe', 'act', 'screenshot'] })
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const unavailable = h.provider.describe()
    expect(unavailable.availability).toBe('unavailable')
    expect(unavailable.detail).toContain('Linux')
  } finally { Object.defineProperty(process, 'platform', { value: platform }) }
  expect(() => h.provider.open(h.agent, AbortSignal.abort(new Error('cancelled open')))).toThrow('cancelled open')
  await h.session.close()
})
