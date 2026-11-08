import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage, LlmError, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Credential } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeMockServers()
})

const grant: Credential = { type: 'oauth', access: 'sk-ant-oat-fixture', refresh: 'fixture-refresh', expires: 4102444800000 }

async function request(
  baseURL: string,
  auth: ReturnType<typeof memoryAuth>,
  prompt: { system?: string } = { system: 'DSH owns this prompt.' },
) {
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ anthropic: { baseURL, signInOnly: true } }),
    resolveApiKey: () => Promise.resolve(undefined),
    auth,
  })
  const assembled = new BlockAssembler()
  for await (const chunk of adapter.stream({
    provider: 'anthropic', model: 'claude-haiku-4-5', ...prompt,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] })],
    maxTokens: 64,
  })) assembled.push(chunk)
  return assembled.finish
}

it('dispatches a stored Anthropic OAuth grant through the maintained Messages transport', async () => {
  const server = await mockServer([{ events: anthropicTextEvents }])
  const auth = memoryAuth({ anthropic: grant })
  expect(await request(server.url, auth)).toEqual({ kind: 'stop' })
  expect(server.requests).toHaveLength(1)
  expect(server.headers[0]?.authorization).toBe('Bearer sk-ant-oat-fixture')
  expect(server.headers[0]).not.toHaveProperty('x-api-key')
  expect(server.requests[0]).toMatchObject({ system: [
    { text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { text: 'DSH owns this prompt.' },
  ] })
})

it('refuses an API-key record on the subscription-only route without inference', async () => {
  const server = await mockServer([{ events: anthropicTextEvents }])
  await expect(request(server.url, memoryAuth({ anthropic: { type: 'api_key', key: 'fixture-api-key' } })))
    .rejects.toMatchObject({ code: 'AUTH' })
  expect(server.requests).toEqual([])
})

it('keeps the maintained OAuth prefix when a one-shot has no caller system prompt', async () => {
  const server = await mockServer([{ events: anthropicTextEvents }])
  expect(await request(server.url, memoryAuth({ anthropic: grant }), {})).toEqual({ kind: 'stop' })
  expect(server.requests[0]).toMatchObject({ system: [{ text: "You are Claude Code, Anthropic's official CLI for Claude." }] })
})

it('refuses an absent grant instead of using ambient API-key billing', async () => {
  const server = await mockServer([{ events: anthropicTextEvents }])
  const auth = memoryAuth()
  const env = vi.fn((name: string) => Promise.resolve(name === 'ANTHROPIC_API_KEY' ? 'fixture-ambient-key' : undefined))
  auth.authContext.env = env
  await expect(request(server.url, auth)).rejects.toMatchObject({ code: 'AUTH' })
  expect(server.requests).toEqual([])
  expect(env).not.toHaveBeenCalled()
})

it('rejects an ambient replacement when sign-out wins the checked OAuth resolution', async () => {
  const server = await mockServer([{ events: anthropicTextEvents }])
  const auth = memoryAuth({ anthropic: grant })
  let reads = 0
  auth.credentials.read = () => Promise.resolve(++reads === 1 ? grant : undefined)
  auth.authContext.env = name => Promise.resolve(name === 'ANTHROPIC_API_KEY' ? 'fixture-ambient-key' : undefined)
  await expect(request(server.url, auth)).rejects.toMatchObject({ code: 'AUTH' })
  expect(server.requests).toEqual([])
})

it.each(['', 'DSH owns this prompt.'])('binds OAuth and encodes the prefix once with system text %j', async (text) => {
  const server = await mockServer([{ events: anthropicTextEvents }])
  const auth = memoryAuth({ anthropic: grant })
  const read = vi.spyOn(auth.credentials, 'read')
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ anthropic: { baseURL: server.url, signInOnly: true } }),
    resolveApiKey: () => Promise.resolve(undefined), auth,
  })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['anthropic'], adapter)
  const prepared = await ctx.llm.prepareCall({ provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 64 })
  expect(prepared.systemPromptPrefix).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
  const prefix = prepared.systemPromptPrefix
  if (prefix === undefined) throw new Error('Missing OAuth system prefix')
  expect(Object.isFrozen(prepared)).toBe(true)
  const reads = read.mock.calls.length
  expect(reads).toBeGreaterThan(0)
  auth.stored.set('anthropic', { ...grant, access: 'sk-ant-oat-replacement' })
  const assembled = new BlockAssembler()
  for await (const chunk of prepared.stream({
    ...prepared.config, system: prefix + (text.length === 0 ? '' : `\n\n${text}`),
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] })],
  })) assembled.push(chunk)
  expect(assembled.finish).toEqual({ kind: 'stop' })
  expect(read).toHaveBeenCalledTimes(reads)
  expect(server.headers[0]?.authorization).toBe('Bearer sk-ant-oat-fixture')
  expect(server.headers[0]?.['user-agent']).toMatch(/^claude-cli\//)
  expect(server.headers[0]).not.toHaveProperty('x-api-key')
  expect(server.requests[0]).toMatchObject({ system: [
    { text: prepared.systemPromptPrefix }, ...text.length === 0 ? [] : [{ text }],
  ] })
})

