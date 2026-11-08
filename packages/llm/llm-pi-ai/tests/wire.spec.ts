/** Rejected provider responses reach the harness as structured failures, and one attempt is one request. */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import * as PiAi from '../src/index.ts'
import type { Usage as PiUsage } from '@earendil-works/pi-ai'
import { mapStopReason } from '../src/stream.ts'
import { isWireObservable, observeWire, providerRetryAfterMs } from '../src/wire.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

/** Failure codes the default normal retry policy treats as transient. */
function defaultRetryableCodes(): readonly string[] {
  const policy = resolveRetryPolicy(undefined, 'test')
  if (policy.mode !== 'normal') throw new Error('the default retry policy is the normal policy')
  return policy.retryableCodes
}

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('providerRetryAfterMs', () => {
  const headers = (init: Record<string, string>): Headers => new Headers(init)

  it('reads retry-after-ms before retry-after, in milliseconds', () => {
    expect(providerRetryAfterMs(headers({ 'retry-after-ms': '1500', 'retry-after': '9' }))).toBe(1500)
  })

  it('reads delay-seconds', () => {
    expect(providerRetryAfterMs(headers({ 'retry-after': '7' }))).toBe(7000)
    expect(providerRetryAfterMs(headers({ 'retry-after': '0.5' }))).toBe(500)
  })

  it('reads an HTTP date in the future', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-07T00:00:00Z') })
    try {
      expect(providerRetryAfterMs(headers({ 'retry-after': 'Sat, 07 Nov 2026 00:00:30 GMT' }))).toBe(30_000)
    } finally { vi.useRealTimers() }
  })

  it('ignores absent, past, zero, and unparseable delays', () => {
    expect(providerRetryAfterMs(headers({}))).toBeUndefined()
    expect(providerRetryAfterMs(headers({ 'retry-after': 'Thu, 01 Jan 1970 00:00:00 GMT' }))).toBeUndefined()
    expect(providerRetryAfterMs(headers({ 'retry-after': '0' }))).toBeUndefined()
    expect(providerRetryAfterMs(headers({ 'retry-after': 'soon' }))).toBeUndefined()
    expect(providerRetryAfterMs(headers({ 'retry-after-ms': 'x', 'retry-after': '2' }))).toBe(2000)
  })
})

describe('observeWire', () => {
  it('returns each response untouched and remembers only a rejected one', async () => {
    const ok = new Response('fine')
    const rejected = new Response('no', {
      status: 429, headers: { 'retry-after': '3', 'x-request-id': 'req_1' },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok).mockResolvedValueOnce(rejected)
    const wire = observeWire()

    expect(wire.failure()).toBeUndefined()
    expect(await wire.fetch('http://x.invalid/1')).toBe(ok)
    expect(wire.failure()).toBeUndefined()
    expect(await wire.fetch('http://x.invalid/2')).toBe(rejected)
    expect(wire.failure()).toEqual({ status: 429, providerRetryAfterMs: 3000, requestId: 'req_1' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('records the status alone when the headers say nothing else', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 402 }))
    const wire = observeWire()

    await wire.fetch('http://x.invalid')

    expect(wire.failure()).toEqual({ status: 402 })
  })

  it('falls back to request-id and ignores an empty id', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 500, headers: { 'request-id': 'abc' } }))
      .mockResolvedValueOnce(new Response('', { status: 500, headers: { 'x-request-id': '' } }))
    const wire = observeWire()

    await wire.fetch('http://x.invalid')
    expect(wire.failure()).toEqual({ status: 500, requestId: 'abc' })
    await wire.fetch('http://x.invalid')
    expect(wire.failure()).toEqual({ status: 500 })
  })

  describe('429 error code', () => {
    const rejected = async (body: BodyInit | null, status = 429): Promise<{ response: Response; code: unknown }> => {
      const response = new Response(body, { status })
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response)
      const wire = observeWire()
      await wire.fetch('http://x.invalid')
      return { response, code: (wire.failure() as { providerCode?: string } | undefined)?.providerCode }
    }

    it('keeps error.code from a clone and leaves the original body readable', async () => {
      const { response, code } = await rejected('{"error":{"code":"usage_limit_reached","type":"x"}}')

      expect(code).toBe('usage_limit_reached')
      expect(await response.text()).toBe('{"error":{"code":"usage_limit_reached","type":"x"}}')
    })

    it('falls back to error.type', async () => {
      expect((await rejected('{"error":{"type":"insufficient_quota"}}')).code).toBe('insufficient_quota')
    })

    it('reads a code split across chunks', async () => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"error":{"code":"usage_li'))
          controller.enqueue(encoder.encode('mit_reached"}}'))
          controller.close()
        },
      })

      expect((await rejected(body)).code).toBe('usage_limit_reached')
    })

    it.each([
      ['an absent body', null],
      ['a non-JSON body', 'slow down'],
      ['a JSON body without an error object', '{"error":"slow down"}'],
      ['a non-object JSON body', '3'],
      ['an error object without a code', '{"error":{"message":"m","code":""}}'],
      ['a body over the limit', JSON.stringify({ error: { code: 'usage_limit_reached', pad: 'x'.repeat(20_000) } })],
    ])('records no code for %s', async (_name, body) => {
      expect((await rejected(body)).code).toBeUndefined()
    })

    it('records no code when the clone body fails mid-read', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error('socket reset')) },
      })

      expect((await rejected(body)).code).toBeUndefined()
    })

    it('reads no body for a status that is not 429', async () => {
      expect((await rejected('{"error":{"code":"usage_limit_reached"}}', 503)).code).toBeUndefined()
    })
  })

  it('lets a transport failure through without recording anything', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'))
    const wire = observeWire()

    await expect(wire.fetch('http://x.invalid')).rejects.toThrow('fetch failed')
    expect(wire.failure()).toBeUndefined()
  })

  it('names the APIs whose pi-ai implementation takes a custom fetch', () => {
    for (const api of ['openai-completions', 'openai-responses', 'openai-codex-responses', 'anthropic-messages']) {
      expect(isWireObservable(api)).toBe(true)
    }
    for (const api of ['google-generative-ai', 'bedrock-converse-stream']) expect(isWireObservable(api)).toBe(false)
  })
})

