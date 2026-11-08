/** The shipped default catalog refuses a known ineffective temperature before listing credential or HTTP work. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallControls, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as ApiKey from '../src/index.ts'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-flash'
const LISTING_URL = 'https://api.deepseek.com/models'
const MESSAGES_URL = 'https://api.deepseek.com/anthropic/v1/messages'
const CUSTOM_ORIGIN = 'https://gateway.example.test'
const OFF = ReasoningEffortId('off')
const HIGH = ReasoningEffortId('high')
const FLASH = (contextWindow = 1_048_576) => ({
  id: MODEL, name: 'DeepSeek-V4.1-Flash', context_window: contextWindow, max_output_tokens: 8192,
  input_modalities: ['text'], output_modalities: ['text'], api_capabilities: { anthropic_messages: {} },
})
const UPGRADE = {
  id: 'deepseek-v5-next', input_modalities: ['text'], output_modalities: ['text'], api_capabilities: { anthropic_messages: {} },
  client_requirements: { 'deepseek-harness': { min_version: '99.0.0-alpha.1' } },
}
const SSE = [
  { type: 'message_start', message: { id: 'msg_1', model: MODEL, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

type LiveConfig = Awaited<ReturnType<typeof liveConfig>>

interface Host {
  readonly ctx: Context
  readonly live: LiveConfig
  /** Credential reads of the host, listing and inference alike. */
  readonly credentialReads: () => number
  /** Every outbound request as `METHOD url`, in order. */
  readonly requests: string[]
  readonly bodies: Record<string, unknown>[]
  /** Hold the next listing response until `release`. */
  readonly holdListing: () => { started: Promise<undefined>; release: () => void }
}

/** Mount the real runtime and API-key plugin; credentials and fetch are the only substitutions. */
async function host(config: Record<string, unknown> = {}, listing: readonly object[] = [FLASH()]): Promise<Host> {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const requests: string[] = []
  const bodies: Record<string, unknown>[] = []
  let hold: { started: PromiseWithResolvers<undefined>; released: Promise<undefined> } | undefined
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    requests.push(`${request.method} ${request.url}`)
    if (request.method === 'GET' && request.url === LISTING_URL) {
      const pending = hold
      hold = undefined
      if (pending !== undefined) {
        pending.started.resolve(undefined)
        await pending.released
      }
      return new Response(JSON.stringify({ object: 'list', data: listing }), { headers: { 'content-type': 'application/json' } })
    }
    if (request.method === 'POST' && request.url.endsWith('/v1/messages')) {
      bodies.push(await request.json() as Record<string, unknown>)
      return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`unexpected request ${request.method} ${request.url}`)
  })
  const resolve = vi.fn(() => Promise.resolve({ value: 'fixture-api-key' }))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('credentials', { resolve } as never)
  await ctx.plugin(LlmRuntime)
  const live = await liveConfig(ctx, ApiKey, config)
  return {
    ctx, live, requests, bodies,
    credentialReads: () => resolve.mock.calls.length,
    holdListing: () => {
      const started = Promise.withResolvers<undefined>()
      const released = Promise.withResolvers<undefined>()
      hold = { started, released: released.promise }
      return { started: started.promise, release: () => { released.resolve(undefined) } }
    },
  }
}

const user = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
type Route = 'prepareCall' | 'stream'
const ROUTES: Route[] = ['prepareCall', 'stream']

/** Run one call on a public route; both settle with the structured failure instead of throwing. */
interface RunExtra {
  signal?: AbortSignal
  model?: string
  configure?: (controls: Readonly<LlmCallControls>, model: Readonly<LlmResolvedModelInfo>) => LlmCallControls
}

async function run(h: Host, route: Route, controls: LlmCallControls, extra: RunExtra = {}) {
  const base = { provider: PROVIDER, model: extra.model ?? MODEL, ...controls }
  if (route === 'prepareCall') {
    return h.ctx.llm.prepareCall(base, extra.signal, extra.configure).then(
      call => ({ ok: true as const, call }),
      (error: unknown) => {
        if (!(error instanceof LlmError)) throw error
        return { ok: false as const, code: error.code, failure: error.failure }
      },
    )
  }
  const output: StreamChunk[] = []
  const signal = extra.signal === undefined ? {} : { signal: extra.signal }
  for await (const chunk of h.ctx.llm.stream({ ...base, messages: [user()], ...signal })) output.push(chunk)
  const end = output.at(-1)
  if (end?.type !== 'finish') throw new Error('stream did not finish')
  return end.reason.kind === 'error' || end.reason.kind === 'aborted'
    ? { ok: false as const, code: end.reason.failure.code, failure: end.reason.failure, kind: end.reason.kind }
    : { ok: true as const, output }
}