it.each([
  ['Authorization', true], ['X-Api-Key', true], ['Authorization', false], ['X-Api-Key', false],
] as const)('refuses the %s header on stored OAuth with prepared dispatch %s', async (name, prepare) => {
  const server = await mockServer([{ events: anthropicTextEvents }])
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ anthropic: { baseURL: server.url, signInOnly: true, headers: { [name]: 'replacement' } } }),
    resolveApiKey: () => Promise.resolve(undefined), auth: memoryAuth({ anthropic: grant }),
  })
  const options = { provider: 'anthropic', model: 'claude-haiku-4-5', messages: [] }
  const bound = prepare ? await (await adapter.prepareCall('anthropic', 'claude-haiku-4-5')).finalizeControls?.({}) : undefined
  if (prepare) expect(bound?.systemPromptPrefix).toBeDefined()
  await expect(async () => {
    for await (const _chunk of bound === undefined ? adapter.stream(options) : bound.stream(options)) { /* exhaust */ }
  }).rejects.toMatchObject({ code: 'AUTH' })
  expect(server.requests).toEqual([])
})

it('rejects stored OAuth on another protocol before dispatch', async () => {
  const server = await mockServer([{ events: anthropicTextEvents }])
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ anthropic: { baseURL: server.url, api: 'openai-completions', signInOnly: true } }),
    resolveApiKey: () => Promise.resolve(undefined), auth: memoryAuth({ anthropic: grant }),
  })
  await expect(async () => {
    for await (const _chunk of adapter.stream({ provider: 'anthropic', model: 'claude-haiku-4-5', messages: [] })) { /* exhaust */ }
  }).rejects.toMatchObject({ code: 'AUTH' })
  expect(server.requests).toEqual([])
})

it('keeps an explicitly selected API-key route separate from subscription sign-in', async () => {
  const server = await mockServer([{ events: anthropicTextEvents }])
  const auth = memoryAuth({ anthropic: grant })
  const read = vi.spyOn(auth.credentials, 'read')
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ anthropic: { baseURL: server.url, signInOnly: true, apiKeyEnv: 'EXPLICIT_API_KEY' } }),
    resolveApiKey: () => Promise.resolve('sk-ant-api-explicit'), auth,
  })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['anthropic'], adapter)
  const config: LlmCallConfig = { provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 64 }
  const prepared = await ctx.llm.prepareCall(config)
  expect(prepared.systemPromptPrefix).toBeUndefined()
  for await (const _chunk of prepared.stream({ ...prepared.config, system: 'Explicit billing selection.', messages: [] })) { /* exhaust */ }
  expect(read).not.toHaveBeenCalled()
  expect(server.headers[0]?.['x-api-key']).toBe('sk-ant-api-explicit')
  expect(server.headers[0]).not.toHaveProperty('authorization')
  expect(server.requests[0]).toMatchObject({ system: [{ text: 'Explicit billing selection.' }] })
})

it.each([401, 503])('preserves an expired stored grant when refresh returns %s', async (status) => {
  const original = globalThis.fetch
  const refresh = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init)
    if (request.url !== 'https://platform.claude.com/v1/oauth/token') throw new Error('Unexpected external endpoint')
    return Promise.resolve(Response.json({ error: 'synthetic-refresh-refused' }, { status }))
  })
  const expired = { ...grant, expires: 0 }
  const auth = memoryAuth({ anthropic: expired })
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ anthropic: { signInOnly: true } }),
    resolveApiKey: () => Promise.resolve(undefined), auth,
  })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['anthropic'], adapter)
  const preparing = ctx.llm.prepareCall({ provider: 'anthropic', model: 'claude-haiku-4-5' })
  if (status === 401) await expect(preparing).rejects.toMatchObject({ code: 'AUTH' })
  else {
    const prepared = await preparing
    const chunks = []
    for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER' } } })
  }
  expect(refresh).toHaveBeenCalledOnce()
  expect(auth.stored.get('anthropic')).toEqual(expired)
  refresh.mockRestore()
  expect(globalThis.fetch).toBe(original)
})

it('defers a transient Anthropic credential failure to its stream without resolving again', async () => {
  const resolve = vi.fn(() => Promise.reject(new LlmError('Synthetic credential store unavailable', 'TRANSPORT')))
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ anthropic: { signInOnly: true } }),
    resolveApiKey: resolve, auth: memoryAuth({ anthropic: grant }),
  })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['anthropic'], adapter)
  const prepared = await ctx.llm.prepareCall({ provider: 'anthropic', model: 'claude-haiku-4-5' })
  const chunks = []
  for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) chunks.push(chunk)
  expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } }])
  expect(resolve).toHaveBeenCalledOnce()
})
