/**
 * Provider-seam regressions for account offers, bounded lookups, selection,
 * refresh announcements and the Messages subscription restriction. Every
 * request goes through the installed pi-ai implementations to a loopback
 * listener or a rerouted transport; no real credential or vendor host is used.
 */
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Provider } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { catalogProvider } from '../src/catalog.ts'
import { resolveProfiles } from '../src/config.ts'
import { discoverModelsWithin } from '../src/discovery.ts'
import * as PiAi from '../src/index.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await closeMockServers()
})

const OFFICIAL = 'https://api.openai.com/v1'
const grant = { kind: 'grant', payload: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 4_000_000_000_000, clientId: 'login-one' } } as const
const text = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
const completed = [
  JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
  JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: text }),
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: text }),
  JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [text], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } }),
]
const listing = (...slugs: string[]): string => JSON.stringify({ models: slugs.map(slug => ({ slug, display_name: `Name ${slug}`, visibility: 'list' })) })
const request = { provider: 'openai', model: 'gpt-5.4', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Custom request' }] })] }

/** A mounted harness with one stored ChatGPT grant and the given plugin configuration. */
async function mounted(config: PiAi.Options | undefined, record: typeof grant | undefined = grant): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-signin-seam-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yml'), watch: false })
  if (record !== undefined) await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve(record))
  await ctx.plugin(PiAi, config)
  return ctx
}

/** Send the official ChatGPT-plan origin to a loopback server while leaving every model descriptor untouched. */
function rerouteOfficial(server: { url: string }): void {
  const transport = globalThis.fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(`${OFFICIAL}/`)) throw new Error(`unexpected request to ${url}`)
    return transport(`${server.url}/v1${url.slice(OFFICIAL.length)}`, init)
  })
}

