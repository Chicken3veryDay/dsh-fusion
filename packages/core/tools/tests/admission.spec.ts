/** Admission policies hide tools from a step's declarations and from every dispatch path. */
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, orderedAdmission, ToolAdmissionError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionInput, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

const TEST_MODEL_SELECTION = { provider: 'test', model: 'test' }
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const agent = { id: SessionId('admission') } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const controller = new AbortController()
  const calls: string[] = []
  const tool = (name: string): ToolDefinition => defineTool({
    name, description: `Operation ${name}.`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { calls.push(name); return `ran:${name}` },
  })
  const input = (name: string) => ({
    agent, name, arguments: {}, callId: ToolCallId(`call-${name}`), signal: controller.signal,
  })
  const execute = (name: string, overrides: Partial<ToolExecutionInput> = {}): Promise<ToolExecutionResult> =>
    executeToolFixture(ctx, { ...input(name), ...overrides })
  const resolve = () => ctx.tools.resolve({ agent, modelSelection: TEST_MODEL_SELECTION, signal: controller.signal })
  const declared = (toolSet: Awaited<ReturnType<typeof resolve>>) => ctx.tools.schemas(agent, toolSet).map(schema => schema.name)
  return { ctx, agent, scope, controller, tool, input, execute, resolve, declared, calls }
}

it('rejects a model call to a hidden tool through the executor with a typed result', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('alpha'))
  h.ctx.tools.register(h.tool('beta'))
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => [...candidates.keys()].filter(name => name !== 'beta'))
  const toolSet = await h.resolve()
  const hidden = await executeModelToolFixture(h.ctx, { ...h.input('beta'), toolSet })
  expect(hidden.isError).toBe(true)
  expect(hidden.error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls).toEqual([])
  expect((await executeModelToolFixture(h.ctx, { ...h.input('alpha'), toolSet })).isError).toBe(false)
  expect(h.calls).toEqual(['alpha'])
})

it('hides a tool from the step declarations and definitions', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('alpha'))
  h.ctx.tools.register(h.tool('beta'))
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => [...candidates.keys()].filter(name => name !== 'beta'))
  const toolSet = await h.resolve()
  expect(h.declared(toolSet)).toEqual(['alpha'])
  expect(h.ctx.tools.get('beta', h.agent, toolSet)).toBeUndefined()
  expect(h.ctx.tools.executable('beta', h.agent, toolSet)).toBeUndefined()
  // Registered-definition inspection is not step admission.
  expect(h.ctx.tools.schemas(h.agent).map(schema => schema.name)).toEqual(['alpha', 'beta'])
})

it('rejects a nested transport dispatch to a hidden tool', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('alpha'))
  h.ctx.tools.register(h.tool('beta'))
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => [...candidates.keys()].filter(name => name !== 'beta'))
  const toolSet = await h.resolve()
  const parent = Symbol('outer') as ToolExecutionToken
  const nested = await h.execute('beta', { toolSet, parent })
  expect(nested.error?.info?.code).toBe('UNKNOWN_TOOL')
  expect((await h.execute('alpha', { toolSet, parent })).isError).toBe(false)
  expect(h.calls).toEqual(['alpha'])
})

it('hides only tools whose own condition passed and lets a policy see just those candidates', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('on'), { when: () => true })
  h.ctx.tools.register(h.tool('off'), { when: () => false })
  h.ctx.tools.register(h.tool('plain'))
  const seen: string[][] = []
  h.ctx.tools.registerAdmissionPolicy(({ candidates, agent, modelSelection, signal }) => {
    expect(agent).toBe(h.agent)
    expect(modelSelection).toBe(TEST_MODEL_SELECTION)
    expect(signal).toBe(h.controller.signal)
    seen.push([...candidates.keys()])
    expect(candidates.get('on')?.name).toBe('on')
    return candidates.keys()
  })
  expect(h.declared(await h.resolve())).toEqual(['on', 'plain'])
  expect(seen).toEqual([['on', 'plain']])
})

it('composes policies by intersection in registration order and preserves candidate order', async () => {
  const h = await setup()
  for (const name of ['a', 'b', 'c', 'd']) h.ctx.tools.register(h.tool(name))
  const order: string[] = []
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => {
    order.push(`first:${[...candidates.keys()].join('')}`)
    return ['d', 'c', 'b']
  })
  h.ctx.tools.registerAdmissionPolicy(async ({ candidates }) => {
    order.push(`second:${[...candidates.keys()].join('')}`)
    return new Set(['c', 'b'])
  })
  expect(h.declared(await h.resolve())).toEqual(['b', 'c'])
  expect(order).toEqual(['first:abcd', 'second:bcd'])
})

