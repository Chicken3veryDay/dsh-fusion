/** Temperature is advertised effective only where the captured connection and defaulted reasoning make it so. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PUBLIC_BASE_URL, resolveAdapterOptions } from '../src/index.ts'
import type { ResolvedDeepSeekOptions } from '../src/index.ts'
import { DeepSeekAdapter } from '../src/adapter.ts'
import { adapter, chunks, MODEL, prepareExtensions, server, sse, textEvents, user } from './helpers.ts'

const PROVIDER = 'deepseek-official'
const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  while (cleanup.length) await cleanup.pop()!()
})

/** Count every outbound request; the official origin must never see one for a refused call. */
function trapFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  const trap = vi.fn<typeof fetch>(() => Promise.resolve(new Response(sse(textEvents), { headers: { 'content-type': 'text/event-stream' } })))
  vi.stubGlobal('fetch', trap)
  return trap
}

interface Wired {
  ctx: Context
  resolveAuth: ReturnType<typeof vi.fn>
}

/** Register the real adapter on the real runtime with a counted credential resolver. */
async function wire(connection: () => ResolvedDeepSeekOptions): Promise<Wired> {
  const resolveAuth = vi.fn(() => Promise.resolve({ headers: { 'x-api-key': 'test-key' } }))
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([PROVIDER], new DeepSeekAdapter({
    options: connection, resolveAuth, resolveUserId: () => 'test-user' as never, prepareExtensions,
  }))
  return { ctx, resolveAuth }
}

type Settings = Parameters<typeof resolveAdapterOptions>[0]
const official = (config: Settings = {}) => resolveAdapterOptions({ baseURL: PUBLIC_BASE_URL, ...config })

function refusal(error: unknown) {
  expect(error).toBeInstanceOf(LlmError)
  return (error as LlmError).failure
}

async function streamOutcome(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  return chunks(stream)
}

describe('official DeepSeek endpoint with reasoning active', () => {
  it('refuses a supplied temperature in LlmRuntime.prepareCall before any credential, header or HTTP work', async () => {
    const fetchTrap = trapFetch()
    const connection = official()
    const { ctx, resolveAuth } = await wire(() => connection)
    const error = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, temperature: 0.2, reasoningEffort: HIGH }).then(
      () => undefined, (rejected: unknown) => rejected,
    )
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('UNSUPPORTED_CONTROL')
    expect(refusal(error)).toMatchObject({ unsupportedControl: { control: 'temperature', reason: 'reasoning-active' } })
    expect(resolveAuth).toHaveBeenCalledTimes(0)
    expect(fetchTrap).toHaveBeenCalledTimes(0)
  })

  it('refuses the same call on ctx.llm.stream with zero credential or HTTP work', async () => {
    const fetchTrap = trapFetch()
    const connection = official()
    const { ctx, resolveAuth } = await wire(() => connection)
    const output = await streamOutcome(ctx.llm.stream({
      provider: PROVIDER, model: MODEL, messages: [user()], temperature: 0.2, reasoningEffort: HIGH,
    }))
    expect(output.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CONTROL', unsupportedControl: { control: 'temperature', reason: 'reasoning-active' } } },
    })
    expect(output.filter(chunk => chunk.type === 'block-start')).toEqual([])
    expect(resolveAuth).toHaveBeenCalledTimes(0)
    expect(fetchTrap).toHaveBeenCalledTimes(0)
  })

  it('counts the defaulted enabled reasoning effort when the caller supplies only a temperature', async () => {
    const fetchTrap = trapFetch()
    for (const config of [{}, { reasoningEffort: 'max' as const }, { thinking: 'enabled' as const }]) {
      const connection = official(config)
      const { ctx, resolveAuth } = await wire(() => connection)
      await expect(ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, temperature: 0.7 }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL', failure: { unsupportedControl: { control: 'temperature', reason: 'reasoning-active' } } })
      const output = await streamOutcome(ctx.llm.stream({ provider: PROVIDER, model: MODEL, messages: [user()], temperature: 0.7 }))
      expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CONTROL', unsupportedControl: { control: 'temperature', reason: 'reasoning-active' } } } })
      expect(resolveAuth).toHaveBeenCalledTimes(0)
    }
    expect(fetchTrap).toHaveBeenCalledTimes(0)
  })
})