async function gateway(baseURL: string): Promise<Context> {
  vi.stubEnv('PI_WIRE_KEY', 'fixture-key')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { gateway: {
    apiKeyEnv: 'PI_WIRE_KEY', api: 'openai-completions', baseURL, models: [{ id: 'm' }],
  } } })
  return ctx
}

async function finishOf(baseURL: string): Promise<FinishReason> {
  const ctx = await gateway(baseURL)
  return (await assemble(ctx, { provider: 'gateway', model: 'm', messages: [] })).finish
}

describe('a rejected response through the adapter', () => {
  it('preserves native Google errors without claiming structured HTTP details', async () => {
    const server = await mockServer([{
      status: 400, body: JSON.stringify({ error: { code: 400, message: 'Invalid test request', status: 'INVALID_ARGUMENT' } }),
    }])
    vi.stubEnv('PI_WIRE_KEY', 'fixture-key')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(PiAi, { providers: { google: { apiKeyEnv: 'PI_WIRE_KEY', baseURL: server.url } } })
    const model = (await ctx.llm.listModels('google'))[0]!.id

    const { finish } = await assemble(ctx, { provider: 'google', model, messages: [
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }),
    ] })

    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_REQUEST' } })
    expect(JSON.stringify(finish)).toContain('Invalid test request')
    expect(finish).not.toHaveProperty('failure.status')
    expect(server.requests).toHaveLength(1)
  })

  it.each([
    [402, '{"error":{"message":"Payment required"}}', 'QUOTA', {}],
    [429, '{"error":{"message":"Slow down"}}', 'RATE_LIMIT', { 'retry-after': '12', 'x-request-id': 'req_9' }],
    [429, '{"error":{"message":"You exceeded your current quota"}}', 'QUOTA', {}],
    [401, '{"error":{"message":"bad token"}}', 'AUTH', {}],
    [403, '{"error":{"message":"forbidden"}}', 'AUTH', {}],
    [408, '{"error":{"message":"slow client"}}', 'TIMEOUT', {}],
    [422, '{"error":{"message":"unprocessable"}}', 'INVALID_REQUEST', {}],
    [503, '{"error":{"message":"overloaded"}}', 'SERVER', {}],
    [404, '{"error":{"message":"missing"}}', 'PI_AI_ERROR', {}],
  ])('maps %i (%s) to %s with its structured facts', async (status, body, code, headers) => {
    const server = await mockServer([{ status, body, headers }])

    const finish = await finishOf(server.url)

    expect(finish.kind).toBe('error')
    expect(finish).toMatchObject({ failure: { code, status } })
    // One attempt, one request: the adapter never retries underneath the agent.
    expect(server.requests).toHaveLength(1)
  })

  it('carries Retry-After and the request id as failure fields', async () => {
    const server = await mockServer([{
      status: 429, body: '{"error":{"message":"Slow down"}}', headers: { 'retry-after': '12', 'x-request-id': 'req_9' },
    }])

    expect(await finishOf(server.url)).toMatchObject({
      kind: 'error',
      failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 12_000, requestId: 'req_9' },
    })
  })

  it('keeps context overflow ahead of the status', async () => {
    const server = await mockServer([{
      status: 400,
      body: '{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 8 tokens"}}',
    }])

    expect(await finishOf(server.url)).toMatchObject({ kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } })
  })

  it('still completes a healthy response', async () => {
    const server = await mockServer([{ events: textEvents }])

    expect(await finishOf(server.url)).toEqual({ kind: 'stop' })
  })

  it('leaves a transport failure without a status', async () => {
    const server = await mockServer([{ events: textEvents }])
    const url = server.url
    await closeMockServers()

    const finish = await finishOf(url)

    expect(finish.kind).toBe('error')
    expect(finish).not.toHaveProperty('failure.status')
  })
})