it('applies global policies before policies registered through the agent scope', async () => {
  const h = await setup()
  for (const name of ['a', 'b']) h.ctx.tools.register(h.tool(name))
  const order: string[] = []
  h.scope.ctx.tools.registerAdmissionPolicy(({ candidates }) => { order.push('scoped'); return candidates.keys() })
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => { order.push('global'); return [...candidates.keys()].slice(1) })
  expect(h.declared(await h.resolve())).toEqual(['b'])
  expect(order).toEqual(['global', 'scoped'])
})

it('does not apply an agent-scoped policy to another agent', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  h.scope.ctx.tools.registerAdmissionPolicy(() => [])
  expect(h.declared(await h.resolve())).toEqual([])
  const other = { id: SessionId('other') } as Agent
  const toolSet = await h.ctx.tools.resolve({ agent: other, modelSelection: TEST_MODEL_SELECTION, signal: h.controller.signal })
  expect(h.ctx.tools.schemas(other, toolSet).map(schema => schema.name)).toEqual(['a'])
})

it('fails step preparation with the typed error when a policy throws or rejects', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  const cause = new Error('grant store unavailable')
  const dispose = h.ctx.tools.registerAdmissionPolicy(() => { throw cause })
  await expect(h.resolve()).rejects.toMatchObject({ name: ToolAdmissionError.name, code: 'TOOL_ADMISSION_FAILED', cause })
  dispose()
  h.ctx.tools.registerAdmissionPolicy(() => Promise.reject(cause))
  await expect(h.resolve()).rejects.toBeInstanceOf(ToolAdmissionError)
  expect(h.calls).toEqual([])
})

it('fails step preparation when a policy names a tool it was not given', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  h.ctx.tools.register(h.tool('b'), { when: () => false })
  h.ctx.tools.registerAdmissionPolicy(() => ['a', 'b'])
  const failure = await h.resolve().then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(ToolAdmissionError)
  expect(((failure as ToolAdmissionError).cause as Error).message).toContain('"b"')
})

it('cannot add or replace definitions by changing the candidates it receives', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  const original = h.tool('a')
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => {
    const copy = candidates as Map<string, ToolDefinition>
    copy.set('forged', h.tool('forged'))
    copy.set('a', original)
    return ['a']
  })
  const seen: ToolDefinition[] = []
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => { seen.push(...candidates.values()); return candidates.keys() })
  const toolSet = await h.resolve()
  expect(h.declared(toolSet)).toEqual(['a'])
  expect(seen).toHaveLength(1)
  expect(seen[0]).not.toBe(original)
  expect(h.ctx.tools.get('a', h.agent, toolSet)).toBe(seen[0])
})

it('reports cancellation instead of publishing a selection when a policy settles late', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  const entered = Promise.withResolvers<undefined>()
  const decision = Promise.withResolvers<string[]>()
  h.ctx.tools.registerAdmissionPolicy(() => { entered.resolve(undefined); return decision.promise })
  const pending = h.resolve()
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await entered.promise
  h.controller.abort()
  decision.resolve(['a'])
  await rejection
})

it('reports cancellation, not the typed error, when a policy throws after cancellation', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  h.ctx.tools.registerAdmissionPolicy(() => { h.controller.abort(); throw new Error('late') })
  await expect(h.resolve()).rejects.toMatchObject({ name: 'AbortError' })
})

it('restores visibility on the next step after the policy is disposed', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  h.ctx.tools.register(h.tool('b'))
  const dispose = h.ctx.tools.registerAdmissionPolicy(({ candidates }) => [...candidates.keys()].filter(name => name !== 'b'))
  const hiding = await h.resolve()
  expect(h.declared(hiding)).toEqual(['a'])
  dispose()
  dispose()
  expect(h.declared(await h.resolve())).toEqual(['a', 'b'])
  expect((await h.execute('b', { toolSet: hiding })).error?.info?.code).toBe('UNKNOWN_TOOL')
})

it('removes a policy registered by a plugin when that plugin unloads', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  const fiber = h.ctx.plugin(Object.assign((inner: Context) => { inner.tools.registerAdmissionPolicy(() => []) }, { inject: ['tools'] }))
  const plugin = await fiber
  expect(h.declared(await h.resolve())).toEqual([])
  await plugin.dispose()
  expect(h.declared(await h.resolve())).toEqual(['a'])
})

it('keeps an unfiltered step identical to the pre-policy selection', async () => {
  const h = await setup()
  for (const name of ['z', 'a', 'm']) h.ctx.tools.register(h.tool(name))
  const before = h.declared(await h.resolve())
  const dispose = h.ctx.tools.registerAdmissionPolicy(({ candidates }) => candidates.keys())
  expect(h.declared(await h.resolve())).toEqual(before)
  dispose()
  expect(before).toEqual(['z', 'a', 'm'])
})

