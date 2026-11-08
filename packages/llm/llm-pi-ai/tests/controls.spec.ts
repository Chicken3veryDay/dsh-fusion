/**
 * Request-control assessment against the real adapter: each case prepares a
 * call through `LlmRuntime`, checks the verdicts and the refusal's placement
 * before credential and network effects, and then dispatches to a loopback
 * server so the verdict is compared with the bytes actually sent.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'
import type { PiAiProviderProfile } from '../src/config.ts'

const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'local probe' }] })]

afterEach(closeMockServers)

interface Probe {
  readonly ctx: Context
  readonly requests: unknown[]
  readonly authCalls: () => number
  readonly dispose: () => Promise<void>
}

/** A real adapter over a loopback route, counting credential resolutions. */
async function probe(route: string, profile: PiAiProviderProfile, credential = 'sk-dummy-no-live-account'): Promise<Probe> {
  const server = await mockServer([{ events: route === 'anthropic' ? anthropicTextEvents : [] }])
  let authCalls = 0
  const profiles = resolveProfiles({ [route]: { ...profile, baseURL: server.url, streamIdleTimeoutMs: 5000 } })
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => { authCalls++; return Promise.resolve(credential) },
    auth: memoryAuth(),
  })
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([route], adapter)
  return { ctx, requests: server.requests, authCalls: () => authCalls, dispose: () => ctx.fiber.dispose() }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Prepare, assert nothing ran, dispatch, and return the single request body. */
async function dispatch(p: Probe, config: LlmCallConfig) {
  const prepared = await p.ctx.llm.prepareCall(config)
  expect(p.requests).toHaveLength(0)
  expect(p.authCalls()).toBe(0)
  await collect(prepared.stream({ ...prepared.config, messages }))
  expect(p.requests).toHaveLength(1)
  return { prepared, body: p.requests[0] }
}