describe('Codex Responses over a signed-in grant', () => {
  const jwt = (claims: Record<string, unknown>): string =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
  const account = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_fixture' } })

  async function signedIn(baseURL: string, provider = 'openai-codex'): Promise<Context> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-wire-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor(provider), () => Promise.resolve({
      kind: 'grant',
      payload: { type: 'oauth', access: account, refresh: 'r', expires: Date.now() + 3_600_000 },
    }))
    await ctx.plugin(PiAi, { providers: { [provider]: { baseURL } } })
    return ctx
  }

  it.each(['usage_limit_reached', 'usage_not_included'])('sends one SSE request and maps %s to terminal quota', async (code) => {
    const server = await mockServer([{
      status: 429,
      body: JSON.stringify({ error: { code, message: 'limit', resets_in_seconds: 60 } }),
      headers: { 'retry-after': '60' },
    }])
    const ctx = await signedIn(server.url)
    const model = (await ctx.llm.listModels('openai-codex'))[0]!.id

    const { finish } = await assemble(ctx, { provider: 'openai-codex', model, messages: [] })

    // pi-ai flattens this rejection to "You have hit your ChatGPT usage limit.",
    // so only the provider's structured code says the quota is exhausted.
    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'QUOTA', status: 429, providerRetryAfterMs: 60_000 } })
    expect(finish).not.toHaveProperty('failure.providerCode')
    expect(defaultRetryableCodes()).not.toContain('QUOTA')
    expect(server.paths).toEqual(['/codex/responses'])
    expect(server.headers[0]).toMatchObject({ 'chatgpt-account-id': 'acct_fixture' })
  })

  it.each([
    ['subscription_sharing_usage_limit_exceeded', 'QUOTA', false],
    ['subscription_sharing_usage_unavailable', 'SERVER', true],
    ['subscription_sharing_user_unavailable', 'SERVER', true],
  ] as const)('classifies OpenAI subscription error %s over HTTP and SSE', async (code, inBandCode, retryable) => {
    for (const status of [429, 200]) {
      const error = { code, message: 'Subscription unavailable' }
      const server = await mockServer([status === 429
        ? { status, body: JSON.stringify({ error }) }
        : { events: [JSON.stringify({ type: 'response.failed', response: { status: 'failed', error } })] }])
      const ctx = await signedIn(server.url, 'openai')
      const model = (await ctx.llm.listModels('openai'))[0]!.id
      const { finish } = await assemble(ctx, { provider: 'openai', model, messages: [] })
      const expectedCode = status === 429 && retryable ? 'RATE_LIMIT' : inBandCode

      expect(finish).toMatchObject({ kind: 'error', failure: { code: expectedCode } })
      expect(finish).not.toHaveProperty('failure.providerCode')
      expect(defaultRetryableCodes().includes(expectedCode)).toBe(retryable)
      if (status === 429) expect(finish).toHaveProperty('failure.status', 429)
    }
  })

  it('keeps a transient Codex 429 a retryable rate limit', async () => {
    const server = await mockServer([{
      status: 429,
      body: JSON.stringify({ error: { code: 'rate_limit_exceeded', resets_in_seconds: 2 } }),
      headers: { 'retry-after': '2' },
    }])
    const ctx = await signedIn(server.url)
    const model = (await ctx.llm.listModels('openai-codex'))[0]!.id

    const { finish } = await assemble(ctx, { provider: 'openai-codex', model, messages: [] })

    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 2000 } })
    expect(finish).not.toHaveProperty('failure.providerCode')
    expect(defaultRetryableCodes()).toContain('RATE_LIMIT')
  })

  it('never opens the WebSocket that would re-send a failed request over SSE', async () => {
    const upgrades: string[] = []
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"down"}}')
    })
    server.on('upgrade', (request, socket) => {
      upgrades.push(request.url ?? '')
      socket.destroy()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    const { port } = server.address() as AddressInfo
    const ctx = await signedIn(`http://127.0.0.1:${String(port)}`)
    const model = (await ctx.llm.listModels('openai-codex'))[0]!.id

    const { finish } = await assemble(ctx, { provider: 'openai-codex', model, messages: [] })

    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'SERVER', status: 500 } })
    expect(upgrades).toEqual([])
    expect(requests).toEqual(['/codex/responses'])
  })
})