describe('official DeepSeek endpoint without reasoning', () => {
  it.each([
    ['an explicit off effort', {}, OFF],
    ['a thinking-disabled deployment default', { thinking: 'disabled' as const }, undefined],
    ['an off default effort', { reasoningEffort: 'off' as const }, undefined],
  ])('keeps temperature supported and on the wire for %s', async (_name, config, effort) => {
    const fetchTrap = trapFetch()
    const connection = official(config)
    const { ctx, resolveAuth } = await wire(() => connection)
    const prepared = await ctx.llm.prepareCall({
      provider: PROVIDER, model: MODEL, temperature: 0.2, ...effort === undefined ? {} : { reasoningEffort: effort },
    })
    expect(prepared.assessment.fields.temperature).toEqual({ kind: 'supported' })
    expect(resolveAuth).toHaveBeenCalledTimes(0)
    await chunks(prepared.stream({ ...prepared.config, messages: [user()] }))
    await chunks(ctx.llm.stream({
      provider: PROVIDER, model: MODEL, messages: [user()], temperature: 0.2, ...effort === undefined ? {} : { reasoningEffort: effort },
    }))
    expect(resolveAuth).toHaveBeenCalledTimes(2)
    expect(fetchTrap).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchTrap.mock.calls) {
      expect(url).toBe(`${PUBLIC_BASE_URL}/v1/messages`)
      expect(await new Response(init?.body).json()).toMatchObject({ temperature: 0.2, thinking: { type: 'disabled' } })
    }
  })

  it('does not refuse stop, maxTokens or the defaulted effort when no temperature is supplied', async () => {
    const fetchTrap = trapFetch()
    const connection = official()
    const { ctx, resolveAuth } = await wire(() => connection)
    const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, stop: ['END'], maxTokens: 321 })
    expect(prepared.assessment.fields).toMatchObject({
      reasoningEffort: { kind: 'supported' }, stop: { kind: 'supported' }, maxTokens: { kind: 'supported' },
    })
    expect(prepared.assessment.fields).not.toHaveProperty('temperature')
    await chunks(prepared.stream({ ...prepared.config, messages: [user()] }))
    expect(resolveAuth).toHaveBeenCalledTimes(1)
    expect(fetchTrap).toHaveBeenCalledTimes(1)
    expect(await new Response(fetchTrap.mock.calls[0]?.[1]?.body).json())
      .toMatchObject({ stop_sequences: ['END'], max_tokens: 321, thinking: { type: 'enabled' } })
  })
})

describe('custom Messages endpoints', () => {
  it('reports an unverified effect, never supported or refused, and still sends the field', async () => {
    const http = await server()
    cleanup.push(() => http.close())
    const connection = resolveAdapterOptions({ baseURL: http.url })
    const { ctx, resolveAuth } = await wire(() => connection)
    const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, temperature: 0.2, reasoningEffort: HIGH })
    expect(prepared.assessment.fields.temperature).toEqual({ kind: 'unverified', reason: 'protocol-unverified' })
    expect(prepared.assessment.fields.reasoningEffort).toEqual({ kind: 'supported' })
    expect(resolveAuth).toHaveBeenCalledTimes(0)
    await chunks(prepared.stream({ ...prepared.config, messages: [user()] }))
    expect(http.requests).toHaveLength(1)
    expect(http.requests[0]!.body).toMatchObject({ temperature: 0.2, thinking: { type: 'enabled' } })
  })

  it('keeps temperature supported when reasoning is off', async () => {
    const http = await server()
    cleanup.push(() => http.close())
    const connection = resolveAdapterOptions({ baseURL: http.url })
    const { ctx } = await wire(() => connection)
    const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, temperature: 0.2, reasoningEffort: OFF })
    expect(prepared.assessment.fields.temperature).toEqual({ kind: 'supported' })
  })

  it('does not mistake a loopback gateway or a look-alike host for the official origin', async () => {
    trapFetch()
    for (const baseURL of ['http://127.0.0.1:9/anthropic', 'https://api.deepseek.com.example.test/anthropic', 'https://proxy.example.test/api.deepseek.com']) {
      const connection = resolveAdapterOptions({ baseURL })
      const { ctx } = await wire(() => connection)
      const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, temperature: 0.2, reasoningEffort: HIGH })
      expect(prepared.assessment.fields.temperature, baseURL).toEqual({ kind: 'unverified', reason: 'protocol-unverified' })
    }
  })
})

describe('prepared generation isolation', () => {
  it('keeps the verdict and wire of a call prepared under the previous connection', async () => {
    const fetchTrap = trapFetch()
    let connection = official({ thinking: 'disabled' })
    const { ctx, resolveAuth } = await wire(() => connection)
    const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, temperature: 0.2 })
    expect(prepared.assessment.fields.temperature).toEqual({ kind: 'supported' })
    connection = official()
    await expect(ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, temperature: 0.2 }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })
    await chunks(prepared.stream({ ...prepared.config, messages: [user()] }))
    expect(resolveAuth).toHaveBeenCalledTimes(1)
    expect(fetchTrap).toHaveBeenCalledTimes(1)
    expect(await new Response(fetchTrap.mock.calls[0]?.[1]?.body).json())
      .toMatchObject({ temperature: 0.2, thinking: { type: 'disabled' } })
  })

  it('does not turn a custom-endpoint call into an official refusal after the endpoint is replaced', async () => {
    const http = await server()
    cleanup.push(() => http.close())
    let connection = resolveAdapterOptions({ baseURL: http.url })
    const { ctx } = await wire(() => connection)
    const prepared = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, temperature: 0.2, reasoningEffort: HIGH })
    connection = official()
    expect(prepared.assessment.fields.temperature).toEqual({ kind: 'unverified', reason: 'protocol-unverified' })
    await chunks(prepared.stream({ ...prepared.config, messages: [user()] }))
    expect(http.requests).toHaveLength(1)
    expect(http.requests[0]!.body).toMatchObject({ temperature: 0.2 })
  })

  it('assesses against the same connection the direct adapter prepares with', async () => {
    const llm = adapter({ baseURL: PUBLIC_BASE_URL })
    const prepared = await llm.prepareCall(PROVIDER, MODEL)
    expect(prepared.assessControls({ temperature: 0.2, reasoningEffort: HIGH }).fields.temperature)
      .toEqual({ kind: 'unsupported', reason: 'reasoning-active' })
    expect(prepared.assessControls({ temperature: 0.2, reasoningEffort: OFF }).fields.temperature)
      .toEqual({ kind: 'supported' })
  })
})