/** A listener that accepts a request and then never answers (`none`) or stalls after the headers (`body`). */
async function stalledServer(mode: 'none' | 'body') {
  const sockets = new Set<Socket>()
  const received = Promise.withResolvers<undefined>()
  const drained = Promise.withResolvers<undefined>()
  const server = createServer((_request, response) => {
    received.resolve(undefined)
    if (mode === 'body') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"models":[')
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      if (sockets.size === 0) drained.resolve(undefined)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, received: received.promise, drained: drained.promise, open: () => sockets.size }
}

describe('account offers are exactly what the same configuration can resolve', () => {
  it('keeps the known models usable when the account also lists an unconfigured slug', async () => {
    const server = await mockServer([{ body: listing('gpt-5.4-mini', 'gpt-future-unlisted', 'gpt-5.4') }])
    const ctx = await mounted({ providers: { openai: { baseURL: `${server.url}/v1` } } })
    const offers = await ctx.llm.listModels('openai')
    expect(offers.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'gpt-5.4-mini', name: 'Name gpt-5.4-mini' },
      { id: 'gpt-5.4', name: 'Name gpt-5.4' },
    ])
    for (const offer of offers) await expect(ctx.llm.resolveModelInfo('openai', offer.id)).resolves.toMatchObject({ id: offer.id })
    await expect(ctx.llm.resolveModelInfo('openai', 'gpt-future-unlisted')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })

  it('respects explicit models narrowing', async () => {
    const server = await mockServer([{ body: listing('gpt-5.4-mini', 'gpt-5.4') }])
    const ctx = await mounted({ providers: { openai: { baseURL: `${server.url}/v1`, models: [{ id: 'gpt-5.4' }] } } })
    expect((await ctx.llm.listModels('openai')).map(({ id }) => id)).toEqual(['gpt-5.4'])
  })

  it('offers an account slug once explicit metadata exists, with no guessed capacities', async () => {
    const server = await mockServer([{ body: listing('gpt-future-unlisted', 'gpt-5.4') }])
    const ctx = await mounted({ providers: { openai: { baseURL: `${server.url}/v1`, models: [{ id: 'gpt-5.4' }, { id: 'gpt-future-unlisted', contextWindow: 123_456, maxTokens: 7_890 }] } } })
    expect((await ctx.llm.listModels('openai')).map(({ id }) => id)).toEqual(['gpt-future-unlisted', 'gpt-5.4'])
    await expect(ctx.llm.resolveModelInfo('openai', 'gpt-future-unlisted')).resolves.toMatchObject({ context: { contextWindow: 123_456 } })
  })

  it('does not mark an unresolvable slug selectable and selects a registered one without a listing request', async () => {
    const server = await mockServer([])
    const ctx = await mounted({ providers: { openai: { baseURL: `${server.url}/v1` } } })
    expect(await ctx.llm.canSelectModel('openai', 'gpt-5.4')).toBe(true)
    expect(await ctx.llm.canSelectModel('openai', 'gpt-future-unlisted')).toBe(false)
    expect(server.paths).toEqual([])
  })

  it('reports each withheld set once and withholds a model whose configured metadata is invalid', async () => {
    const server = await mockServer([{ body: listing('gpt-5.4', 'gpt-future-unlisted') }, { body: listing('gpt-5.4', 'gpt-future-unlisted') }])
    const ctx = await mounted({ providers: { openai: { baseURL: `${server.url}/v1`, models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }] } } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    expect((await ctx.llm.listModels('openai')).map(({ id }) => id)).toEqual([])
    await ctx.llm.listModels('openai')
    const reports = warn.mock.calls.filter(([message]) => String(message).includes('gpt-future-unlisted'))
    expect(reports).toHaveLength(1)
    expect(await ctx.llm.canSelectModel('openai', 'gpt-5.4')).toBe(false)
    expect(await ctx.llm.canSelectModel('openai', 'gpt-5.4-mini')).toBe(true)
  })

  it('selects a registered model while the listing answers 503 and the same grant still infers', async () => {
    const server = await mockServer([{ status: 503, body: '{}' }, { events: completed }])
    const ctx = await mounted({ providers: { openai: { baseURL: `${server.url}/v1` } } })
    await expect(ctx.llm.listModels('openai')).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(await ctx.llm.canSelectModel('openai', 'gpt-5.4')).toBe(true)
    expect((await assemble(ctx, request)).finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/v1/models', '/v1/responses'])
  })
})

describe('selection on routes that are not the signed-in account', () => {
  const gateway: PiAi.PiAiProviderProfile = {
    api: 'openai-completions',
    baseURL: 'https://unused.invalid',
    models: [{ id: 'gw-1', contextWindow: 1000, maxTokens: 100 }],
  }

  it('uses the advertised catalog for a configured route', async () => {
    const ctx = await mounted({ providers: { gw: gateway } }, undefined)
    expect(await ctx.llm.canSelectModel('gw', 'gw-1')).toBe(true)
    expect(await ctx.llm.canSelectModel('gw', 'gw-2')).toBe(false)
  })

  /** An adapter over a hand-built profile whose key resolution fails as the plugin's does. */
  function failingKey(failure: Error): PiAiAdapter {
    const profiles = resolveProfiles({ gw: gateway })
    return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.reject(failure), auth: memoryAuth() })
  }

  it('does not offer a model while the route\'s named credential is missing', async () => {
    const missing = failingKey(new LlmError('no key', 'MISSING_CREDENTIAL'))
    expect(await missing.canSelectModel('gw', 'gw-1')).toBe(false)
  })

  it('reports any other key-resolution failure instead of answering', async () => {
    await expect(failingKey(new LlmError('store down', 'AUTH')).canSelectModel('gw', 'gw-1')).rejects.toMatchObject({ code: 'AUTH' })
  })
})

