/** Normalized tools retain JSON data and admit only supported rich content. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Interaction, { interactionProviderId } from '@deepseek-ai/dsh-interaction'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, expect, it, vi } from 'vitest'
import * as InteractionTools from '../src/index.ts'

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })
async function setup(value: JsonValue, domain: 'browser' | 'desktop' = 'browser') {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Interaction)
  await ctx.plugin(InteractionTools)
  ctx.llm.registerAdapter(['idle'], new IdleModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('interaction-results'), { provider: 'idle', model: 'fixture' })
  const release = ctx.interaction.register({ domain,
    describe: () => ({ id: interactionProviderId('fixture'), domains: [domain], methods: ['observe'], availability: 'ready' }),
    open: async () => ({ execute: async () => value, close: async () => {} }),
  })
  const name = `${domain}_observe`
  const signal = new AbortController().signal
  const args = domain === 'browser' ? { instruction: 'Inspect page' } : {}
  return { ctx, agent, release, name, signal, args, async run() {
    const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'idle', model: 'fixture' } })
    try { return await executeModelToolFixture(ctx, { agent, name, arguments: args, callId: ToolCallId('normalized'), signal, toolSet }) }
    finally { toolSet.dispose() }
  } }
}

it.each([null, true, 42, 'hello', [], {}, { content: [] }, { content: [null, 42, [], {}, { type: 'image', attachment: null }, { type: 'image', attachment: {} }] }])('renders unsupported rich data as lossless JSON (%j)', async (value) => {
  const h = await setup(value)
  const result = await h.run()
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ result: value, provider: 'fixture', domain: 'browser', method: 'observe' })
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }])
})

it.each([
  { isError: true },
  { isError: true, error: null },
  { isError: true, error: [] },
  { isError: true, error: {} },
  ...[null, [], 'invalid', {}, { name: 'X', code: 'Y', reason: 1 }].map(info => ({ isError: true, error: { message: 'refused', info } })),
] satisfies JsonValue[])('contains malformed delegated failures (%j)', async (value) => {
  const h = await setup(value)
  const result = await h.run()
  expect(result.isError).toBe(true)
  expect(result.error?.message).toContain('Interaction provider returned')
  expect(result.value).toBeUndefined()
})

it.each([undefined, { name: 'ProviderError', code: 'REFUSED' }])('retains valid failure details without optional fields (%j)', async (info) => {
  const h = await setup({ isError: true, error: { message: 'refused', ...info === undefined ? {} : { info } } })
  const result = await h.run()
  expect(result).toMatchObject({ isError: true, error: { message: 'refused', ...info === undefined ? {} : { info } }, content: [] })
})

it.each(['browser', 'desktop'] as const)('presents %s calls, results and image names for live and replay consumers', async (domain) => {
  const attachment = { attachmentId: 'image', mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'screen.png' }
  const h = await setup({ content: [{ type: 'text', text: 'State' }, { type: 'image', attachment }] }, domain)
  const result = await h.run()
  expect(result.content).toEqual([{ type: 'text', text: 'State' }, { type: 'image', attachment }])
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'idle', model: 'fixture' } })
  const tool = h.ctx.tools.get(h.name, h.agent, toolSet)
  toolSet.dispose()
  expect(tool?.presentCall?.(h.args)).toEqual({ card: 'generic', title: `${domain === 'browser' ? 'Browser' : 'Desktop'} observe` })
  expect(tool?.presentResult?.(h.args, result)).toEqual({ card: 'generic', title: `${domain === 'browser' ? 'Browser' : 'Desktop'} observe`, content: result.content })
  expect(result.meta).toMatchObject({ domain, method: 'observe', provider: 'fixture' })
})

it('requires Agent ownership even for direct tool execution', async () => {
  const h = await setup(null)
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'idle', model: 'fixture' } })
  const definition = h.ctx.tools.get(h.name, h.agent, toolSet)!
  toolSet.dispose()
  h.ctx.tools.register({ ...definition, name: 'unowned_observe' })
  const result = await executeToolFixture(h.ctx, { name: 'unowned_observe', arguments: h.args, callId: ToolCallId('unowned'), signal: h.signal })
  expect(result.isError).toBe(true)
  expect(result.error?.message).toContain('Agent-owned')
})

it.each(['browser', 'desktop'] as const)('retains the completed %s result after its provider unloads', async (domain) => {
  const h = await setup('completed', domain)
  const run = h.ctx.interaction.run.bind(h.ctx.interaction)
  vi.spyOn(h.ctx.interaction, 'run').mockImplementation(async (...args) => {
    const value = await run(...args)
    await h.release()
    return value
  })
  const result = await h.run()
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ result: 'completed', provider: 'unknown' })
})

it('omits interaction guidance when neither domain is available', async () => {
  const h = await setup(null)
  await h.release()
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'idle', model: 'fixture' } })
  try {
    const assembly = await h.ctx.systemPrompt.assemble({ scope: h.agent, toolSet })
    expect(assembly.sections.some(section => section.text.includes('Interaction tools are agent-native'))).toBe(false)
  } finally { toolSet.dispose() }
})

it.each(['browser', 'desktop'] as const)('includes interaction guidance for a ready %s provider', async (domain) => {
  const h = await setup(null, domain)
  const toolSet = await h.ctx.tools.resolve({ agent: h.agent, signal: h.signal, modelSelection: { provider: 'idle', model: 'fixture' } })
  try {
    const assembly = await h.ctx.systemPrompt.assemble({ scope: h.agent, toolSet })
    expect(assembly.sections.some(section => section.text.includes('Interaction tools are agent-native'))).toBe(true)
  } finally { toolSet.dispose() }
})
