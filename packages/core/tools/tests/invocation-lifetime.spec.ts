/** Identity-bound calls retain their execution policy and settle accepted work across replacement. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import Tools, { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, expect, it, vi } from 'vitest'

const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] }

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const agent = { id: SessionId('review-r4-invoke'), session: Session.create(SessionId('review-r4-invoke')) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const controller = new AbortController()
  const invoke = (registration: ReturnType<typeof ctx.tools.register>['registration']) => ctx.tools.invoke({
    registration, agent, signal: controller.signal, callId: ToolCallId('r4-host'), arguments: {},
  })
  return { ctx, agent, scope, controller, invoke }
}

it.each([false, true])('uses the retained provider timeout with an unbudgeted scoped shadow: %s', async (shadow) => {
  const h = await harness()
  await h.ctx.plugin(TimeoutPolicy)
  const entered = Promise.withResolvers<undefined>()
  const handle = h.ctx.tools.register(defineTool({
    name: 'probe', description: 'Cooperative operation with a deadline.', parameters: {}, output, timeoutMs: 25,
    async execute(_args, exec) {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (exec.signal.aborted) resolve()
        else exec.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return 'settled'
    },
  }))
  if (shadow) h.scope.ctx.tools.register(defineTool({
    name: 'probe', description: 'Unrelated shadow without a timeout.', parameters: {}, output,
    execute: async () => 'impostor',
  }))
  vi.useFakeTimers()
  let settled = false
  const pending = h.invoke(handle.registration).then((result) => { settled = true; return result })
  await entered.promise
  await vi.advanceTimersByTimeAsync(100)
  const timedOut = settled
  h.controller.abort()
  const result = await pending
  expect({ settledAtDeadline: timedOut, code: result.error?.info?.code })
    .toEqual({ settledAtDeadline: true, code: 'TOOL_TIMEOUT' })
})

it.each(['unchanged', 'around-copy', 'post-value'] as const)('settles an admitted invocation after registration replacement with %s result policy', async (policy) => {
  const h = await harness()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const handle = h.ctx.tools.register(defineTool({
    name: 'probe', description: 'Original provider operation.', parameters: {}, output,
    async execute() { entered.resolve(undefined); await release.promise; return 'original' },
  }))
  if (policy === 'around-copy') h.ctx.on('tools/execute', async (_exec, next) => ({ ...await next() }))
  if (policy === 'post-value') h.ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: 'approved' }))
  const pending = h.invoke(handle.registration)
  await entered.promise
  handle()
  h.ctx.tools.register(defineTool({
    name: 'probe', description: 'Replacement provider operation.', parameters: {}, output,
    execute: async () => 'replacement',
  }))
  release.resolve(undefined)
  const result = await pending
  expect({ isError: result.isError, value: result.isError ? undefined : result.value, code: result.error?.info?.code })
    .toEqual({ isError: false, value: policy === 'post-value' ? 'approved' : 'original', code: undefined })
})

it.each(['dispose', 'replace', 'restrict', 'guard', 'abort'] as const)('refuses a host body after %s while pre-execute policy is pending', async (change) => {
  const h = await harness()
  let calls = 0
  const tool: ToolDefinition = defineTool({
    name: 'probe', description: 'Host operation.', parameters: {}, output,
    execute: async () => { calls++; return 'done' },
  })
  const handle = h.ctx.tools.register(tool)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  h.ctx.on('tools/pre-execute', async (_exec, next) => { entered.resolve(undefined); await release.promise; return next() })
  const pending = h.invoke(handle.registration)
  await entered.promise
  if (change === 'dispose' || change === 'replace') handle()
  if (change === 'replace') h.ctx.tools.register(tool)
  if (change === 'restrict') h.scope.ctx.tools.restrict({ deny: ['probe'] })
  if (change === 'guard') h.scope.ctx.tools.guard(() => 'late guard')
  if (change === 'abort') h.controller.abort()
  release.resolve(undefined)
  expect((await pending).isError).toBe(true)
  expect(calls).toBe(0)
})

it('drains a started invocation on cancellation and preserves result normalization', async () => {
  const h = await harness()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let finished = false
  const handle = h.ctx.tools.register(defineTool({
    name: 'probe', description: 'Host operation.', parameters: {}, output,
    async execute() { entered.resolve(undefined); await release.promise; finished = true; return 'done' },
  }))
  let settled = false
  const pending = h.invoke(handle.registration).then((result) => { settled = true; return result })
  await entered.promise
  h.controller.abort()
  expect(settled).toBe(false)
  release.resolve(undefined)
  expect(await pending).toMatchObject({ isError: true, error: { info: { code: 'ABORTED' } } })
  expect(finished).toBe(true)
})

it('inherits parent restrictions and guards without admitting sibling registrations', async () => {
  const h = await harness()
  const child = { id: SessionId('r4-child') } as Agent
  const sibling = { id: SessionId('r4-sibling') } as Agent
  let childScope!: Scope
  let siblingScope!: Scope
  await h.ctx.plugin(Object.assign((inner: Context) => {
    childScope = createScope(inner, child, { parent: h.agent })
    siblingScope = createScope(inner, sibling)
  }, { inject: ['tools'] }))
  let calls = 0
  const definition = defineTool({
    name: 'probe', description: 'Host operation.', parameters: {}, output,
    execute: async () => { calls++; return 'done' },
  })
  const handle = h.ctx.tools.register(definition)
  const invoke = (registration: typeof handle.registration) => childScope.ctx.tools.invoke({
    registration, agent: child, signal: h.controller.signal, callId: ToolCallId('child'), arguments: {},
  })
  const restrict = h.scope.ctx.tools.restrict({ deny: ['probe'] })
  expect((await invoke(handle.registration)).error?.info?.code).toBe('UNKNOWN_TOOL')
  restrict()
  const guard = h.scope.ctx.tools.guard(() => 'parent guard')
  expect((await invoke(handle.registration)).error?.message).toBe('parent guard')
  guard()
  expect((await invoke(handle.registration)).isError).toBe(false)
  const privateHandle = siblingScope.ctx.tools.register({ ...definition, name: 'private' })
  expect((await invoke(privateHandle.registration)).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(calls).toBe(1)
})

it('keeps a later host invocation usable after its first caller scope unloads', async () => {
  const h = await harness()
  const handle = h.ctx.tools.register(defineTool({
    name: 'probe', description: 'Host operation.', parameters: {}, output, execute: async () => 'done',
  }))
  expect((await h.scope.ctx.tools.invoke({
    registration: handle.registration, agent: h.agent, signal: h.controller.signal, callId: ToolCallId('first'), arguments: {},
  })).isError).toBe(false)
  await h.scope.dispose()
  expect((await h.invoke(handle.registration)).isError).toBe(false)
})

it('retains the accepted definition in guards, wrappers, the body, and completion observers', async () => {
  const h = await harness()
  const seen: (ToolDefinition | undefined)[] = []
  const tool = defineTool({
    name: 'probe', description: 'Identity-bound operation.', parameters: {}, output,
    async execute(_args, exec) { seen.push(exec.definition); return 'original' },
  })
  const handle = h.ctx.tools.register(tool)
  h.ctx.on('tools/pre-execute', async (exec, next) => { seen.push(exec.definition); return next() })
  h.ctx.tools.guard((exec) => { seen.push(exec.definition); return undefined })
  h.ctx.on('tools/execute', async (exec, next) => { seen.push(exec.definition); return { ...await next() } })
  h.ctx.on('tools/post-execute', async (exec) => { seen.push(exec.definition); handle(); return { kind: 'accept', value: 'approved' } })
  h.ctx.on('tools/result', (exec) => { seen.push(exec.definition) })
  expect(await h.invoke(handle.registration)).toMatchObject({ isError: false, value: 'approved' })
  expect(seen).toHaveLength(6)
  for (const definition of seen) expect(definition).toBe(tool)
})

it('refuses a same-named substitution while an around-dispatch wrapper waits', async () => {
  const h = await harness()
  const calls: string[] = []
  const handle = h.ctx.tools.register(defineTool({
    name: 'probe', description: 'Original operation.', parameters: {}, output,
    async execute() { calls.push('original'); return 'original' },
  }))
  h.ctx.on('tools/execute', async (_exec, next) => {
    handle()
    h.ctx.tools.register(defineTool({
      name: 'probe', description: 'Replacement operation.', parameters: {}, output,
      async execute() { calls.push('replacement'); return 'replacement' },
    }))
    return next()
  })
  const result = await executeToolFixture(h.ctx, {
    name: 'probe', agent: h.agent, arguments: {}, callId: ToolCallId('replace-during-wrapper'), signal: h.controller.signal,
  })
  expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(calls).toEqual([])
})

it.each(['admission-policy', 'conditional-registration'] as const)(
  'refuses an unselected call when pre-execute adds %s', async (change) => {
    const h = await harness()
    let calls = 0
    const tool = defineTool({
      name: 'probe', description: 'Initially unconditional operation.', parameters: {}, output,
      async execute() { calls++; return 'done' },
    })
    const handle = h.ctx.tools.register(tool)
    h.ctx.on('tools/pre-execute', async (_exec, next) => {
      if (change === 'admission-policy') h.ctx.tools.registerAdmissionPolicy(() => [])
      else {
        handle()
        h.ctx.tools.register(tool, { when: () => true })
      }
      return next()
    })
    const result = await executeToolFixture(h.ctx, {
      name: 'probe', agent: h.agent, arguments: {}, callId: ToolCallId('late-admission'), signal: h.controller.signal,
    })
    expect(result.error?.info?.code).toBe('UNKNOWN_TOOL')
    expect(calls).toBe(0)
  },
)