describe('bounded model lookups', () => {
  it.each(['none', 'body'] as const)('settles a listing that stalls (%s) at its configured deadline and releases the connection', async (mode) => {
    const silent = await stalledServer(mode)
    const ctx = await mounted({ providers: { openai: { baseURL: `${silent.url}/v1`, modelListTimeoutMs: 4_000 } } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const settled = ctx.llm.listModels('openai').then(() => undefined, (error: unknown) => error)
    await silent.received
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await settled).toMatchObject({ code: 'TIMEOUT' })
    await silent.drained
    expect(silent.open()).toBe(0)
  })

  it('leaves other provider groups usable while one listing never answers', async () => {
    const silent = await stalledServer('none')
    const ctx = await mounted({ providers: {
      openai: { baseURL: `${silent.url}/v1`, modelListTimeoutMs: 4_000 },
      gw: { api: 'openai-completions', baseURL: `${silent.url}/gw`, models: [{ id: 'gw-1', contextWindow: 1000, maxTokens: 100 }] },
    } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const results = Promise.allSettled(ctx.llm.listProviders().map(provider => ctx.llm.listModels(provider.id)))
    await silent.received
    await vi.advanceTimersByTimeAsync(4_000)
    const [first, second] = await results
    const byProvider = new Map(ctx.llm.listProviders().map((provider, index) => [provider.id, [first, second][index]]))
    expect(byProvider.get('gw')).toMatchObject({ status: 'fulfilled', value: [{ id: 'gw-1' }] })
    expect(byProvider.get('openai')).toMatchObject({ status: 'rejected' })
  })

  it('cancels an in-flight listing and closes its connection when the plugin shuts down', async () => {
    const silent = await stalledServer('none')
    const ctx = await mounted({ providers: { openai: { baseURL: `${silent.url}/v1` } } })
    const settled = ctx.llm.listModels('openai').then(() => undefined, (error: unknown) => error)
    await silent.received
    await ctx.fiber.dispose()
    expect(await settled).toBeInstanceOf(Error)
    await silent.drained
    expect(silent.open()).toBe(0)
  })

  it('bounds draft discovery of an account route the same way', async () => {
    const silent = await stalledServer('none')
    const ctx = await mounted({ providers: { openai: { baseURL: `${silent.url}/v1`, modelListTimeoutMs: 4_000 } } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const settled = ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' }).then(() => undefined, (error: unknown) => error)
    await silent.received
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await settled).toMatchObject({ code: 'TIMEOUT' })
    await silent.drained
  })
})

describe('credential waits inside a bounded lookup', () => {
  /** Let every pending promise reaction run; timers are not involved. */
  const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
  /** The lookup's outcome if it has settled by now, else 'pending'. */
  const observe = async (settled: Promise<unknown>): Promise<unknown> => Promise.race([settled, flush().then(() => 'pending')])

  it.each(['deadline', 'caller', 'lifetime'] as const)('settles draft discovery at the %s while the stored key resolver is held, and sends nothing once it returns', async (trigger) => {
    const sends = vi.fn(() => Promise.resolve(Response.json({ data: [] })))
    vi.stubGlobal('fetch', sends)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<string>()
    const caller = new AbortController()
    const lifetime = new AbortController()
    const settled = discoverModelsWithin({ timeoutMs: 4_000, lifetime: lifetime.signal },
      { provider: 'synthetic-gateway', api: 'openai-completions', baseURL: 'http://127.0.0.1:9', signal: caller.signal },
      () => ({ headers: undefined, resolveApiKey: () => { entered.resolve(undefined); return gate.promise } }))
      .then(() => 'fulfilled', (error: unknown) => (error as LlmError).code)
    await entered.promise
    if (trigger === 'deadline') await vi.advanceTimersByTimeAsync(4_000)
    if (trigger === 'caller') caller.abort()
    if (trigger === 'lifetime') lifetime.abort()
    expect(await observe(settled)).toBe(trigger === 'deadline' ? 'TIMEOUT' : 'ABORTED')
    expect(vi.getTimerCount()).toBe(0)
    gate.resolve('ordinary-synthetic-key')
    await flush()
    expect(sends).not.toHaveBeenCalled()
  })

  /** An account adapter whose credential reads wait on one gate. */
  function heldAccount(lifetime: AbortSignal) {
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const auth = memoryAuth({ openai: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 4_000_000_000_000 } })
    const read = auth.credentials.read.bind(auth.credentials)
    const reads: (AbortSignal | undefined)[] = []
    auth.credentials.read = async (id, options) => {
      reads.push(options?.signal)
      entered.resolve(undefined)
      await gate.promise
      return read(id, options)
    }
    const unoffered = vi.fn()
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ openai: { baseURL: 'http://127.0.0.1:9/v1', modelListTimeoutMs: 4_000 } }),
      resolveApiKey: () => Promise.resolve(undefined), auth, lifetime, onUnofferedAccountModels: unoffered,
    })
    return { adapter, entered: entered.promise, release: () => { gate.resolve(undefined) }, reads, unoffered }
  }

  it.each(['deadline', 'lifetime', 'caller'] as const)('settles an account lookup at the %s while its initial credential read is held, then neither lists nor reports', async (trigger) => {
    const sends = vi.fn(() => Promise.resolve(new Response(listing('gpt-5.4', 'gpt-future-unlisted'))))
    vi.stubGlobal('fetch', sends)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const lifetime = new AbortController()
    const caller = new AbortController()
    const held = heldAccount(lifetime.signal)
    const lookup = trigger === 'caller'
      ? held.adapter.canSelectModel('openai', 'gpt-5.4', caller.signal)
      : held.adapter.listModels('openai')
    const settled = lookup.then(() => 'fulfilled', (error: unknown) => (error as LlmError).code)
    await held.entered
    expect(held.reads[0]?.aborted).toBe(false)
    if (trigger === 'deadline') await vi.advanceTimersByTimeAsync(4_000)
    if (trigger === 'lifetime') lifetime.abort()
    if (trigger === 'caller') caller.abort()
    expect(await observe(settled)).toBe(trigger === 'deadline' ? 'TIMEOUT' : 'ABORTED')
    expect(held.reads[0]?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    held.release()
    await flush()
    await flush()
    expect(sends).not.toHaveBeenCalled()
    expect(held.unoffered).not.toHaveBeenCalled()
  })

  it('still lists and reports when the held read returns before the deadline', async () => {
    const sends = vi.fn(() => Promise.resolve(new Response(listing('gpt-5.4', 'gpt-future-unlisted'))))
    vi.stubGlobal('fetch', sends)
    const held = heldAccount(new AbortController().signal)
    const listed = held.adapter.listModels('openai')
    await held.entered
    held.release()
    expect((await listed).map(({ id }) => id)).toEqual(['gpt-5.4'])
    expect(sends).toHaveBeenCalledTimes(1)
    expect(held.unoffered).toHaveBeenCalledWith({ provider: 'openai', models: ['gpt-future-unlisted'] })
  })

  it('does not start a lookup whose caller has already given up', async () => {
    const held = heldAccount(new AbortController().signal)
    const aborted = new AbortController()
    aborted.abort()
    await expect(held.adapter.canSelectModel('openai', 'gpt-5.4', aborted.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(held.reads).toEqual([])
  })
})

describe('official ChatGPT-plan origin', () => {
  it('sends the plan-only request shape to api.openai.com while only the transport is rerouted', async () => {
    const server = await mockServer([{ body: listing('gpt-5.4') }, { events: completed }])
    rerouteOfficial(server)
    const ctx = await mounted(undefined)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    expect((await ctx.llm.listModels('openai')).map(({ id }) => id)).toEqual(['gpt-5.4'])
    const result = await assemble(ctx, { ...request, system: 'Custom system prompt', maxTokens: 500, tools: [{ name: 'custom_tool', description: 'Custom tool', parameters: { type: 'object', properties: {} } }] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/v1/models', '/v1/responses'])
    expect(server.headers[1]?.authorization).toBe('Bearer synthetic-access')
    expect(server.requests[1]).toMatchObject({ store: false, stream: true, model: 'gpt-5.4', tools: [{ name: 'custom_tool' }] })
    expect(server.requests[1]).not.toHaveProperty('max_output_tokens')
    expect(server.requests[1]).not.toHaveProperty('prompt_cache_retention')
    expect(JSON.stringify(server.requests[1])).toContain('Custom system prompt')
  })
})

describe('refresh announcements', () => {
  it('does not re-announce offers when an ordinary refresh rotates the same login, but does for a new login', async () => {
    const server = await mockServer([{ events: completed }])
    const ctx = await mounted({ providers: { openai: { baseURL: `${server.url}/v1` } } })
    const updates: number[] = []
    ctx.on('llm/adapters-updated', () => { updates.push(updates.length) })
    const transport = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.startsWith(server.url)) return transport(input, init)
      return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' })
    })
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve({ ...grant, payload: { ...grant.payload, expires: 1 } }))
    updates.length = 0
    expect((await assemble(ctx, request)).finish).toEqual({ kind: 'stop' })
    expect(await ctx.credentials.readRecord(PiAi.recordKeyFor('openai'))).toMatchObject({ payload: { access: 'rotated-access', clientId: 'login-one' } })
    const changed = new Promise<void>((resolve) => { ctx.on('llm/adapters-updated', () => { resolve() }) })
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve({ ...grant, payload: { ...grant.payload, access: 'second-account', clientId: 'login-two' } }))
    await changed
    expect(updates).toHaveLength(1)
  })
})

