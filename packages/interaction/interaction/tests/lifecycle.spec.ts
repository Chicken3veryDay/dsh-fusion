/** Exact-Agent interaction ownership and serialized provider lifetime. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import Interaction, { interactionProviderId, type InteractionProvider } from '../src/index.ts'

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Interaction)
  ctx.llm.registerAdapter(['idle'], new IdleModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('interaction-lifetime'), { provider: 'idle', model: 'fixture' })
  return { ctx, agent }
}
const operation = { domain: 'desktop', method: 'observe' } as const
const signal = new AbortController().signal
function provider(open: InteractionProvider['open']): InteractionProvider {
  return { domain: 'desktop', describe: () => ({ id: interactionProviderId('fixture'), domains: ['desktop'], availability: 'ready' }), open }
}

it('rejects empty provider identifiers', () => { expect(() => interactionProviderId('  ')).toThrow('non-empty') })

it('refuses absent, unavailable, and retired Agent capabilities', async () => {
  const { ctx, agent } = await setup()
  expect(ctx.interaction.available(agent, 'desktop')).toBe(false)
  await expect(ctx.interaction.run(agent, 'desktop', operation, signal)).rejects.toThrow('unavailable')
  const dispose = ctx.interaction.register({ ...provider(async () => ({ execute: async () => null, close: async () => {} })),
    describe: () => ({ id: interactionProviderId('fixture'), domains: ['desktop'], availability: 'unavailable' }) })
  await expect(ctx.interaction.run(agent, 'desktop', operation, signal)).rejects.toThrow('unavailable')
  await dispose()
  const release = ctx.interaction.register(provider(async () => ({ execute: async () => null, close: async () => {} })))
  expect(ctx.interaction.available(agent, 'desktop')).toBe(true)
  expect(ctx.interaction.available(agent, 'desktop', 'observe')).toBe(false)
  const foreign = await setup()
  expect(ctx.interaction.available(foreign.agent, 'desktop')).toBe(false)
  await expect(ctx.interaction.run(foreign.agent, 'desktop', operation, signal)).rejects.toThrow('live Agent')
  await release()
})

it('hides a provider from, and rejects a direct run for, an Agent it does not admit', async () => {
  const { ctx, agent } = await setup()
  const open = vi.fn<InteractionProvider['open']>(async () => ({ execute: async () => 'ran', close: async () => {} }))
  const admits = vi.fn<NonNullable<InteractionProvider['admits']>>(() => false)
  const release = ctx.interaction.register({ ...provider(open), admits })
  expect(ctx.interaction.available(agent, 'desktop')).toBe(false)
  await expect(ctx.interaction.run(agent, 'desktop', operation, signal)).rejects.toThrow('not available to this Session')
  expect(open).not.toHaveBeenCalled()
  admits.mockReturnValue(true)
  expect(ctx.interaction.available(agent, 'desktop')).toBe(true)
  await expect(ctx.interaction.run(agent, 'desktop', operation, signal)).resolves.toBe('ran')
  await release()
})

it('serializes operations and makes repeated disposal await the same cleanup', async () => {
  const { ctx, agent } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>()
  const close = vi.fn(async () => { await closed.promise })
  const execute = vi.fn(async () => { entered.resolve(undefined); await finish.promise; return 'done' })
  const release = ctx.interaction.register(provider(async () => ({ execute, close })))
  const first = ctx.interaction.run(agent, 'desktop', operation, signal)
  const second = ctx.interaction.run(agent, 'desktop', operation, signal)
  const firstRejected = expect(first).rejects.toThrow('closing')
  const secondRejected = expect(second).rejects.toThrow('closing')
  await entered.promise
  const disposing = release()
  const again = release()
  expect(ctx.interaction.available(agent, 'desktop')).toBe(false)
  await expect(ctx.interaction.run(agent, 'desktop', operation, signal)).rejects.toThrow('unavailable')
  finish.resolve(undefined)
  closed.resolve(undefined)
  await Promise.all([disposing, again, firstRejected, secondRejected])
  expect(execute).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
  expect(ctx.interaction.describe('desktop')).toBeUndefined()
})

it('allows a fresh session after opening fails and contains cleanup of failed opens', async () => {
  const { ctx, agent } = await setup()
  const open = vi.fn<InteractionProvider['open']>().mockRejectedValueOnce(new Error('open refused'))
    .mockResolvedValue({ execute: async () => 'retry succeeded', close: async () => {} })
  const release = ctx.interaction.register(provider(open))
  await expect(ctx.interaction.run(agent, 'desktop', operation, signal)).rejects.toThrow('open refused')
  await expect(ctx.interaction.run(agent, 'desktop', operation, signal)).resolves.toBe('retry succeeded')
  await release()
  expect(open).toHaveBeenCalledTimes(2)
})

it('reports provider cleanup failure while keeping the domain unavailable', async () => {
  const { ctx, agent } = await setup()
  const release = ctx.interaction.register(provider(async () => ({ execute: async () => null, close: async () => { throw new Error('close failed') } })))
  await ctx.interaction.run(agent, 'desktop', operation, signal)
  await expect(release()).rejects.toThrow('cleanup failed')
  expect(ctx.interaction.available(agent, 'desktop')).toBe(false)
})


it('refuses to open a session when metadata inspection starts provider disposal', async () => {
  const { ctx, agent } = await setup()
  const open = vi.fn<InteractionProvider['open']>(async () => ({ execute: async () => null, close: async () => {} }))
  const adapter = provider(open)
  let release: () => Promise<void> = async () => {}
  let disposal: Promise<void> | undefined
  release = ctx.interaction.register({ ...adapter, describe() {
    disposal = release()
    return adapter.describe()
  } })
  await expect(ctx.interaction.run(agent, 'desktop', operation, signal)).rejects.toThrow('provider is closing')
  await disposal
  expect(open).not.toHaveBeenCalled()
  expect(ctx.interaction.describe('desktop')).toBeUndefined()
})
