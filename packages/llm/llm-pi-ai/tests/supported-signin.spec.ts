/** Offline requests through the installed pi-ai implementations with synthetic grants. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { chatgptAccessToken } from '../src/auth.ts'
import { createModels } from '../src/models.ts'
import { catalogProvider } from '../src/catalog.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as PiAi from '../src/index.ts'
import { assemble } from './assemble.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await closeMockServers()
})

const grant = { kind: 'grant', payload: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 4_000_000_000_000 } } as const
const text = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
const completed = [
  JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
  JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: text }),
  JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: text }),
  JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [text], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } }),
]

async function signedIn(provider: string, baseURL: string, profile: PiAi.PiAiProviderProfile = {}): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-supported-signin-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yml'), watch: false })
  await ctx.credentials.modifyRecord(PiAi.recordKeyFor(provider), () => Promise.resolve(grant))
  await ctx.plugin(PiAi, { providers: { [provider]: { baseURL, ...profile } } })
  return ctx
}

const request = { provider: 'openai', model: 'gpt-5.4', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Custom request' }] })] }

describe('supported sign-in requests', () => {
  it('uses public Responses with bearer, required flags, custom prompt and tools', async () => {
    const server = await mockServer([{ events: completed }])
    const ctx = await signedIn('openai', `${server.url}/v1`)
    const result = await assemble(ctx, { ...request, system: 'Custom system prompt', tools: [{ name: 'custom_tool', description: 'Custom tool', parameters: { type: 'object', properties: {} } }] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.paths).toEqual(['/v1/responses'])
    expect(server.headers[0]?.authorization).toBe('Bearer synthetic-access')
    expect(server.requests[0]).toMatchObject({ store: false, stream: true, model: request.model, tools: [{ name: 'custom_tool' }] })
    expect(JSON.stringify(server.requests[0])).toContain('Custom system prompt')
    expect(JSON.stringify(server.requests[0])).toContain('Custom request')
  })

  it.each([
    ['subscription_sharing_usage_limit_exceeded', 'QUOTA'],
    ['subscription_sharing_usage_unavailable', 'SERVER'],
  ])('classifies an in-band %s despite generic display text', async (code, expected) => {
    const server = await mockServer([{ events: [...completed.slice(0, -1), JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code, message: 'Request cannot be completed' } } })] }])
    const ctx = await signedIn('openai', `${server.url}/v1`)
    expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'error', failure: { code: expected } })
  })

  it('does not treat a stream interrupted after output as success', async () => {
    const server = await mockServer([{ events: completed.slice(0, -1) }])
    const ctx = await signedIn('openai', `${server.url}/v1`)
    expect((await assemble(ctx, request)).finish.kind).toBe('error')
  })

  it('offers only list-visible account models in server order and refreshes after account change', async () => {
    const server = await mockServer([
      { body: JSON.stringify({ models: [{ slug: 'gpt-5.4-mini', display_name: 'Account mini', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }, { slug: 'gpt-5.4', display_name: 'Account flagship', visibility: 'list' }] }) },
      { body: JSON.stringify({ models: [{ slug: 'gpt-5.4', display_name: 'Second account', visibility: 'list' }] }) },
    ])
    const ctx = await signedIn('openai', `${server.url}/v1`)
    const offers = await ctx.llm.listModels('openai')
    expect(offers.map(({ id, name }) => ({ id, name }))).toEqual([{ id: 'gpt-5.4-mini', name: 'Account mini' }, { id: 'gpt-5.4', name: 'Account flagship' }])
    expect(offers[0]?.inputModalities).toContain('image')
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve({ ...grant, payload: { ...grant.payload, access: 'second-account' } }))
    expect((await ctx.llm.listModels('openai')).map(({ id, name }) => ({ id, name }))).toEqual([{ id: 'gpt-5.4', name: 'Second account' }])
    expect(server.paths).toEqual(['/v1/models', '/v1/models'])
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer synthetic-access', 'Bearer second-account'])
  })

  it('refuses a saved Anthropic grant on an explicit keyless route without I/O or deleting it', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await signedIn('anthropic', server.url)
    const finish = (await assemble(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [] })).finish
    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    if (finish.kind === 'error') expect(finish.failure.message).toContain('API key')
    expect(server.paths).toEqual([])
    expect(await ctx.credentials.readRecord(PiAi.recordKeyFor('anthropic'))).toEqual(grant)
  })

  it('refuses an OAuth token configured as an Anthropic API key before impersonation', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await signedIn('anthropic', server.url, { apiKeyEnv: 'SYNTHETIC_ANTHROPIC_KEY' })
    await ctx.credentials.set(credentialRef('SYNTHETIC_ANTHROPIC_KEY'), 'sk-ant-oat-synthetic')
    expect((await assemble(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [] })).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toEqual([])
  })
})

describe('credential ownership and recovery', () => {
  it.each([401, 403, 429, 503])('keeps HTTP %s, retry delay and request ID without changing credentials', async (status) => {
    const server = await mockServer([{ status, body: JSON.stringify({ error: { code: 'permission_denied', message: 'Request refused' } }), headers: { 'retry-after': '7', 'x-request-id': 'req-plan-fixture' } }])
    const ctx = await signedIn('openai', `${server.url}/v1`)
    expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'error', failure: { status, providerRetryAfterMs: 7000, requestId: 'req-plan-fixture' } })
    expect(server.paths).toEqual(['/v1/responses'])
    expect(await ctx.credentials.readRecord(PiAi.recordKeyFor('openai'))).toEqual(grant)
  })

  it('keeps incomplete output separate from completed success', async () => {
    const server = await mockServer([{ events: [...completed.slice(0, -1), JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', output: [text], incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } })] }])
    const ctx = await signedIn('openai', `${server.url}/v1`)
    expect((await assemble(ctx, request)).finish.kind).not.toBe('stop')
  })

  it('uses an explicit Anthropic API key despite an old grant and never adds Claude Code identity', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await signedIn('anthropic', server.url, { apiKeyEnv: 'SYNTHETIC_ANTHROPIC_KEY' })
    await ctx.credentials.set(credentialRef('SYNTHETIC_ANTHROPIC_KEY'), 'supported-api-key')
    expect((await assemble(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [], system: 'Custom DSH prompt' })).finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.['x-api-key']).toBe('supported-api-key')
    expect(server.headers[0]?.authorization).toBeUndefined()
    expect(JSON.stringify(server.requests[0])).toContain('Custom DSH prompt')
    expect(JSON.stringify(server.requests[0])).not.toContain('Claude Code')
    expect(await ctx.credentials.readRecord(PiAi.recordKeyFor('anthropic'))).toEqual(grant)
  })

  it('uses a stored Anthropic API key after key login', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await signedIn('anthropic', server.url)
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('anthropic'), () => Promise.resolve({ kind: 'api-key', key: 'stored-supported-key' }))
    expect((await assemble(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [] })).finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.['x-api-key']).toBe('stored-supported-key')
  })

  it('uses account discovery through the public discovery service and leaves explicit API-key discovery on its catalog', async () => {
    const server = await mockServer([{ body: JSON.stringify({ models: [{ slug: 'gpt-5.4', display_name: 'Plan model', visibility: 'list' }] }) }])
    const ctx = await signedIn('openai', `${server.url}/v1`)
    expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai', api: 'anthropic-messages' })).toEqual([{ id: 'gpt-5.4', name: 'Plan model' }])
    expect(server.headers[0]?.authorization).toBe('Bearer synthetic-access')
    expect(server.headers[0]?.['x-api-key']).toBeUndefined()
    expect((await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai', apiKey: 'explicit-api-key' })).length).toBeGreaterThan(1)
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve({ kind: 'api-key', key: 'stored-api-key' }))
    expect((await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).length).toBeGreaterThan(1)
    expect(server.paths).toEqual(['/v1/models'])
  })

  it.each([{}, { models: {} }, { models: [{ slug: '', display_name: 'Broken', visibility: 'list' }] }, { models: [{ slug: 'valid', visibility: 'list' }] }])('rejects invalid account listings without a catalog fallback: %j', async (body) => {
    const server = await mockServer([{ body: JSON.stringify(body) }])
    const ctx = await signedIn('openai', `${server.url}/v1`)
    await expect(ctx.llm.listModels('openai')).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })
})


describe('ChatGPT credential recovery through the pinned provider', () => {
  it.each([400, 401, 503])('preserves the grant and refuses API billing when refresh fails with %s', async (status) => {
    const ctx = await signedIn('openai', 'http://127.0.0.1:9/v1')
    const expired = { ...grant, payload: { ...grant.payload, expires: 1, clientId: 'synthetic-client' } }
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve(expired))
    await ctx.credentials.set(credentialRef('OPENAI_API_KEY'), 'other-billing-source')
    const seen: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      seen.push(url)
      if (url !== 'https://auth.openai.com/api/accounts/oauth/token') throw new Error('unexpected request')
      return Response.json({ error: 'invalid_grant' }, { status })
    })
    const finish = (await assemble(ctx, request)).finish
    expect(finish).toMatchObject({ kind: 'error', failure: { code: status === 503 ? 'SERVER' : 'AUTH' } })
    expect(seen).toEqual(['https://auth.openai.com/api/accounts/oauth/token'])
    expect(await ctx.credentials.readRecord(PiAi.recordKeyFor('openai'))).toEqual(expired)
  })

  it('refreshes, persists the rotated grant, and sends its bearer through the actual Responses implementation', async () => {
    const server = await mockServer([{ events: completed }])
    const ctx = await signedIn('openai', `${server.url}/v1`)
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve({ ...grant, payload: { ...grant.payload, expires: 1, clientId: 'synthetic-client' } }))
    const transport = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.startsWith(server.url)) return transport(input, init)
      expect(url).toBe('https://auth.openai.com/api/accounts/oauth/token')
      if (!(init?.body instanceof URLSearchParams)) throw new Error('expected an OAuth token form')
      expect(init.body.get('refresh_token')).toBe('synthetic-refresh')
      return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' })
    })
    expect((await assemble(ctx, { ...request, signal: new AbortController().signal })).finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.authorization).toBe('Bearer rotated-access')
    expect(await ctx.credentials.readRecord(PiAi.recordKeyFor('openai'))).toMatchObject({ kind: 'grant', payload: { access: 'rotated-access', refresh: 'rotated-refresh' } })
  })

  it('refuses a plan credential on a configured non-Responses protocol', async () => {
    const server = await mockServer([{ events: completed }])
    const ctx = await signedIn('openai', server.url, { api: 'openai-completions' })
    expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toEqual([])
  })

  it('does not switch to an ambient API key when sign-out wins auth resolution', async () => {
    const auth = memoryAuth({ openai: grant.payload })
    const read = vi.spyOn(auth.credentials, 'read')
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    read.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await released.promise
      return grant.payload
    })
    auth.authContext.env = name => Promise.resolve(name === 'OPENAI_API_KEY' ? 'ambient-api-billing' : undefined)
    const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ openai: {} }), resolveApiKey: async () => undefined, auth })
    const outbound = vi.fn(async () => Response.json({ error: { message: 'unexpected API billing attempt' } }, { status: 401 }))
    vi.stubGlobal('fetch', outbound)
    const pending = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(request)) chunks.push(chunk)
      return chunks
    })()
    await entered.promise
    auth.stored.delete('openai')
    released.resolve(undefined)
    await expect(pending).rejects.toMatchObject({ code: 'AUTH' })
    await expect(pending).rejects.toThrow('billing was not selected')
    expect(outbound).not.toHaveBeenCalled()
  })

  it('keeps cancellation distinct from a refresh failure', async () => {
    const models = createModels(memoryAuth({ openai: grant.payload }))
    models.setProvider(catalogProvider('openai')!)
    const controller = new AbortController()
    const reason = new Error('synthetic caller cancellation')
    controller.abort(reason)
    await expect(chatgptAccessToken(models, controller.signal)).rejects.toBe(reason)
  })

  it('refuses a provider that cannot resolve the required stored plan credential', async () => {
    const models = createModels(memoryAuth())
    await expect(chatgptAccessToken(models)).rejects.toMatchObject({ code: 'AUTH' })
    const ctx = await signedIn('openai', 'http://127.0.0.1:9/v1', { models: [{ id: 'gpt-5.4' }], modelOverrides: { 'gpt-5.4': {} } })
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).rejects.toMatchObject({ code: 'AUTH' })
  })
})


describe('ambient credentials and directory offers', () => {
  it('keeps supported Anthropic API keys and excludes subscription environment variables from direct auth', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await signedIn('anthropic', server.url)
    await ctx.credentials.deleteRecord(PiAi.recordKeyFor('anthropic'))
    await ctx.credentials.set(credentialRef('ANTHROPIC_AUTH_TOKEN'), 'unsupported-bearer')
    await ctx.credentials.set(credentialRef('ANTHROPIC_OAUTH_TOKEN'), 'sk-ant-oat-unsupported')
    await ctx.credentials.set(credentialRef('ANTHROPIC_API_KEY'), 'supported-ambient-key')
    expect((await assemble(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [] })).finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.['x-api-key']).toBe('supported-ambient-key')
    expect(server.headers[0]?.authorization).toBeUndefined()
    const native = ctx.llm.listConfigurableProviders().find(provider => provider.provider === 'anthropic')?.nativeAuth
    expect(native?.oauth).toBe(false)
    expect(native?.env).toContain('ANTHROPIC_API_KEY')
    expect(native?.env).not.toContain('ANTHROPIC_OAUTH_TOKEN')
    expect(native?.env).not.toContain('ANTHROPIC_AUTH_TOKEN')
  })

  it('does not send a stored Anthropic subscription token disguised as a key', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await signedIn('anthropic', server.url)
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('anthropic'), () => Promise.resolve({ kind: 'api-key', key: 'sk-ant-oat-synthetic' }))
    expect((await assemble(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [] })).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(server.paths).toEqual([])
  })

  it('uses the public model endpoint for an automatic OpenAI route and notifies pickers of an account change', async () => {
    const server = await mockServer([{ body: JSON.stringify({ models: [{ slug: 'gpt-5.4', display_name: 'Account only', visibility: 'list' }] }) }, { body: JSON.stringify({ models: [] }) }])
    const transport = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== 'https://api.openai.com/v1/models') throw new Error('unexpected request')
      return transport(`${server.url}/v1/models`, init)
    })
    const dir = await mkdtemp(join(tmpdir(), 'dsh-plan-restart-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'credentials.yml')
    const mount = async (): Promise<Context> => {
      const ctx = new Context()
      onTestFinished(() => ctx.fiber.dispose())
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalCredentialProvider, { path, watch: false })
      return ctx
    }
    const before = await mount()
    await before.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve(grant))
    await before.fiber.dispose()
    const ctx = await mount()
    await ctx.credentials.set(credentialRef('OPENAI_API_KEY'), 'other-api-billing')
    await ctx.plugin(PiAi)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    const [offer, ...rest] = await ctx.llm.listModels('openai')
    expect(rest).toEqual([])
    expect(offer).toMatchObject({ provider: 'openai', id: 'gpt-5.4', name: 'Account only' })
    expect(offer?.inputModalities).toContain('text')
    const updated = new Promise<void>((resolve) => { ctx.on('llm/adapters-updated', () => { resolve() }) })
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve({ ...grant, payload: { ...grant.payload, access: 'new-account' } }))
    await updated
    expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' }, new AbortController().signal)).toEqual([])
    const removed = new Promise<void>((resolve) => { ctx.on('llm/adapters-updated', () => { if (ctx.llm.listProviders().length === 0) resolve() }) })
    const listingEntered = Promise.withResolvers<undefined>()
    const listingReleased = Promise.withResolvers<Awaited<ReturnType<typeof ctx.credentials.listRecords>>>()
    onTestFinished(() => { listingReleased.resolve([]) })
    vi.spyOn(ctx.credentials, 'listRecords').mockImplementationOnce(async () => {
      listingEntered.resolve(undefined)
      return listingReleased.promise
    })
    await ctx.credentials.deleteRecord(PiAi.recordKeyFor('openai'))
    await listingEntered.promise
    expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    listingReleased.resolve([])
    await removed
    expect((await assemble(ctx, request)).finish).toMatchObject({ kind: 'error', failure: { code: 'NO_ADAPTER' } })
    expect(server.paths).toEqual(['/v1/models', '/v1/models'])
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer synthetic-access', 'Bearer new-account'])
  })
})


it('waits for a terminal event after output and releases an open transport on cancellation', async () => {
  const server = await mockServer([{ events: completed.slice(0, -1), holdOpen: true }])
  const ctx = await signedIn('openai', `${server.url}/v1`)
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  const outputSeen = Promise.withResolvers<undefined>()
  let finished = false
  const consume = async () => {
    const chunks = []
    for await (const chunk of ctx.llm.stream({ ...request, signal: controller.signal })) {
      chunks.push(chunk)
      if (chunk.type === 'block-end') outputSeen.resolve(undefined)
    }
    finished = true
    return chunks
  }
  const pending = consume()
  await outputSeen.promise
  expect(finished).toBe(false)
  controller.abort()
  expect((await pending).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  await server.responseClosed
})


it('keeps explicit OpenAI API-key inference separate from a stored ChatGPT plan', async () => {
  const server = await mockServer([{ events: completed }])
  const ctx = await signedIn('openai', `${server.url}/v1`, { apiKeyEnv: 'SYNTHETIC_OPENAI_KEY' })
  await ctx.credentials.set(credentialRef('SYNTHETIC_OPENAI_KEY'), 'selected-api-billing')
  expect((await ctx.llm.listModels('openai')).length).toBeGreaterThan(1)
  expect((await assemble(ctx, request)).finish).toEqual({ kind: 'stop' })
  expect(server.headers[0]?.authorization).toBe('Bearer selected-api-billing')
  expect(server.paths).toEqual(['/v1/responses'])
  expect(await ctx.credentials.readRecord(PiAi.recordKeyFor('openai'))).toEqual(grant)
})


it('ignores non-model and unlisted rows in a valid account catalog', async () => {
  const server = await mockServer([{ body: JSON.stringify({ models: [null, 1, {}, { visibility: 'hide' }] }) }])
  const ctx = await signedIn('openai', `${server.url}/v1`)
  expect(await ctx.llm.listModels('openai')).toEqual([])
})
