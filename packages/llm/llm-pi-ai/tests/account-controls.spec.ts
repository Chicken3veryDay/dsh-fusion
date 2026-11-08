/** Authentication and wire evidence for pre-admission Responses control finalization. */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AuthResult, Credential, Provider } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { ModelsError } from '@earendil-works/pi-ai/utils/models-error'
import { memoryAuth } from './auth-double.ts'

const API_KEY = 'sk-synthetic-bound-api'
const SESSION_KEY = 'synthetic-session-access'
const controls = { temperature: 0.2, maxTokens: 777 }
const route = { provider: 'openai', model: 'gpt-5.5' }
afterEach(() => vi.unstubAllGlobals())

async function drain(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Only transport is replaced; the model retains its real official URL. */
async function fixture(input: {
  explicit?: string
  stored?: Credential
  ambient?: string
  profile?: PiAiProviderProfile
  resolve?: () => Promise<string | undefined>
  effective?: AuthResult
} = {}) {
  const auth = memoryAuth(input.stored === undefined ? {} : { openai: input.stored })
  const read = vi.spyOn(auth.credentials, 'read')
  const ambient = vi.fn((name: string) => Promise.resolve(name === 'OPENAI_API_KEY' ? input.ambient : undefined))
  auth.authContext.env = ambient
  let key = input.explicit
  const resolve = vi.fn(input.resolve ?? (() => Promise.resolve(key)))
  const headers = vi.fn((_request, headers: Headers) => headers)
  const profiles = resolveProfiles({ openai: { streamIdleTimeoutMs: 5000, ...input.profile } })
  const effective = vi.fn(() => Promise.resolve(input.effective))
  const dispatched: { baseUrl: string; apiKey: string | undefined; headers: unknown; env: unknown }[] = []
  if (input.effective !== undefined) {
    const profile = profiles.get('openai')
    if (profile?.piProvider === undefined) throw new Error('custom provider required')
    const base = profile.piProvider
    const piProvider: Provider = {
      ...base,
      auth: { apiKey: { name: 'synthetic native auth', resolve: effective } },
      streamSimple: (model, context, options) => {
        dispatched.push({ baseUrl: model.baseUrl, apiKey: options?.apiKey, headers: options?.headers, env: options?.env })
        return base.streamSimple(model, context, options)
      },
    }
    profiles.set('openai', { ...profile, piProvider })
  }
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: resolve, auth, prepareHeaders: headers })
  const requests: { url: string; key: string | null; body: Record<string, unknown> }[] = []
  const refreshRequests: { url: string; body: string }[] = []
  const refresh = vi.fn<() => Promise<Response>>()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = await request.text()
    if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
      refreshRequests.push({ url: request.url, body })
      return refresh()
    }
    requests.push({ url: request.url, key: request.headers.get('authorization'), body: JSON.parse(body) as Record<string, unknown> })
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const registration = ctx.llm.registerAdapter(['openai'], adapter)
  return {
    ctx, registration, effective, dispatched, auth, read, ambient, resolve, headers, requests, refresh, refreshRequests, profiles, adapter,
    setKey: (value: string) => { key = value },
  }
}

const oauth = (access = SESSION_KEY): Credential => ({ type: 'oauth', access, refresh: 'synthetic-refresh', expires: 4102444800000 })
const api = (key = API_KEY): Credential => ({ type: 'api_key', key })