/** The refusal happens before credential resolution, HTTP and dispatch. */
async function expectRefusedBeforeEffects(p: Probe, config: LlmCallConfig, unsupportedControl: { control: string; reason: string }) {
  await expect(p.ctx.llm.prepareCall(config)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL', failure: { unsupportedControl } })
  const chunks = await collect(p.ctx.llm.stream({ ...config, messages }))
  expect(chunks).toMatchObject([{
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CONTROL', unsupportedControl } },
  }])
  expect(p.requests).toHaveLength(0)
  expect(p.authCalls()).toBe(0)
}

describe('Anthropic Messages controls', () => {
  it('reasoning off: temperature and the legacy allowance are supported and sent', async () => {
    const p = await probe('anthropic', {})
    try {
      const config = {
        provider: 'anthropic', model: 'claude-sonnet-4-5', temperature: 0.2, maxTokens: 777, reasoningEffort: ReasoningEffortId('off'),
      }
      const { prepared, body } = await dispatch(p, config)
      expect(prepared.assessment.fields).toEqual({
        reasoningEffort: { kind: 'supported' },
        temperature: { kind: 'supported' },
        maxTokens: { kind: 'supported' },
      })
      expect(body).toMatchObject({ max_tokens: 777, temperature: 0.2, thinking: { type: 'disabled' } })
    } finally { await p.dispose() }
  })

  it('budget-based reasoning: the legacy allowance is explicitly translated and keeps total 17161', async () => {
    const p = await probe('anthropic', {})
    try {
      const { prepared, body } = await dispatch(p, {
        provider: 'anthropic', model: 'claude-sonnet-4-5', maxTokens: 777, reasoningEffort: ReasoningEffortId('high'),
      })
      expect(prepared.assessment.fields.maxTokens).toEqual({
        kind: 'translated',
        translations: [{ kind: 'add-thinking-allowance', thinkingTokens: 16_384, answerReserve: 1_024 }],
      })
      expect(body).toMatchObject({ max_tokens: 17_161, thinking: { type: 'enabled', budget_tokens: 16_137 } })
      expect(body).not.toHaveProperty('temperature')
    } finally { await p.dispose() }
  })

  it('budget-based reasoning follows the profile thinking budget in the translation', async () => {
    const p = await probe('anthropic', { thinkingBudgets: { high: 4096 } })
    try {
      const { prepared, body } = await dispatch(p, {
        provider: 'anthropic', model: 'claude-sonnet-4-5', maxTokens: 777, reasoningEffort: ReasoningEffortId('high'),
      })
      expect(prepared.assessment.fields.maxTokens).toMatchObject({ translations: [{ thinkingTokens: 4_096 }] })
      expect(body).toMatchObject({ max_tokens: 777 + 4_096 })
    } finally { await p.dispose() }
  })

  it('adaptive reasoning: the allowance is supported unchanged and stays 777', async () => {
    const p = await probe('anthropic', {})
    try {
      const { prepared, body } = await dispatch(p, {
        provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 777, reasoningEffort: ReasoningEffortId('high'),
      })
      expect(prepared.assessment.fields.maxTokens).toEqual({ kind: 'supported' })
      expect(body).toMatchObject({ max_tokens: 777, thinking: { type: 'adaptive' } })
    } finally { await p.dispose() }
  })

  it.each(['claude-sonnet-4-5', 'claude-sonnet-4-6'])('temperature with active reasoning on %s is refused before any effect', async (model) => {
    const p = await probe('anthropic', {})
    try {
      await expectRefusedBeforeEffects(
        p,
        { provider: 'anthropic', model, temperature: 0.2, maxTokens: 777, reasoningEffort: ReasoningEffortId('high') },
        { control: 'temperature', reason: 'reasoning-active' },
      )
    } finally { await p.dispose() }
  })

  it('a profile reasoning default participates: temperature is refused with no explicit effort', async () => {
    const p = await probe('anthropic', { reasoning: 'high' })
    try {
      await expectRefusedBeforeEffects(
        p,
        { provider: 'anthropic', model: 'claude-sonnet-4-5', temperature: 0.2 },
        { control: 'temperature', reason: 'reasoning-active' },
      )
    } finally { await p.dispose() }
  })

  it('captured compat that forbids temperature refuses it even with reasoning off', async () => {
    const p = await probe('anthropic', { compat: { supportsTemperature: false } })
    try {
      await expectRefusedBeforeEffects(
        p,
        { provider: 'anthropic', model: 'claude-sonnet-4-5', temperature: 0.2, reasoningEffort: ReasoningEffortId('off') },
        { control: 'temperature', reason: 'model-forbids' },
      )
    } finally { await p.dispose() }
  })
})

describe('account- and protocol-dependent controls', () => {
  it('OpenAI API-shaped credential: allowance and temperature are unverified (pending account mode) yet still dispatch', async () => {
    const p = await probe('openai', {})
    try {
      const { prepared, body } = await dispatch(p, { provider: 'openai', model: 'gpt-5.5', temperature: 0.2, maxTokens: 777 })
      expect(prepared.assessment.fields).toMatchObject({
        temperature: { kind: 'unverified', reason: 'account-mode-unresolved' },
        maxTokens: { kind: 'unverified', reason: 'account-mode-unresolved' },
      })
      expect(body).toMatchObject({ max_output_tokens: 777, temperature: 0.2 })
    } finally { await p.dispose() }
  })

  it('OpenAI allowance below the Responses minimum is not claimed supported: still raised to 16 and unverified', async () => {
    const p = await probe('openai', {})
    try {
      const { prepared, body } = await dispatch(p, { provider: 'openai', model: 'gpt-5.5', maxTokens: 1 })
      expect(prepared.assessment.fields.maxTokens).toEqual({ kind: 'unverified', reason: 'account-mode-unresolved' })
      expect(body).toMatchObject({ max_output_tokens: 16 })
    } finally { await p.dispose() }
  })

  it('OpenAI sign-in credential on the official endpoint omits both fields and is not advertised as supported', async () => {
    const original = globalThis.fetch
    const server = await mockServer([{ events: [] }])
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://api.openai.com/v1/responses')
      return original(`${server.url}/responses`, { method: request.method, headers: request.headers, body: await request.arrayBuffer(), signal: request.signal })
    }
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ openai: { streamIdleTimeoutMs: 5000 } }),
      resolveApiKey: () => Promise.resolve('eyJdummy-no-live-account'),
      auth: memoryAuth(),
    })
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['openai'], adapter)
      const prepared = await ctx.llm.prepareCall({ provider: 'openai', model: 'gpt-5.5', temperature: 0.2, maxTokens: 777 })
      expect(prepared.assessment.fields).toMatchObject({
        temperature: { kind: 'unverified', reason: 'account-mode-unresolved' },
        maxTokens: { kind: 'unverified', reason: 'account-mode-unresolved' },
      })
      await collect(prepared.stream({ ...prepared.config, messages }))
      expect(server.requests[0]).not.toHaveProperty('max_output_tokens')
      expect(server.requests[0]).not.toHaveProperty('temperature')
    } finally {
      globalThis.fetch = original
      await ctx.fiber.dispose()
    }
  })

  it('a route on another protocol is unverified for protocol, not account mode', async () => {
    const p = await probe('deepseek', {})
    try {
      const prepared = await p.ctx.llm.prepareCall({ provider: 'deepseek', model: 'deepseek-flash', temperature: 0.1, maxTokens: 9 })
      expect(prepared.assessment.fields).toMatchObject({
        temperature: { kind: 'unverified', reason: 'protocol-unverified' },
        maxTokens: { kind: 'unverified', reason: 'protocol-unverified' },
      })
    } finally { await p.dispose() }
  })

  it('a default call supplies no controls, so nothing is assessed or refused', async () => {
    const p = await probe('anthropic', {})
    try {
      const prepared = await p.ctx.llm.prepareCall({ provider: 'anthropic', model: 'claude-sonnet-4-5' })
      expect(prepared.assessment.fields).toEqual({})
    } finally { await p.dispose() }
  })
})

describe('stop sequences', () => {
  it.each(['anthropic', 'openai'])('are refused at preparation on %s without resolving a credential or starting iteration', async (route) => {
    const p = await probe(route, {})
    try {
      await expectRefusedBeforeEffects(
        p,
        { provider: route, model: route === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-5.5', stop: ['END'] },
        { control: 'stop', reason: 'adapter-rejects' },
      )
    } finally { await p.dispose() }
  })
})