describe('Messages subscription restriction through every credential source', () => {
  const messages = { provider: 'openrouter', model: 'claude-test', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })] }
  const routed = (server: { url: string }, extra: PiAi.PiAiProviderProfile = {}): PiAi.Options => ({ providers: { openrouter: { api: 'anthropic-messages', baseURL: server.url, models: [{ id: 'claude-test', contextWindow: 1000, maxTokens: 100 }], ...extra } } })

  it('refuses an ambient subscription credential on a catalog route overridden to Messages before any I/O', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await mounted(routed(server), undefined)
    await ctx.credentials.set(credentialRef('OPENROUTER_API_KEY'), 'sk-ant-oat-ambient-review')
    expect((await assemble(ctx, messages)).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toEqual([])
  })

  it('still sends an ordinary ambient key on the same overridden route', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await mounted(routed(server), undefined)
    await ctx.credentials.set(credentialRef('OPENROUTER_API_KEY'), 'ordinary-ambient-key')
    expect((await assemble(ctx, messages)).finish).toEqual({ kind: 'stop' })
    expect(JSON.stringify(server.headers[0])).toContain('ordinary-ambient-key')
    expect(JSON.stringify(server.requests[0])).not.toContain('Claude Code')
  })

  it('refuses a subscription credential carried by an effective profile header', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await mounted(routed(server, { apiKeyEnv: 'ROUTE_KEY', headers: { authorization: 'Bearer sk-ant-oat-header' } }), undefined)
    await ctx.credentials.set(credentialRef('ROUTE_KEY'), 'ordinary-key')
    expect((await assemble(ctx, messages)).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toEqual([])
  })

  it('refuses a custom route whose stored key is a subscription credential', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await mounted({ providers: { gateway: { api: 'anthropic-messages', baseURL: server.url, apiKeyEnv: 'GATEWAY_KEY', models: [{ id: 'claude-test', contextWindow: 1000, maxTokens: 100 }] } } }, undefined)
    await ctx.credentials.set(credentialRef('GATEWAY_KEY'), 'sk-ant-oat-gateway')
    expect((await assemble(ctx, { ...messages, provider: 'gateway' })).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toEqual([])
  })

  /** A native provider whose auth returns more than a key, as pi-ai's own OAuth providers do. */
  function nativeRoute(
    server: { url: string },
    headers: Record<string, string>,
    apiKey: string,
    resolve: () => Promise<never> = () => Promise.resolve({ source: 'native', auth: { apiKey, baseUrl: server.url, headers } }) as Promise<never>,
  ): PiAiAdapter {
    const base = catalogProvider('openrouter')
    if (base === undefined) throw new Error('openrouter catalog missing')
    const profiles = resolveProfiles({ openrouter: { api: 'anthropic-messages', baseURL: 'https://unused.invalid', models: [{ id: 'claude-test', contextWindow: 1000, maxTokens: 100 }] } })
    const profile = profiles.get('openrouter')
    if (profile?.piProvider === undefined) throw new Error('profile did not build')
    const piProvider: Provider = {
      ...profile.piProvider,
      auth: { apiKey: { name: 'native', resolve } },
    }
    profiles.set('openrouter', { ...profile, piProvider })
    return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve(undefined), auth: memoryAuth() })
  }
  const drain = async (adapter: PiAiAdapter, signal?: AbortSignal): Promise<StreamChunk[]> => {
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ ...messages, ...signal === undefined ? {} : { signal } })) chunks.push(chunk)
    return chunks
  }

  it('keeps native auth baseURL and headers for an allowed credential', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const chunks = await drain(nativeRoute(server, { 'x-native-routing': 'native-value' }, 'ordinary-native-key'))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.headers[0]?.['x-native-routing']).toBe('native-value')
  })

  it('passes the caller signal through and reports a native auth failure as the dispatch would', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const live = new AbortController()
    const chunks: StreamChunk[] = []
    for await (const chunk of nativeRoute(server, {}, 'ordinary-native-key').stream({ ...messages, signal: live.signal })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const failed = await drain(nativeRoute(server, {}, 'ordinary-native-key', () => Promise.reject(new Error('native lookup failed'))))
    expect(JSON.stringify(failed.at(-1))).toContain('native lookup failed')
    expect(failed.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(server.paths).toEqual(['/v1/messages?beta=true'])
  })

  it('keeps the caller\'s abort from being swallowed by the credential check', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const aborted = new AbortController()
    aborted.abort(new Error('caller gave up'))
    await expect(drain(nativeRoute(server, {}, 'ordinary-native-key'), aborted.signal)).rejects.toThrow()
    expect(server.paths).toEqual([])
  })

  it('names the route when a non-OpenAI sign-in-only profile has lost its sign-in', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await mounted(routed(server, { signInOnly: true }), undefined)
    await ctx.credentials.set(credentialRef('OPENROUTER_API_KEY'), 'ambient-must-not-be-used')
    const result = await assemble(ctx, messages)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(JSON.stringify(result.finish)).toContain('"openrouter\\" sign-in was removed')
    expect(server.paths).toEqual([])
  })

  it('refuses a subscription credential that only native auth metadata carries', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    await expect(drain(nativeRoute(server, { authorization: 'Bearer sk-ant-oat-native' }, 'ordinary-native-key'))).rejects.toMatchObject({ code: 'AUTH' })
    expect(server.paths).toEqual([])
  })
})