it('keeps registration order for every plain return, whatever order the policy lists names in', async () => {
  const h = await setup()
  for (const name of ['a', 'b', 'c']) h.ctx.tools.register(h.tool(name))
  expect(h.declared(await h.resolve())).toEqual(['a', 'b', 'c'])
  h.ctx.tools.registerAdmissionPolicy(() => ['c', 'a', 'b'])
  expect(h.declared(await h.resolve())).toEqual(['a', 'b', 'c'])
})

it('declares tools in the sequence an ordering policy returns and exposes it through every view', async () => {
  const h = await setup()
  for (const name of ['a', 'b', 'c', 'd']) h.ctx.tools.register(h.tool(name))
  h.ctx.tools.registerAdmissionPolicy(() => orderedAdmission(['c', 'a', 'd']))
  const toolSet = await h.resolve()
  expect(h.declared(toolSet)).toEqual(['c', 'a', 'd'])
  expect(h.ctx.tools.definitions(h.agent, toolSet).map(definition => definition.name)).toEqual(['c', 'a', 'd'])
  expect([...toolSet.view(h.agent).keys()]).toEqual(['c', 'a', 'd'])
  expect((await h.execute('c', { toolSet })).isError).toBe(false)
  expect(h.ctx.tools.schemas(h.agent).map(schema => schema.name)).toEqual(['a', 'b', 'c', 'd'])
})

it('lets the last ordering policy decide the sequence and keeps candidates in registration order for every policy', async () => {
  const h = await setup()
  for (const name of ['a', 'b', 'c', 'd']) h.ctx.tools.register(h.tool(name))
  const seen: string[] = []
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => { seen.push([...candidates.keys()].join('')); return orderedAdmission(['d', 'c', 'b']) })
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => { seen.push([...candidates.keys()].join('')); return orderedAdmission(['b', 'd', 'c']) })
  expect(h.declared(await h.resolve())).toEqual(['b', 'd', 'c'])
  expect(seen).toEqual(['abcd', 'bcd'])
})

it('keeps an earlier ordering when a later plain policy only removes, and ignores a plain policy before the ordering one', async () => {
  const h = await setup()
  for (const name of ['a', 'b', 'c', 'd']) h.ctx.tools.register(h.tool(name))
  const removeB = h.ctx.tools.registerAdmissionPolicy(({ candidates }) => [...candidates.keys()].filter(name => name !== 'b'))
  const order = h.ctx.tools.registerAdmissionPolicy(() => orderedAdmission(['d', 'c', 'a']))
  expect(h.declared(await h.resolve())).toEqual(['d', 'c', 'a'])
  order()
  removeB()
  h.ctx.tools.registerAdmissionPolicy(() => orderedAdmission(['d', 'c', 'b', 'a']))
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => [...candidates.keys()].filter(name => name !== 'c'))
  expect(h.declared(await h.resolve())).toEqual(['d', 'b', 'a'])
})

it('treats a duplicate name in an ordered decision as its first position', async () => {
  const h = await setup()
  for (const name of ['a', 'b']) h.ctx.tools.register(h.tool(name))
  h.ctx.tools.registerAdmissionPolicy(() => orderedAdmission(['b', 'a', 'b']))
  expect(h.declared(await h.resolve())).toEqual(['b', 'a'])
})

it('fails step preparation when an ordering policy names a tool it was not given and cannot add or replace definitions', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  h.ctx.tools.register(h.tool('b'), { when: () => false })
  const dispose = h.ctx.tools.registerAdmissionPolicy(() => orderedAdmission(['b', 'a']))
  const failure = await h.resolve().then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(ToolAdmissionError)
  expect(((failure as ToolAdmissionError).cause as Error).message).toContain('"b"')
  dispose()

  const original = h.tool('a')
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => {
    const copy = candidates as Map<string, ToolDefinition>
    copy.set('forged', h.tool('forged'))
    copy.set('a', original)
    return orderedAdmission(['a'])
  })
  const toolSet = await h.resolve()
  expect(h.declared(toolSet)).toEqual(['a'])
  expect(h.ctx.tools.get('a', h.agent, toolSet)).not.toBe(original)
})

it('rejects a public batch call without a selection while an admission policy applies', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('hidden'))
  h.ctx.tools.registerAdmissionPolicy(() => [])
  expect(h.declared(await h.resolve())).toEqual([])
  const result = await executeModelToolFixture(h.ctx, h.input('hidden'))
  expect({ isError: result.isError, code: result.error?.info?.code, calls: h.calls }).toEqual({ isError: true, code: 'UNKNOWN_TOOL', calls: [] })
})