const REFUSED = { code: 'UNSUPPORTED_CONTROL', failure: { unsupportedControl: { control: 'temperature', reason: 'reasoning-active' } } }

describe.each(ROUTES)('callback-free %s on the default official catalog', (route) => {
  it('refuses a supplied temperature with default reasoning before any credential read or HTTP request', async () => {
    const h = await host()
    const result = await run(h, route, { temperature: 0.2 })
    expect(result).toMatchObject({ ok: false, ...REFUSED })
    expect(h.credentialReads()).toBe(0)
    expect(h.requests).toEqual([])
  })

  it('refuses an explicit enabled effort the same way', async () => {
    const h = await host()
    expect(await run(h, route, { temperature: 0.2, reasoningEffort: HIGH })).toMatchObject({ ok: false, ...REFUSED })
    expect(h.credentialReads()).toBe(0)
    expect(h.requests).toEqual([])
  })

  it('adds no credential read or HTTP request to a denial after the listing is populated', async () => {
    const h = await host()
    const warm = await run(h, route, { reasoningEffort: OFF, temperature: 0.2 })
    expect(warm.ok).toBe(true)
    const before = { reads: h.credentialReads(), requests: [...h.requests] }
    expect(before.requests).toContain(`GET ${LISTING_URL}`)
    expect(await run(h, 'prepareCall', { temperature: 0.2 })).toMatchObject({ ok: false, ...REFUSED })
    expect(await run(h, 'stream', { temperature: 0.2 })).toMatchObject({ ok: false, ...REFUSED })
    expect(h.credentialReads()).toBe(before.reads)
    expect(h.requests).toEqual(before.requests)
  })

  it('keeps the unsupported-effort verdict of a thinking-disabled connection', async () => {
    const h = await host({ thinking: 'disabled' })
    const result = await run(h, route, { temperature: 0.2, reasoningEffort: HIGH })
    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_REASONING_EFFORT' })
  })

  it('still sends the temperature when reasoning is off or the connection disables thinking', async () => {
    const off = await host()
    expect((await run(off, route, { reasoningEffort: OFF, temperature: 0.2 })).ok).toBe(true)
    const disabled = await host({ thinking: 'disabled' })
    expect((await run(disabled, route, { temperature: 0.2 })).ok).toBe(true)
    if (route === 'stream') {
      expect(off.bodies[0]).toMatchObject({ temperature: 0.2, thinking: { type: 'disabled' } })
      expect(disabled.bodies[0]).toMatchObject({ temperature: 0.2, thinking: { type: 'disabled' } })
    }
  })

  it('keeps temperature-free listed-model refusals and puts a temperature refusal first otherwise', async () => {
    const h = await host({}, [FLASH(), UPGRADE])
    expect(await run(h, route, {}, { model: UPGRADE.id })).toMatchObject({ ok: false, code: 'CLIENT_UPGRADE_REQUIRED' })
    const off = await run(h, route, { reasoningEffort: OFF, temperature: 0.2 }, { model: UPGRADE.id })
    expect(off).toMatchObject({ ok: false, code: 'CLIENT_UPGRADE_REQUIRED' })
    const before = { reads: h.credentialReads(), requests: [...h.requests] }
    expect(await run(h, route, { temperature: 0.2 }, { model: UPGRADE.id })).toMatchObject({ ok: false, ...REFUSED })
    expect({ reads: h.credentialReads(), requests: h.requests }).toEqual(before)
  })

  it('reports a custom origin as unverified and still dispatches it', async () => {
    const h = await host({ baseURL: `${CUSTOM_ORIGIN}/anthropic` })
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      h.requests.push(`${request.method} ${request.url}`)
      h.bodies.push(await request.json() as Record<string, unknown>)
      return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
    })
    const result = await run(h, route, { temperature: 0.2 })
    expect(result.ok).toBe(true)
    if (route === 'prepareCall' && result.ok && 'call' in result) {
      expect(result.call.assessment.fields.temperature).toEqual({ kind: 'unverified', reason: 'protocol-unverified' })
    } else {
      expect(h.requests).toEqual([`POST ${CUSTOM_ORIGIN}/anthropic/v1/messages`])
      expect(h.bodies[0]).toMatchObject({ temperature: 0.2 })
    }
  })
})