describe('a Messages request dispatches exactly the authentication it checked', () => {
  const messages = { provider: 'openrouter', model: 'claude-test', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })] }
  interface Dispatched { baseUrl: string; apiKey: string | undefined; headers: Record<string, string | null> | undefined; env: unknown }

  /**
   * A native Messages route whose authentication answers each resolution from
   * `answers` in turn, recording what the protocol implementation receives.
   */
  function changingRoute(answers: readonly (() => Promise<unknown>)[]) {
    const profiles = resolveProfiles({ openrouter: {
      api: 'anthropic-messages', baseURL: 'https://unused.invalid', headers: { 'x-shared': 'profile', 'x-profile': 'kept' },
      models: [{ id: 'claude-test', contextWindow: 1000, maxTokens: 100 }],
    } })
    const profile = profiles.get('openrouter')
    if (profile?.piProvider === undefined) throw new Error('profile did not build')
    const base = profile.piProvider
    const dispatched: Dispatched[] = []
    let resolutions = 0
    const piProvider: Provider = {
      ...base,
      auth: { apiKey: { name: 'native', resolve: () => {
        const answer = answers[Math.min(resolutions, answers.length - 1)]
        resolutions++
        if (answer === undefined) throw new Error('no answer')
        return answer() as never
      } } },
      streamSimple: (model, context, options) => {
        dispatched.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey, headers: options?.headers, env: options?.env })
        return base.streamSimple(model, context, options)
      },
    }
    profiles.set('openrouter', { ...profile, piProvider })
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve(undefined), auth: memoryAuth() })
    const drain = async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(messages)) chunks.push(chunk)
      return chunks
    }
    return { drain, dispatched, resolutions: () => resolutions }
  }

  it('sends the checked key, base URL, merged headers and environment even when a later resolution would differ', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const route = changingRoute([
      () => Promise.resolve({ source: 'native', env: { NATIVE_ENV: 'checked' }, auth: {
        apiKey: 'ordinary-checked-key', baseUrl: server.url, headers: { 'X-Native-Control': 'native', 'X-Shared': 'native' },
      } }),
      () => Promise.resolve({ source: 'native', auth: { apiKey: 'sk-ant-oat-changed', baseUrl: 'http://127.0.0.1:9', headers: {} } }),
    ])
    expect((await route.drain()).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(route.resolutions()).toBe(1)
    expect(route.dispatched).toHaveLength(1)
    const [sent] = route.dispatched
    expect(sent).toMatchObject({ baseUrl: server.url, apiKey: 'ordinary-checked-key', env: { NATIVE_ENV: 'checked' } })
    // Every value under one case-insensitive name, so a duplicate spelling would show.
    const values = (name: string): unknown[] => Object.entries(sent?.headers ?? {})
      .filter(([key]) => key.toLowerCase() === name).map(([, value]) => value)
    expect(values('x-shared')).toEqual(['profile'])
    expect(values('x-native-control')).toEqual(['native'])
    expect(values('x-profile')).toEqual(['kept'])
    expect(server.headers[0]?.['x-api-key']).toBe('ordinary-checked-key')
    expect(server.headers[0]?.['x-native-control']).toBe('native')
    expect(JSON.stringify(server.headers)).not.toContain('sk-ant-oat')
    expect(JSON.stringify(server.requests)).not.toContain('Claude Code')
  })

  it('reports a failed resolution without resolving again or constructing a request', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const route = changingRoute([
      () => Promise.reject(new Error('native lookup failed')),
      () => Promise.resolve({ source: 'native', auth: { apiKey: 'sk-ant-oat-after-failure', baseUrl: server.url } }),
    ])
    const chunks = await route.drain()
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR' } } })
    expect(JSON.stringify(chunks.at(-1))).toContain('API key auth failed for provider openrouter')
    expect(route.resolutions()).toBe(1)
    expect(route.dispatched).toEqual([])
    expect(server.paths).toEqual([])
  })

  it('resolves every request on its own and keeps an unconfigured result unconfigured', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }, { events: anthropicTextEvents }])
    const route = changingRoute([
      () => Promise.resolve({ source: 'native', auth: { apiKey: 'ordinary-first', baseUrl: server.url } }),
      () => Promise.resolve({ source: 'native', auth: { apiKey: 'ordinary-second', baseUrl: server.url } }),
      () => Promise.resolve(undefined),
    ])
    await route.drain()
    await route.drain()
    expect(route.dispatched.map(entry => entry.apiKey)).toEqual(['ordinary-first', 'ordinary-second'])
    expect(server.headers.map(headers => headers['x-api-key'])).toEqual(['ordinary-first', 'ordinary-second'])
    const unconfigured = await route.drain()
    expect(JSON.stringify(unconfigured.at(-1))).toContain('Provider is not configured: openrouter')
    expect(route.resolutions()).toBe(3)
    expect(route.dispatched).toHaveLength(2)
  })
})