// Credential labels cannot predict the serializer: actual key bytes and effective URL do.
describe('Responses account control admission', () => {
  it.each([
    ['explicit API', { explicit: API_KEY }, false],
    ['explicit session', { explicit: SESSION_KEY }, true],
    ['stored OAuth', { stored: oauth() }, true],
    ['stored OAuth API-shaped', { stored: oauth(API_KEY) }, false],
    ['stored API', { stored: api() }, false],
    ['stored API session-shaped', { stored: api(SESSION_KEY) }, true],
    ['ambient API', { ambient: API_KEY }, false],
    ['ambient session', { ambient: SESSION_KEY }, true],
    ['custom session', { explicit: SESSION_KEY, profile: { baseURL: 'https://gateway.invalid/v1' } }, false],
    ['custom OAuth', { stored: oauth(), profile: { baseURL: 'https://gateway.invalid/v1' } }, false],
  ] as const)('%s follows effective auth on prepared and direct paths', async (_label, input, omitted) => {
    const f = await fixture(input)
    if (omitted) {
      for (const selected of [{ temperature: 0.2 }, { maxTokens: 777 }]) {
        const control = 'temperature' in selected ? 'temperature' : 'maxTokens'
        const failure = { code: 'UNSUPPORTED_CONTROL', unsupportedControl: { control, reason: 'account-omits' } }
        await expect(f.ctx.llm.prepareCall({ ...route, ...selected })).rejects.toMatchObject({ failure })
        expect(await drain(f.ctx.llm.stream({ ...route, ...selected, messages: [] })))
          .toMatchObject([{ type: 'finish', reason: { kind: 'error', failure } }])
      }
      expect(f.headers).not.toHaveBeenCalled()
      expect(f.requests).toEqual([])
    } else {
      const prepared = await f.ctx.llm.prepareCall({ ...route, ...controls })
      expect(f.headers).not.toHaveBeenCalled()
      expect(f.requests).toEqual([])
      expect(prepared.assessment.fields).toMatchObject({ temperature: { kind: 'supported' }, maxTokens: { kind: 'unverified', reason: 'protocol-unverified' } })
      await drain(prepared.stream({ ...prepared.config, messages: [] }))
      await drain(f.ctx.llm.stream({ ...route, ...controls, messages: [] }))
      expect(f.requests).toHaveLength(2)
      for (const request of f.requests) expect(request.body).toMatchObject({ temperature: 0.2, max_output_tokens: 777 })
      expect(f.requests[0]?.url).toBe(`${'profile' in input ? input.profile.baseURL : 'https://api.openai.com/v1'}/responses`)
    }
  })

  it('pure stop refuses before any key, store, ambient, header or HTTP work', async () => {
    const f = await fixture({ stored: oauth() })
    await expect(f.ctx.llm.prepareCall({ ...route, ...controls, stop: ['END'] })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })
    await drain(f.ctx.llm.stream({ ...route, ...controls, stop: ['END'], messages: [] }))
    for (const spy of [f.resolve, f.read, f.ambient, f.headers]) expect(spy).not.toHaveBeenCalled()
    expect(f.requests).toEqual([])
  })

  it.each([{}, { reasoningEffort: ReasoningEffortId('off') }])('keeps no-control and effort-only authentication lazy', async (selected) => {
    const f = await fixture({ explicit: API_KEY })
    const prepared = await f.ctx.llm.prepareCall({ ...route, ...selected })
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
    await drain(prepared.stream({ ...prepared.config, messages: [] }))
    expect(f.resolve).toHaveBeenCalledTimes(1)
  })

  it('retains the explicit API credential if the resolver changes to a session key before dispatch', async () => {
    const f = await fixture({ explicit: API_KEY })
    const prepared = await f.ctx.llm.prepareCall({ ...route, ...controls })
    f.setKey(SESSION_KEY)
    await drain(prepared.stream({ ...prepared.config, messages: [] }))
    expect(f.requests).toMatchObject([{ key: `Bearer ${API_KEY}`, body: { temperature: 0.2, max_output_tokens: 777 } }])
    expect(f.resolve).toHaveBeenCalledTimes(1)
    await expect(f.ctx.llm.prepareCall({ ...route, ...controls })).rejects.toMatchObject({ failure: { unsupportedControl: { reason: 'account-omits' } } })
  })

  it('binds an API credential across account/config/registration replacement; fresh calls refuse', async () => {
    const f = await fixture({ stored: api() })
    const prepared = await f.ctx.llm.prepareCall({ ...route, ...controls })
    const reads = f.read.mock.calls.length
    f.auth.stored.set('openai', oauth())
    f.registration()
    f.ctx.llm.registerAdapter(['openai'], new PiAiAdapter({ profiles: () => resolveProfiles({ openai: {} }), resolveApiKey: () => Promise.resolve(SESSION_KEY), auth: memoryAuth() }))
    await drain(prepared.stream({ ...prepared.config, messages: [] }))
    expect(f.resolve).toHaveBeenCalledTimes(1)
    expect(f.read).toHaveBeenCalledTimes(reads)
    expect(f.requests).toMatchObject([{ key: `Bearer ${API_KEY}`, body: { temperature: 0.2, max_output_tokens: 777 } }])
    expect(() => prepared.stream({ ...prepared.config, messages: [] })).toThrow(/only be dispatched once/)
    await expect(f.ctx.llm.prepareCall({ ...route, ...controls })).rejects.toMatchObject({ failure: { unsupportedControl: { reason: 'account-omits' } } })
    expect(JSON.stringify(prepared.assessment)).not.toContain(API_KEY)
    expect(Object.isFrozen(prepared.assessment.fields.temperature)).toBe(true)
  })

  it('keeps a bound stored-only API-shaped OAuth across sign-out; a new call cannot bill ambient', async () => {
    const f = await fixture({ stored: oauth(API_KEY), ambient: 'sk-ambient-must-not-bill', profile: { signInOnly: true } })
    const prepared = await f.ctx.llm.prepareCall({ ...route, ...controls })
    f.auth.stored.clear()
    await drain(prepared.stream({ ...prepared.config, messages: [] }))
    expect(f.requests[0]?.key).toBe(`Bearer ${API_KEY}`)
    await expect(f.ctx.llm.prepareCall({ ...route, ...controls })).rejects.toMatchObject({ code: 'AUTH' })
    expect(f.ambient).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(1)
  })

  it('detaches the complete effective resolution without freezing provider aliases or re-resolving dispatch', async () => {
    const effective: AuthResult = { source: 'synthetic', auth: { apiKey: API_KEY, baseUrl: 'https://gateway.invalid/v1', headers: { 'x-auth': 'captured-header' } }, env: { SYNTHETIC_ENV: 'captured-env' } }
    const f = await fixture({ effective, profile: { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', models: [{ id: route.model, maxTokens: 128000, contextWindow: 200000 }] } })
    const prepared = await f.ctx.llm.prepareCall({ ...route, ...controls })
    expect(f.effective).toHaveBeenCalledTimes(1)
    expect(Object.isFrozen(effective.auth)).toBe(false)
    effective.auth.apiKey = SESSION_KEY
    effective.auth.baseUrl = 'https://api.openai.com/v1'
    effective.auth.headers = { 'x-auth': 'replacement-header' }
    effective.env = { SYNTHETIC_ENV: 'replacement-env' }
    await drain(prepared.stream({ ...prepared.config, messages: [] }))
    expect(f.effective).toHaveBeenCalledTimes(1)
    expect(f.dispatched).toMatchObject([{ apiKey: API_KEY, baseUrl: 'https://gateway.invalid/v1', headers: { 'x-auth': 'captured-header' }, env: { SYNTHETIC_ENV: 'captured-env' } }])
    expect(f.requests).toMatchObject([{ url: 'https://gateway.invalid/v1/responses', key: `Bearer ${API_KEY}`, body: { temperature: 0.2, max_output_tokens: 777 } }])
    const publicFacts = JSON.stringify(prepared.assessment)
    for (const secret of [API_KEY, 'captured-header', 'captured-env']) expect(publicFacts).not.toContain(secret)
  })

  it('classifies the explicit dispatch override rather than a lower-priority resolver key', async () => {
    const f = await fixture({ explicit: API_KEY, effective: { source: 'synthetic', auth: { apiKey: SESSION_KEY } }, profile: { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', models: [{ id: route.model, maxTokens: 128000 }] } })
    const prepared = await f.ctx.llm.prepareCall({ ...route, ...controls })
    expect(prepared.assessment.fields.temperature).toEqual({ kind: 'supported' })
    await drain(prepared.stream({ ...prepared.config, messages: [] }))
    expect(f.requests).toMatchObject([{ key: `Bearer ${API_KEY}`, body: { temperature: 0.2, max_output_tokens: 777 } }])
    expect(f.effective).toHaveBeenCalledTimes(1)
  })

  it('keeps a held session resolution refused even when the store is replaced before settlement', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const effective: AuthResult = { source: 'synthetic', auth: { apiKey: SESSION_KEY } }
    const f = await fixture({ effective, profile: { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', models: [{ id: route.model, maxTokens: 128000 }] } })
    f.effective.mockImplementation(async () => { entered.resolve(undefined); await release.promise; return effective })
    const pending = f.ctx.llm.prepareCall({ ...route, ...controls })
    const refused = expect(pending).rejects.toMatchObject({ failure: { unsupportedControl: { reason: 'account-omits' } } })
    await entered.promise
    f.auth.stored.set('openai', api())
    release.resolve(undefined)
    await refused
    expect(f.effective).toHaveBeenCalledTimes(1)
    expect(f.headers).not.toHaveBeenCalled()
    expect(f.requests).toEqual([])
  })

  it('missing auth stays unverified and its pinned absence cannot discover a later ambient key', async () => {
    const f = await fixture()
    const prepared = await f.ctx.llm.prepareCall({ ...route, ...controls })
    expect(prepared.assessment.fields.temperature).toEqual({ kind: 'unverified', reason: 'account-mode-unresolved' })
    f.auth.authContext.env = () => Promise.resolve(API_KEY)
    await drain(prepared.stream({ ...prepared.config, messages: [] }))
    expect(f.requests).toEqual([])
    expect(f.resolve).toHaveBeenCalledTimes(1)
  })

  it.each([['key', 'prepared'], ['key', 'direct'], ['store', 'prepared'], ['store', 'direct']] as const)('aborts held %s reads promptly on the %s path and discards late completion', async (held, path) => {
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<string | undefined>()
    const f = await fixture(held === 'key' ? { resolve: () => { entered.resolve(undefined); return released.promise } } : {})
    if (held === 'store') f.read.mockImplementation(async () => { entered.resolve(undefined); await released.promise; return api() })
    const controller = new AbortController()
    const rejected = path === 'prepared'
      ? expect(f.ctx.llm.prepareCall({ ...route, ...controls }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
      : expect(drain(f.ctx.llm.stream({ ...route, ...controls, messages: [], signal: controller.signal })))
        .resolves.toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
    await entered.promise
    const readsAtAbort = f.read.mock.calls.length
    controller.abort()
    await rejected
    released.resolve(undefined)
    // Drain the released resolver and its downstream promise continuations.
    await released.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.requests).toEqual([])
    expect(f.headers).not.toHaveBeenCalled()
    expect(f.read).toHaveBeenCalledTimes(readsAtAbort)
    if (held === 'key') expect(f.read).not.toHaveBeenCalled()
    const directController = new AbortController()
    directController.abort()
    expect(await drain(f.ctx.llm.stream({ ...route, ...controls, messages: [], signal: directController.signal })))
      .toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
  })

  it.each(['prepared', 'direct', 'disposal'] as const)('discards held getAuth completion after %s cancellation', async (path) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const continued = Promise.withResolvers<undefined>()
    const f = await fixture({ effective: { source: 'synthetic', auth: { apiKey: API_KEY } }, profile: { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', models: [{ id: route.model, maxTokens: 128000 }] } })
    f.effective.mockImplementation(async () => { entered.resolve(undefined); await release.promise; continued.resolve(undefined); return { source: 'synthetic', auth: { apiKey: API_KEY } } })
    const controller = new AbortController()
    if (path === 'disposal') {
      f.registration()
      f.ctx.llm.registerAdapter(['openai'], new PiAiAdapter({ profiles: () => f.profiles, resolveApiKey: f.resolve, auth: f.auth, lifetime: controller.signal, prepareHeaders: f.headers }))
    }
    const rejected = path === 'direct'
      ? expect(drain(f.ctx.llm.stream({ ...route, ...controls, messages: [], signal: controller.signal }))).resolves.toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
      : expect(f.ctx.llm.prepareCall({ ...route, ...controls }, path === 'disposal' ? undefined : controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    await entered.promise
    const reads = f.read.mock.calls.length
    controller.abort(new Error('explicit held auth cancellation'))
    await rejected
    release.resolve(undefined)
    await continued.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.effective).toHaveBeenCalledTimes(1)
    expect(f.read).toHaveBeenCalledTimes(reads)
    expect(f.headers).not.toHaveBeenCalled()
    expect(f.requests).toEqual([])
  })

  it('pins a failed effective resolution without another auth attempt during dispatch', async () => {
    const f = await fixture({ effective: { source: 'synthetic', auth: { apiKey: API_KEY } }, profile: { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', models: [{ id: route.model, maxTokens: 128000 }] } })
    f.effective.mockRejectedValue(new ModelsError('auth', 'synthetic auth failure'))
    const prepared = await f.ctx.llm.prepareCall({ ...route, ...controls })
    expect(prepared.assessment.fields.temperature).toMatchObject({ kind: 'unverified' })
    await drain(prepared.stream({ ...prepared.config, messages: [] }))
    expect(f.effective).toHaveBeenCalledTimes(1)
    expect(f.requests).toEqual([])
  })

  it('keeps an effective resolver AUTH refusal before headers and dispatch', async () => {
    const f = await fixture({ effective: { source: 'synthetic', auth: { apiKey: API_KEY } }, profile: { api: 'openai-responses', baseURL: 'https://api.openai.com/v1', models: [{ id: route.model, maxTokens: 128000 }] } })
    f.effective.mockRejectedValue(new ModelsError('auth', 'synthetic 401 authentication denied'))
    await expect(f.ctx.llm.prepareCall({ ...route, ...controls })).rejects.toMatchObject({ code: 'AUTH', message: 'API key auth failed for provider openai: synthetic 401 authentication denied' })
    expect(await drain(f.ctx.llm.stream({ ...route, ...controls, messages: [] }))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'API key auth failed for provider openai: synthetic 401 authentication denied' } } }])
    expect(f.effective).toHaveBeenCalledTimes(2)
    expect(f.headers).not.toHaveBeenCalled()
    expect(f.requests).toEqual([])
  })

  it('adapter finalization honors a pre-aborted operation before any auth work', async () => {
    const f = await fixture({ explicit: API_KEY })
    const prepared = await f.adapter.prepareCall(route.provider, route.model)
    const controller = new AbortController()
    controller.abort()
    await expect(prepared.finalizeControls?.(controls, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it('owner disposal aborts a held finalization and late auth cannot publish a call', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<string | undefined>()
    const lifetime = new AbortController()
    const f = await fixture()
    f.registration()
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ openai: {} }),
      resolveApiKey: () => { entered.resolve(undefined); return release.promise },
      auth: f.auth, lifetime: lifetime.signal, prepareHeaders: f.headers,
    })
    f.ctx.llm.registerAdapter(['openai'], adapter)
    const pending = f.ctx.llm.prepareCall({ ...route, ...controls })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await entered.promise
    lifetime.abort()
    await rejected
    release.resolve(undefined)
    await release.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.requests).toEqual([])
    expect(f.headers).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
  })

  it('retains a missing issued client ID failure and stored grant', async () => {
    const credential = { ...oauth(), expires: 0 }
    const f = await fixture({ stored: credential })
    const preparing = f.ctx.llm.prepareCall({ ...route, ...controls })
    await expect(preparing).resolves.toMatchObject({ config: route })
    const prepared = await preparing
    expect(await drain(prepared.stream({ ...prepared.config, messages: [] }))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR' } } }])
    expect(f.auth.stored.get('openai')).toBe(credential)
    expect(f.requests).toEqual([])
    expect(f.headers).not.toHaveBeenCalled()
  })

  it.each(['TRANSPORT', 'PI_AI_ERROR', 'STORE_IO'])('pins %s auth I/O failure at finalization without re-resolution', async (code) => {
    const original = new LlmError('synthetic auth I/O unavailable', code)
    const f = await fixture({ resolve: () => Promise.reject(original) })
    const preparing = f.ctx.llm.prepareCall({ ...route, ...controls })
    await expect(preparing).resolves.toMatchObject({ config: route })
    const prepared = await preparing
    expect(prepared.assessment.fields.temperature).toEqual({ kind: 'unverified', reason: 'account-mode-unresolved' })
    expect(f.headers).not.toHaveBeenCalled()
    expect(await drain(prepared.stream({ ...prepared.config, messages: [] }))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code, message: original.message } } }])
    expect(() => prepared.stream({ ...prepared.config, messages: [] })).toThrow(/only be dispatched once/)
    expect(f.resolve).toHaveBeenCalledTimes(1)
    expect(await drain(f.ctx.llm.stream({ ...route, ...controls, messages: [] }))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code, message: original.message } } }])
    expect(f.resolve).toHaveBeenCalledTimes(2)
    expect(f.read).not.toHaveBeenCalled()
    expect(f.headers).not.toHaveBeenCalled()
    expect(f.requests).toEqual([])
  })

  it('keeps stored credential read failures stream-owned without retrying that read', async () => {
    const f = await fixture()
    f.read.mockRejectedValue(new LlmError('synthetic store unavailable', 'TRANSPORT'))
    const preparing = f.ctx.llm.prepareCall({ ...route, ...controls })
    await expect(preparing).resolves.toMatchObject({ config: route })
    const prepared = await preparing
    expect(await drain(prepared.stream({ ...prepared.config, messages: [] }))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'synthetic store unavailable' } } }])
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.headers).not.toHaveBeenCalled()
    expect(f.requests).toEqual([])
  })

  it('keeps AUTH and missing credential policy failures before admission', async () => {
    for (const code of ['AUTH', 'MISSING_CREDENTIAL']) {
      const original = new LlmError('synthetic credential refusal', code)
      const f = await fixture({ resolve: () => Promise.reject(original) })
      await expect(f.ctx.llm.prepareCall({ ...route, ...controls })).rejects.toBe(original)
      expect(await drain(f.ctx.llm.stream({ ...route, ...controls, messages: [] }))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code } } }])
      expect(f.headers).not.toHaveBeenCalled()
      expect(f.requests).toEqual([])
    }
  })

  it.each([
    ['https://api.openai.com/v1', 'https://gateway.invalid/v1', false],
    ['https://gateway.invalid/v1', 'https://api.openai.com/v1', true],
  ])('uses effective auth URL %s → %s for session omission', async (baseURL, baseUrl, refused) => {
    const f = await fixture({ effective: { source: 'synthetic', auth: { apiKey: SESSION_KEY, baseUrl } }, profile: { api: 'openai-responses', baseURL, models: [{ id: route.model, maxTokens: 128000 }] } })
    if (refused) {
      await expect(f.ctx.llm.prepareCall({ ...route, ...controls })).rejects.toMatchObject({ failure: { unsupportedControl: { reason: 'account-omits' } } })
      expect(f.headers).not.toHaveBeenCalled()
      expect(f.requests).toEqual([])
    } else {
      const preparing = f.ctx.llm.prepareCall({ ...route, ...controls })
      await expect(preparing).resolves.toMatchObject({ config: route })
      const prepared = await preparing
      await drain(prepared.stream({ ...prepared.config, messages: [] }))
      expect(f.requests).toMatchObject([{ url: `${baseUrl}/responses`, key: `Bearer ${SESSION_KEY}`, body: { temperature: 0.2, max_output_tokens: 777 } }])
    }
    expect(f.effective).toHaveBeenCalledTimes(1)
  })

  it('does not apply the Messages subscription-token policy to OpenAI Responses', async () => {
    const f = await fixture({ explicit: 'sk-ant-oat-synthetic-openai-route' })
    const preparing = f.ctx.llm.prepareCall({ ...route, ...controls })
    await expect(preparing).resolves.toMatchObject({ config: route })
    const prepared = await preparing
    await drain(prepared.stream({ ...prepared.config, messages: [] }))
    expect(f.requests).toMatchObject([{ key: 'Bearer sk-ant-oat-synthetic-openai-route' }])
  })

  it.each([
    [401, 'AUTH'], [403, 'AUTH'], [503, 'SERVER'], [0, 'TRANSPORT'],
  ] as const)('classifies real OAuth refresh failure %s as %s and preserves the issued grant', async (status, code) => {
    const credential = { ...oauth(), expires: 0, clientId: 'synthetic-issued-client' }
    const f = await fixture({ stored: credential })
    f.refresh.mockImplementation(async () => {
      if (status === 0) throw new TypeError('synthetic network unavailable')
      return new Response('synthetic refresh unavailable', { status })
    })
    if (code === 'AUTH') {
      await expect(f.ctx.llm.prepareCall({ ...route, ...controls })).rejects.toMatchObject({ code })
    } else {
      const preparing = f.ctx.llm.prepareCall({ ...route, ...controls })
      await expect(preparing).resolves.toMatchObject({ config: route })
      const prepared = await preparing
      expect(prepared.assessment.fields.temperature).toEqual({ kind: 'unverified', reason: 'account-mode-unresolved' })
      expect(await drain(prepared.stream({ ...prepared.config, messages: [] }))).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code } } }])
    }
    expect(f.refresh).toHaveBeenCalledTimes(1)
    expect(f.refreshRequests).toHaveLength(1)
    expect(Object.fromEntries(new URLSearchParams(f.refreshRequests[0]!.body))).toEqual({ grant_type: 'refresh_token', client_id: 'synthetic-issued-client', refresh_token: 'synthetic-refresh', resource: 'https://api.openai.com/v1' })
    expect(f.auth.stored.get('openai')).toBe(credential)
    expect(f.resolve).toHaveBeenCalledTimes(1)
    expect(f.headers).not.toHaveBeenCalled()
    expect(f.requests).toEqual([])
  })

  it('applies configured allowance defaults before finalization', async () => {
    const f = await fixture({ explicit: SESSION_KEY, profile: { models: [{ id: route.model, maxTokens: 777 }] } })
    await expect(f.ctx.llm.prepareCall(route)).rejects.toMatchObject({ failure: { unsupportedControl: { control: 'maxTokens', reason: 'account-omits' } } })
  })
})