describe('Codex Responses with an expired sign-in', () => {
  it('names the sign-in step when the stored grant can no longer be refreshed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-expired-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai-codex'), () => Promise.resolve({
      kind: 'grant',
      payload: { type: 'oauth', access: 'expired', refresh: 'revoked', expires: 1 },
    }))
    await ctx.plugin(PiAi)
    const model = (await ctx.llm.listModels('openai-codex'))[0]!.id
    // The vendor's token endpoint refuses the revoked refresh token.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"error":"invalid_grant"}', { status: 400 })))
    onTestFinished(() => { vi.unstubAllGlobals() })

    const { finish } = await assemble(ctx, { provider: 'openai-codex', model, messages: [] })

    expect(finish).toMatchObject({
      kind: 'error',
      failure: { code: 'AUTH', message: expect.stringMatching(/; sign in to openai-codex again$/) as string },
    })
  })
})

const ZERO_USAGE: PiUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

describe('a sign-in failure below pi-ai', () => {
  const failed = (errorMessage: string): FinishReason => mapStopReason(
    { role: 'assistant', content: [], api: 'openai-responses', provider: 'openai', model: 'm', usage: ZERO_USAGE, stopReason: 'error', errorMessage, timestamp: 0 },
  )

  it('leaves a refresh that failed on the network or at the vendor to its own classification', () => {
    expect(failed('OAuth refresh failed for openai-codex: fetch failed')).toMatchObject({ failure: { code: 'TRANSPORT' } })
    expect(failed('OAuth refresh failed for openai-codex: token refresh failed (503)')).toMatchObject({ failure: { code: 'SERVER' } })
    expect(failed('Something else entirely')).toMatchObject({ failure: { code: 'PI_AI_ERROR' } })
  })
})

describe('GitHub Copilot model offer', () => {
  async function copilot(options: { availableModelIds?: unknown; apiKey?: string } = {}): Promise<readonly string[]> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-copilot-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('github-copilot'), () => Promise.resolve({
      kind: 'grant',
      payload: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000,
        ...options.availableModelIds === undefined ? {} : { availableModelIds: options.availableModelIds } },
    }))
    if (options.apiKey !== undefined) vi.stubEnv('PI_COPILOT_OVERRIDE', options.apiKey)
    await ctx.plugin(PiAi, { providers: { 'github-copilot': {
      ...options.apiKey === undefined ? {} : { apiKeyEnv: 'PI_COPILOT_OVERRIDE' },
    } } })
    return (await ctx.llm.listModels('github-copilot')).map(model => model.id)
  }

  it('offers only the models the signed-in account can call', async () => {
    const all = await copilot()
    expect(all.length).toBeGreaterThan(2)
    expect(await copilot({ availableModelIds: [all[0]!, 'not-in-the-catalog'] })).toEqual([all[0]])
  })

  it('offers the whole catalog while the account lists nothing', async () => {
    const all = await copilot()
    expect(await copilot({ availableModelIds: 'malformed' })).toEqual(all)
  })

  it('uses the configured API-key override instead of a stored sign-in to filter models', async () => {
    const all = await copilot()
    expect(await copilot({ availableModelIds: [all[0]!], apiKey: 'configured-key' })).toEqual(all)
  })
})