describe('draft discovery honours the same restriction', () => {
  it('refuses a typed subscription key on the Messages listing before any request', async () => {
    const server = await mockServer([{ body: JSON.stringify({ data: [{ id: 'claude-x' }] }) }])
    const ctx = await mounted({}, undefined)
    await expect(ctx.llm.discoverModels('llm-pi-ai', { api: 'anthropic-messages', baseURL: server.url, apiKey: 'sk-ant-oat-typed' })).rejects.toMatchObject({ code: 'AUTH' })
    expect(server.paths).toEqual([])
  })

  it('refuses a stored route key and a stored header, and still lists with an ordinary key', async () => {
    const server = await mockServer([{ body: JSON.stringify({ data: [{ id: 'claude-x' }] }) }])
    const ctx = await mounted({ providers: {
      stored: { api: 'anthropic-messages', baseURL: server.url, apiKeyEnv: 'STORED_KEY' },
      hdr: { api: 'anthropic-messages', baseURL: server.url, headers: { 'x-api-key': 'sk-ant-oat-header' } },
    } }, undefined)
    await ctx.credentials.set(credentialRef('STORED_KEY'), 'sk-ant-oat-stored')
    const draft = { api: 'anthropic-messages', baseURL: server.url }
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'stored', ...draft })).rejects.toMatchObject({ code: 'AUTH' })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'hdr', ...draft })).rejects.toMatchObject({ code: 'AUTH' })
    expect(server.paths).toEqual([])
    expect(await ctx.llm.discoverModels('llm-pi-ai', { ...draft, apiKey: 'ordinary-key' })).toEqual([{ id: 'claude-x', name: 'claude-x' }])
    expect(server.headers[0]?.['x-api-key']).toBe('ordinary-key')
  })
})

