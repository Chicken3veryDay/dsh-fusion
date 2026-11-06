/** Host-internal dispatch keeps scoped restrictions, guards, and nested PTC admission, and reaches only the tools it names. */
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
  ctx.tools.register(defineTool({
    name: 'probe', description: 'A harmless control.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push('probe'); return 'done' },
  }))
  const signal = new AbortController().signal
  const execute = (host: boolean, toolSet?: ResolvedToolSet) => ctx.tools.execute({
    agent, signal, ...(host ? { hostInternalDispatch: { tools: ['probe'] } } : {}),
    ...toolSet === undefined ? {} : { toolSet },
    calls: [{ type: 'tool-call', id: ToolCallId('control'), name: ptc ? 'run_code' : 'probe', arguments: ptc ? '{"code":"test","description":"Control"}' : '{}' }],
  })
  return { ctx, agent, scope, calls, signal, execute, runtime: ctx.ptcRuntime as ScriptRuntime }
}

it('keeps scoped restrictions and monotonic guards on host-internal native calls', async () => {
  const h = await harness()
  h.ctx.tools.registerAdmissionPolicy(() => [])
  expect((await h.execute(false)).results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
  const restriction = h.scope.ctx.tools.restrict({ deny: ['probe'] })
  expect((await h.execute(true)).results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
  restriction()
  const guard = h.scope.ctx.tools.guard(() => 'control denial')
  h.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  expect((await h.execute(true)).results[0]?.result.error?.message).toBe('control denial')
  expect(h.calls).toEqual([])
  guard()
  expect((await h.execute(true)).results[0]?.result.isError).toBe(false)
  expect(h.calls).toEqual(['probe'])
})

it('keeps admitted PTC bindings empty and guards nested host-internal dispatch', async () => {
  const h = await harness(true)
  h.ctx.tools.registerAdmissionPolicy(() => [])
  h.runtime.behavior = async (request) => {
    expect(Object.keys(request.bindings[0]!.functions)).toEqual([])
    return { logs: [] }
  }
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'test', model: 'test' } })
  expect((await h.execute(false, toolSet)).results[0]?.result).toMatchObject({ isError: false })
  toolSet.dispose()
  h.runtime.behavior = async (request) => {
    await expect(request.bindings[0]!.functions.probe!({})).rejects.toThrow('unknown tool')
    return { logs: [] }
  }
  expect((await h.execute(false)).results[0]?.result).toMatchObject({ isError: false })
  const deny = h.scope.ctx.tools.guard(exec => exec.name === 'probe' ? 'nested control denial' : undefined)
  h.runtime.behavior = async (request) => {
    expect(Object.keys(request.bindings[0]!.functions)).toEqual(['probe'])
    await expect(request.bindings[0]!.functions.probe!({})).rejects.toThrow('nested control denial')
    return { logs: [] }
  }
  expect((await h.execute(true)).results[0]?.result).toMatchObject({ isError: false })
  deny()
  expect(h.calls).toEqual([])
})