it('rejects a selection-less call while a policy registered in the caller scope applies, and runs it again after disposal', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  const dispose = h.scope.ctx.tools.registerAdmissionPolicy(() => [])
  expect(h.ctx.tools.executable('a', h.agent)).toBeUndefined()
  dispose()
  expect(h.ctx.tools.executable('a', h.agent)?.name).toBe('a')
})

it('rejects a string decision as a failed admission instead of treating it as a list of names', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('a'))
  for (const decision of ['a', '']) {
    // @ts-expect-error a string is not a ToolAdmissionDecision
    const dispose = h.ctx.tools.registerAdmissionPolicy(() => decision)
    const failure = await h.resolve().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ToolAdmissionError)
    expect(((failure as ToolAdmissionError).cause as Error).message).toContain('returned string')
    dispose()
  }
})

it('accepts an array, a set, an iterator, and an empty array as decisions', async () => {
  const h = await setup()
  for (const name of ['a', 'b']) h.ctx.tools.register(h.tool(name))
  const decisions: (() => readonly string[] | ReadonlySet<string> | IterableIterator<string>)[] = [
    () => ['a'],
    () => new Set(['a']),
    () => ['a'][Symbol.iterator](),
    () => [],
  ]
  const declared: string[][] = []
  for (const decision of decisions) {
    const dispose = h.ctx.tools.registerAdmissionPolicy(decision)
    declared.push(h.declared(await h.resolve()))
    dispose()
  }
  expect(declared).toEqual([['a'], ['a'], ['a'], []])
})

it('runs a host-internal batch past admission policies, for global and scoped registrations alike', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('global'))
  h.scope.ctx.tools.register(h.tool('scoped'))
  h.ctx.tools.registerAdmissionPolicy(() => [])
  expect(h.declared(await h.resolve())).toEqual([])
  const batch = (name: string, extra: object = {}) => h.ctx.tools.execute({
    agent: h.agent, signal: h.controller.signal, hostInternalDispatch: { tools: [name] }, ...extra,
    calls: [{ type: 'tool-call' as const, id: ToolCallId(`host-${name}`), name, arguments: '{}' }],
  })
  expect((await batch('global')).results[0]?.result.isError).toBe(false)
  expect((await batch('scoped')).results[0]?.result.isError).toBe(false)
  expect(h.calls).toEqual(['global', 'scoped'])
})

it('keeps conditional registrations unavailable and refuses a host-internal batch combined with a selection', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('conditional'), { when: () => true })
  h.ctx.tools.registerAdmissionPolicy(() => [])
  const calls = [{ type: 'tool-call' as const, id: ToolCallId('host-conditional'), name: 'conditional', arguments: '{}' }]
  const result = await h.ctx.tools.execute({ agent: h.agent, signal: h.controller.signal, hostInternalDispatch: { tools: ['conditional'] }, calls })
  expect(result.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
  const toolSet = await h.resolve()
  await expect(h.ctx.tools.execute({ agent: h.agent, signal: h.controller.signal, hostInternalDispatch: { tools: ['conditional'] }, toolSet, calls }))
    .rejects.toThrow('cannot be combined with a toolSet')
  expect(h.calls).toEqual([])
})

it('still refuses a call without a selection and without the host-internal opt-in', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('hidden'))
  h.ctx.tools.registerAdmissionPolicy(() => [])
  const result = await h.ctx.tools.execute({
    agent: h.agent, signal: h.controller.signal,
    calls: [{ type: 'tool-call' as const, id: ToolCallId('plain'), name: 'hidden', arguments: '{}' }],
  })
  expect(result.results[0]?.result.error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls).toEqual([])
})

it('lets a host-internal batch reach only the tools it names, even among unconditional registrations', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('own'))
  h.ctx.tools.register(h.tool('unrelated'))
  h.scope.ctx.tools.register(h.tool('scoped_unrelated'))
  h.ctx.tools.registerAdmissionPolicy(() => [])
  const batch = (names: readonly string[], ...called: string[]) => h.ctx.tools.execute({
    agent: h.agent, signal: h.controller.signal, hostInternalDispatch: { tools: names },
    calls: called.map(name => ({ type: 'tool-call' as const, id: ToolCallId(`host-${name}`), name, arguments: '{}' })),
  })
  const result = await batch(['own'], 'own', 'unrelated', 'scoped_unrelated')
  expect(result.results.map(entry => entry.result.error?.info?.code)).toEqual([undefined, 'UNKNOWN_TOOL', 'UNKNOWN_TOOL'])
  expect(h.calls).toEqual(['own'])
  await expect(batch([], 'own')).rejects.toThrow('must name at least one')
  expect(h.calls).toEqual(['own'])
})