describe('plan intent survives an automatic-route edit', () => {
  it('refuses ambient API billing after sign-out for a profile that records sign-in-only', async () => {
    const outbound = vi.fn(async () => Response.json({ error: { message: 'unexpected API billing attempt' } }, { status: 401 }))
    vi.stubGlobal('fetch', outbound)
    const ctx = await mounted({ providers: { openai: { signInOnly: true } } })
    await ctx.credentials.set(credentialRef('OPENAI_API_KEY'), 'ambient-api-billing')
    await ctx.credentials.deleteRecord(PiAi.recordKeyFor('openai'))
    expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(outbound).not.toHaveBeenCalled()
  })

  it('keeps a deliberately configured keyless profile on ambient discovery', async () => {
    const server = await mockServer([{ events: completed }])
    const ctx = await mounted({ providers: { openai: { baseURL: `${server.url}/v1` } } })
    await ctx.credentials.set(credentialRef('OPENAI_API_KEY'), 'deliberate-ambient-key')
    await ctx.credentials.deleteRecord(PiAi.recordKeyFor('openai'))
    expect((await assemble(ctx, request)).finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.authorization).toBe('Bearer deliberate-ambient-key')
  })
})

describe('model listing deadline configuration', () => {
  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 31])('rejects a modelListTimeoutMs of %s when profiles resolve', (timeout) => {
    expect(() => resolveProfiles({ openai: { modelListTimeoutMs: timeout } }))
      .toThrow(/modelListTimeoutMs must be a positive finite number/)
  })

  it('resolves the documented default and an explicit value', () => {
    expect(resolveProfiles({ openai: {} }).get('openai')?.modelListTimeoutMs).toBe(15_000)
    expect(resolveProfiles({ openai: { modelListTimeoutMs: 2_500 } }).get('openai')?.modelListTimeoutMs).toBe(2_500)
  })
})
