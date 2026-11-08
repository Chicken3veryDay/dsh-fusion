/** The account route judges a temperature by its own origin: official refuses before token or listing work, others stay unverified. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallControls, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as Account from '../src/index.ts'

const PROVIDER = 'deepseek-account'
const MODEL = 'deepseek-flash'
const OFFICIAL_ORIGIN = 'https://api.deepseek.com'
const CUSTOM_ORIGIN = 'https://gateway.example.test'
const OFF = ReasoningEffortId('off')
const FLASH = {
  id: MODEL, name: 'DeepSeek-V4.1-Flash', context_window: 1_048_576, max_output_tokens: 8192,
  input_modalities: ['text'], output_modalities: ['text'], api_capabilities: { anthropic_messages: {} },
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
  vi.restoreAllMocks()
})

/** Mount the real runtime and account plugin; the token service and fetch are the only substitutions. */
async function host(origin: string) {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const requests: string[] = []
  const bodies: Record<string, unknown>[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    requests.push(`${request.method} ${request.url}`)
    if (request.method === 'GET' && request.url === `${origin}/models`) {
      return new Response(JSON.stringify({ object: 'list', data: [FLASH] }), { headers: { 'content-type': 'application/json' } })
    }
    if (request.method === 'POST' && request.url.endsWith('/v1/messages')) {
      bodies.push(await request.json() as Record<string, unknown>)
      return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`unexpected request ${request.method} ${request.url}`)
  })
  const resolveToken = vi.fn(() => Promise.resolve('fixture-account-token'))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.provide('deepseekAccount', { resolveToken } as never)
  await ctx.plugin(Account, origin === OFFICIAL_ORIGIN ? {} : { baseURL: `${origin}/anthropic` })
  return { ctx, requests, bodies, tokenReads: () => resolveToken.mock.calls.length }
}
type Host = Awaited<ReturnType<typeof host>>

type Route = 'prepareCall' | 'stream'
const ROUTES: Route[] = ['prepareCall', 'stream']

async function run(h: Host, route: Route, controls: LlmCallControls) {
  const base = { provider: PROVIDER, model: MODEL, ...controls }
  if (route === 'prepareCall') {
    return h.ctx.llm.prepareCall(base).then(
      call => ({ ok: true as const, call }),
      (error: unknown) => {
        if (!(error instanceof LlmError)) throw error
        return { ok: false as const, code: error.code, failure: error.failure }
      },
    )
  }
  const output: StreamChunk[] = []
  const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })]
  for await (const chunk of h.ctx.llm.stream({ ...base, messages })) output.push(chunk)
  const end = output.at(-1)
  if (end?.type !== 'finish') throw new Error('stream did not finish')
  return end.reason.kind === 'error'
    ? { ok: false as const, code: end.reason.failure.code, failure: end.reason.failure }
    : { ok: true as const }
}

const REFUSED = { code: 'UNSUPPORTED_CONTROL', failure: { unsupportedControl: { control: 'temperature', reason: 'reasoning-active' } } }

describe.each(ROUTES)('callback-free %s on the account route at the official origin', (route) => {
  it('refuses a supplied temperature with default reasoning before any token read or HTTP request', async () => {
    const h = await host(OFFICIAL_ORIGIN)
    expect(await run(h, route, { temperature: 0.2 })).toMatchObject({ ok: false, ...REFUSED })
    expect(h.tokenReads()).toBe(0)
    expect(h.requests).toEqual([])
  })

  it('adds no token read or HTTP request to a denial after the listing is populated', async () => {
    const h = await host(OFFICIAL_ORIGIN)
    expect((await run(h, route, { reasoningEffort: OFF, temperature: 0.2 })).ok).toBe(true)
    const before = { reads: h.tokenReads(), requests: [...h.requests] }
    expect(before.requests).toContain(`GET ${OFFICIAL_ORIGIN}/models`)
    expect(await run(h, 'prepareCall', { temperature: 0.2 })).toMatchObject({ ok: false, ...REFUSED })
    expect(await run(h, 'stream', { temperature: 0.2 })).toMatchObject({ ok: false, ...REFUSED })
    expect({ reads: h.tokenReads(), requests: h.requests }).toEqual(before)
  })
})

describe.each(ROUTES)('callback-free %s on the account route at a custom origin', (route) => {
  it('stays unverified and dispatches, never an early refusal', async () => {
    const h = await host(CUSTOM_ORIGIN)
    const result = await run(h, route, { temperature: 0.2 })
    expect(result.ok).toBe(true)
    if (route === 'prepareCall' && 'call' in result) {
      expect(result.call.assessment.fields.temperature).toEqual({ kind: 'unverified', reason: 'protocol-unverified' })
    } else {
      expect(h.bodies[0]).toMatchObject({ temperature: 0.2 })
    }
  })
})