describe('LlmRuntime.prepareCall with a ConfigureCall', () => {
  it('runs the callback once on the listed metadata and lets it drop the temperature', async () => {
    const h = await host({}, [FLASH(2_000_000)])
    const seen: unknown[] = []
    const result = await run(h, 'prepareCall', { temperature: 0.2 }, {
      configure: (controls, model) => {
        seen.push({ controls, contextWindow: model.context?.contextWindow, badge: model.reasoning?.defaultEffort })
        const { temperature: _dropped, ...rest } = controls
        return rest
      },
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([{ controls: { temperature: 0.2 }, contextWindow: 2_000_000, badge: HIGH }])
    if (result.ok && 'call' in result) {
      expect(result.call.config).toEqual({ provider: PROVIDER, model: MODEL, reasoningEffort: HIGH, maxTokens: 8192 })
    }
    expect(h.requests).toEqual([`GET ${LISTING_URL}`])
  })

  it('refuses only after the callback, with listing work and no inference request', async () => {
    const h = await host({}, [FLASH()])
    let calls = 0
    const result = await run(h, 'prepareCall', { temperature: 0.2 }, { configure: (controls) => { calls += 1; return controls } })
    expect(result).toMatchObject({ ok: false, ...REFUSED })
    expect(calls).toBe(1)
    expect(h.credentialReads()).toBe(1)
    expect(h.requests).toEqual([`GET ${LISTING_URL}`])
  })

  it('judges the controls the callback returns, in either direction', async () => {
    const enable = await host()
    let enableCalls = 0
    expect(await run(enable, 'prepareCall', { reasoningEffort: OFF, temperature: 0.2 }, {
      configure: (controls) => { enableCalls += 1; return { ...controls, reasoningEffort: HIGH } },
    })).toMatchObject({ ok: false, ...REFUSED })
    expect(enableCalls).toBe(1)
    const disable = await host()
    let disableCalls = 0
    const accepted = await run(disable, 'prepareCall', { temperature: 0.2 }, {
      configure: (controls) => { disableCalls += 1; return { ...controls, reasoningEffort: OFF } },
    })
    expect(disableCalls).toBe(1)
    expect(accepted.ok).toBe(true)
    if (accepted.ok && 'call' in accepted) expect(accepted.call.config).toMatchObject({ temperature: 0.2, reasoningEffort: OFF })
  })

  it('keeps listed-model refusals ahead of the callback', async () => {
    const h = await host({}, [FLASH(), UPGRADE])
    let calls = 0
    expect(await run(h, 'prepareCall', { temperature: 0.2 }, { model: UPGRADE.id, configure: (c) => { calls += 1; return c } }))
      .toMatchObject({ ok: false, code: 'CLIENT_UPGRADE_REQUIRED' })
    expect(calls).toBe(0)
  })
})

describe('accepted-call generation isolation', () => {
  it.each(ROUTES)('dispatches %s with the entry connection while the listing is held and the config replaced', async (route) => {
    const h = await host({ thinking: 'disabled' })
    const gate = h.holdListing()
    const pending = run(h, route, { temperature: 0.2 })
    await gate.started
    await h.live.replace({})
    gate.release()
    const result = await pending
    expect(result.ok).toBe(true)
    if (route === 'prepareCall' && result.ok && 'call' in result) {
      expect(result.call.config).toMatchObject({ reasoningEffort: OFF, temperature: 0.2 })
      expect(result.call.assessment.fields.temperature).toEqual({ kind: 'supported' })
    } else {
      expect(h.requests.at(-1)).toBe(`POST ${MESSAGES_URL}`)
      expect(h.bodies[0]).toMatchObject({ temperature: 0.2, thinking: { type: 'disabled' } })
    }
    // The replacement is live for the next call: default reasoning is now enabled and refuses.
    expect(await run(h, route, { temperature: 0.2 })).toMatchObject({ ok: false, ...REFUSED })
  })
})

describe('cancellation', () => {
  it('rejects a pre-aborted prepareCall with the abort reason and no work', async () => {
    const h = await host()
    const pending = h.ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, temperature: 0.2 }, AbortSignal.abort(new Error('caller gone')))
    await expect(pending).rejects.toThrow('caller gone')
    expect(h.credentialReads()).toBe(0)
    expect(h.requests).toEqual([])
  })

  it('finishes a pre-aborted stream as aborted, never as a control refusal, and sends no request', async () => {
    const h = await host()
    const result = await run(h, 'stream', { temperature: 0.2 }, { signal: AbortSignal.abort(new Error('caller gone')) })
    expect(result).toMatchObject({ ok: false, kind: 'aborted' })
    expect(result).not.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })
    expect(h.requests.filter(request => request.startsWith('POST'))).toEqual([])
  })
})
