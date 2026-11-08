import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Credential } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeMockServers()
})

const grant: Credential = { type: 'oauth', access: 'sk-ant-oat-fixture', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 }

async function request(baseURL: string, auth: ReturnType<typeof memoryAuth>) {
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ anthropic: { baseURL, signInOnly: true } }),
    resolveApiKey: () => Promise.resolve(undefined),
    auth,
  })
  const assembled = new BlockAssembler()
  for await (const chunk of adapter.stream({
    provider: 'anthropic', model: 'claude-haiku-4-5', system: 'DSH owns this prompt.',
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

it('binds the prefix and authentication once, then encodes the logged prefix exactly once', async () => {
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
  expect(Object.isFrozen(prepared)).toBe(true)
  const reads = read.mock.calls.length
  expect(reads).toBeGreaterThan(0)
  auth.stored.set('anthropic', { ...grant, access: 'sk-ant-oat-replacement' })
  const assembled = new BlockAssembler()
  for await (const chunk of prepared.stream({
    ...prepared.config, system: `${prepared.systemPromptPrefix}\n\nDSH owns this prompt.`,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] })],
  })) assembled.push(chunk)
  expect(assembled.finish).toEqual({ kind: 'stop' })
  expect(read).toHaveBeenCalledTimes(reads)
  expect(server.headers[0]?.authorization).toBe('Bearer sk-ant-oat-fixture')
  expect(server.headers[0]?.['user-agent']).toMatch(/^claude-cli\//)
  expect(server.headers[0]).not.toHaveProperty('x-api-key')
  expect(server.requests[0]).toMatchObject({ system: [
    { text: prepared.systemPromptPrefix }, { text: 'DSH owns this prompt.' },
  ] })
})
