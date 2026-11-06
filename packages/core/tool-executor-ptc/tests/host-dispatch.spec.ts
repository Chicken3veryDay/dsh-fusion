/** A host invocation keeps scoped restrictions and guards and works under the PTC executor, including from a nested binding. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { PtcExecutor } from '../src/index.ts'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

class ScriptRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = async () => ({ logs: [] })
  resolve(request: PtcRunRequest) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  run(request: PtcRunRequest) { return this.behavior(request) }
}

async function harness(ptc = false) {
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(ScriptRuntime)
  ctx.tools.setExecutor(ptc ? new PtcExecutor(ctx) : new NativeToolExecutor(ctx))
  const agent = { ctx, id: SessionId('host-dispatch'), session: Session.create(SessionId('host-dispatch')) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const calls: string[] = []
  const { registration } = ctx.tools.register(defineTool({
    name: 'probe', description: 'A harmless control.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push('probe'); return 'done' },
  }))
  const signal = new AbortController().signal
  /** A model batch: `run_code` under PTC, the tool itself under the native executor. */
  const execute = (toolSet?: ResolvedToolSet, direct = !ptc) => ctx.tools.execute({
    agent, signal, ...toolSet === undefined ? {} : { toolSet },
    calls: [{ type: 'tool-call', id: ToolCallId('control'), name: direct ? 'probe' : 'run_code', arguments: direct ? '{}' : '{"code":"test","description":"Control"}' }],
  })
  /** A host component's call to the registration it retained. */
  const invoke = () => ctx.tools.invoke({ registration, arguments: {}, agent, signal, callId: ToolCallId('host-probe') })
  return { ctx, agent, scope, calls, signal, probe: registration, execute, invoke, runtime: ctx.ptcRuntime as ScriptRuntime }
}

it.each([false, true])('keeps scoped restrictions and monotonic guards on a host invocation (PTC: %s)', async (ptc) => {
  const h = await harness(ptc)
  h.ctx.tools.registerAdmissionPolicy(() => [])
  expect((await h.execute(undefined, true)).results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
  const restriction = h.scope.ctx.tools.restrict({ deny: ['probe'] })
  expect((await h.invoke()).error?.info?.code).toBe('UNKNOWN_TOOL')
  restriction()
  const guard = h.scope.ctx.tools.guard(() => 'control denial')
  h.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  expect((await h.invoke()).error?.message).toBe('control denial')
  expect(h.calls).toEqual([])
  guard()
  expect(await h.invoke()).toMatchObject({ isError: false, content: [{ type: 'text', text: 'done' }] })
  expect(h.calls).toEqual(['probe'])
})

it('runs a host invocation under PTC while a model call naming the tool directly stays refused', async () => {
  const h = await harness(true)
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'test', model: 'test' } })
  const direct = await h.execute(toolSet, true)
  expect(direct.results[0]?.result.error?.message).toContain('only `run_code` is callable directly')
  toolSet.dispose()
  expect(h.calls).toEqual([])
  expect(await h.invoke()).toMatchObject({ isError: false })
  expect(h.calls).toEqual(['probe'])
})

it('keeps admitted PTC bindings empty and refuses a selection-less nested call', async () => {
  const h = await harness(true)
  h.ctx.tools.registerAdmissionPolicy(() => [])
  h.runtime.behavior = async (request) => {
    expect(Object.keys(request.bindings[0]!.functions)).toEqual([])
    return { logs: [] }
  }
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'test', model: 'test' } })
  expect((await h.execute(toolSet)).results[0]?.result).toMatchObject({ isError: false })
  toolSet.dispose()
  h.runtime.behavior = async (request) => {
    await expect(request.bindings[0]!.functions.probe!({})).rejects.toThrow('unknown tool')
    return { logs: [] }
  }
  expect((await h.execute()).results[0]?.result).toMatchObject({ isError: false })
  expect(h.calls).toEqual([])
})

it('runs a host invocation that an admitted facade makes from inside a nested PTC binding', async () => {
  const h = await harness(true)
  h.ctx.tools.register(defineTool({
    name: 'facade', description: 'Reach the host operation.', parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (_args, exec) => {
      const result = await h.ctx.tools.invoke({ registration: h.probe, arguments: {}, agent: h.agent, signal: exec.signal, callId: ToolCallId('nested-host') })
      return { isError: result.isError }
    },
  }))
  h.ctx.tools.registerAdmissionPolicy(() => ['facade'])
  let observed: unknown
  h.runtime.behavior = async (request) => {
    expect(Object.keys(request.bindings[0]!.functions)).toEqual(['facade'])
    observed = await request.bindings[0]!.functions.facade!({})
    return { logs: [] }
  }
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'test', model: 'test' } })
  expect((await h.execute(toolSet)).results[0]?.result).toMatchObject({ isError: false })
  toolSet.dispose()
  expect(observed).toEqual({ isError: false })
  expect(h.calls).toEqual(['probe'])
})
