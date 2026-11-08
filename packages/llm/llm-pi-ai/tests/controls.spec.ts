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
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import type { Model } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { assessPiAiControls, finalizeOpenAiControls, CONTEXT_RESERVE_TOKENS, MINIMUM_WIRE_TOKENS, ZERO_BUDGET_SENDS } from '../src/controls.ts'
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

/** One user message of `chars` characters; pi-ai estimates 3.5 characters per token. */
function inputOf(chars: number) {
  return [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(chars) }] })]
}

/** The context clamp every Anthropic allowance carries for a model with this window. */
function contextClamp(contextWindow: number) {
  return { kind: 'context-window-clamp', contextWindow, reserveTokens: 4096, minimumTokens: 1 }
}

/** Prepare, assert nothing ran, dispatch, and return the single request body. */
async function dispatch(p: Probe, config: LlmCallConfig, input = messages) {
  const prepared = await p.ctx.llm.prepareCall(config)
  expect(p.requests).toHaveLength(0)
  expect(p.authCalls()).toBe(config.provider === 'openai' && (config.temperature !== undefined || config.maxTokens !== undefined) ? 1 : 0)
  await collect(prepared.stream({ ...prepared.config, messages: input }))
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
        maxTokens: { kind: 'supported', constraints: [contextClamp(200_000)] },
      })
      expect(body).toMatchObject({ max_tokens: 777, temperature: 0.2, thinking: { type: 'disabled' } })
    } finally { await p.dispose() }
  })

  it('budget-based reasoning in normal context: the legacy allowance is translated and still sends 17161', async () => {
    const p = await probe('anthropic', {})
    try {
      const { prepared, body } = await dispatch(p, {
        provider: 'anthropic', model: 'claude-sonnet-4-5', maxTokens: 777, reasoningEffort: ReasoningEffortId('high'),
      })
      expect(prepared.assessment.fields.maxTokens).toEqual({
        kind: 'translated',
        translations: [{ kind: 'add-thinking-allowance', thinkingTokens: 16_384, answerReserve: 1_024, zeroBudgetSends: 1_024 }],
        constraints: [{ kind: 'model-output-ceiling', maxTokens: 64_000 }, contextClamp(200_000)],
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
      expect(body).toMatchObject({ max_tokens: 777 + 4_096, thinking: { budget_tokens: 3_849 } })
    } finally { await p.dispose() }
  })

  it('adaptive reasoning in normal context: the allowance is supported and still sends 777', async () => {
    const p = await probe('anthropic', {})
    try {
      const { prepared, body } = await dispatch(p, {
        provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 777, reasoningEffort: ReasoningEffortId('high'),
      })
      expect(prepared.assessment.fields.maxTokens).toEqual({ kind: 'supported', constraints: [contextClamp(1_000_000)] })
      expect(body).toMatchObject({ max_tokens: 777, thinking: { type: 'adaptive' } })
    } finally { await p.dispose() }
  })

  describe('model and context constraints reach the wire', () => {
    const budget = { provider: 'anthropic', model: 'claude-sonnet-4-5', maxTokens: 777, reasoningEffort: ReasoningEffortId('high') }

    it('a finite model output ceiling caps the sum and lowers the thinking budget: total 10000, not the predicted 17161', async () => {
      const p = await probe('anthropic', { modelOverrides: { 'claude-sonnet-4-5': { maxTokens: 10_000 } } })
      try {
        const { prepared, body } = await dispatch(p, budget)
        expect(prepared.assessment.fields.maxTokens).toEqual({
          kind: 'translated',
          translations: [{ kind: 'add-thinking-allowance', thinkingTokens: 16_384, answerReserve: 1_024, zeroBudgetSends: 1_024 }],
          constraints: [{ kind: 'model-output-ceiling', maxTokens: 10_000 }, contextClamp(200_000)],
        })
        expect(777 + 16_384).toBe(17_161)
        expect(body).toMatchObject({ max_tokens: 10_000, thinking: { type: 'enabled', budget_tokens: 8_976 } })
      } finally { await p.dispose() }
    })

    it('adaptive thinking: a window of 5000 with a fitting 1600-character input lowers the 777 allowance to 446', async () => {
      const p = await probe('anthropic', { modelOverrides: { 'claude-sonnet-4-6': { contextWindow: 5_000 } } })
      try {
        const { prepared, body } = await dispatch(p, { ...budget, model: 'claude-sonnet-4-6' }, inputOf(1_600))
        expect(prepared.assessment.fields.maxTokens).toEqual({ kind: 'supported', constraints: [contextClamp(5_000)] })
        expect(5_000 - Math.ceil(1_600 / 3.5) - 4_096).toBe(446)
        expect(body).toMatchObject({ max_tokens: 446, thinking: { type: 'adaptive' } })
      } finally { await p.dispose() }
    })

    it('adaptive thinking: the same window with a short input leaves the allowance unchanged', async () => {
      const p = await probe('anthropic', { modelOverrides: { 'claude-sonnet-4-6': { contextWindow: 5_000 } } })
      try {
        const { body } = await dispatch(p, { ...budget, model: 'claude-sonnet-4-6' })
        expect(body).toMatchObject({ max_tokens: 777 })
      } finally { await p.dispose() }
    })

    it('budget thinking: the context clamp lowers the ceiling to 446 and the zero thinking budget is sent as 1024', async () => {
      const p = await probe('anthropic', { modelOverrides: { 'claude-sonnet-4-5': { contextWindow: 5_000 } } })
      try {
        const { prepared, body } = await dispatch(p, budget, inputOf(1_600))
        expect(prepared.assessment.fields.maxTokens).toMatchObject({ constraints: [{ kind: 'model-output-ceiling' }, contextClamp(5_000)] })
        expect(body).toMatchObject({ max_tokens: 446, thinking: { type: 'enabled', budget_tokens: ZERO_BUDGET_SENDS } })
      } finally { await p.dispose() }
    })

    it('a thinking budget that does not fit beside the answer reserve is lowered: custom budget 1024 sends 1801 with thinking 777', async () => {
      const p = await probe('anthropic', { thinkingBudgets: { high: 1_024 } })
      try {
        const { prepared, body } = await dispatch(p, budget)
        expect(prepared.assessment.fields.maxTokens).toMatchObject({ translations: [{ thinkingTokens: 1_024, answerReserve: 1_024 }] })
        expect(body).toMatchObject({ max_tokens: 1_801, thinking: { type: 'enabled', budget_tokens: 777 } })
      } finally { await p.dispose() }
    })

    it('reasoning off sends an allowance above the model output ceiling, so no ceiling is claimed', async () => {
      const p = await probe('anthropic', { modelOverrides: { 'claude-sonnet-4-5': { maxTokens: 10_000 } } })
      try {
        const { prepared, body } = await dispatch(p, { ...budget, maxTokens: 20_000, reasoningEffort: ReasoningEffortId('off') })
        expect(prepared.assessment.fields.maxTokens).toEqual({ kind: 'supported', constraints: [contextClamp(200_000)] })
        expect(body).toMatchObject({ max_tokens: 20_000, thinking: { type: 'disabled' } })
      } finally { await p.dispose() }
    })
  })

  const windowModel: Model<'anthropic-messages'> = {
    id: 'windowless',
    name: 'windowless',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://no-network.invalid',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 0,
    maxTokens: 8_000,
  }

  it('pins the reserve and minimum to the installed pi-ai clamp', () => {
    const clamp = (contextWindow: number) => clampMaxTokensToContext(
      { ...windowModel, contextWindow },
      normalizeContext({ messages: [] }),
      1_000_000,
    )
    expect(clamp(10_000)).toBe(10_000 - CONTEXT_RESERVE_TOKENS)
    expect(clamp(100)).toBe(MINIMUM_WIRE_TOKENS)
    expect(clamp(0)).toBe(1_000_000)
  })

  it('a model without a positive window reports no context clamp', () => {
    const model = windowModel
    const profile = resolveProfiles({ anthropic: {} }).get('anthropic')
    expect(profile).toBeDefined()
    if (profile === undefined) return
    const allowance = (reasoningEffort: ReasoningEffortId) =>
      assessPiAiControls(model, profile, { maxTokens: 9, reasoningEffort }).fields.maxTokens
    expect(allowance(ReasoningEffortId('off'))).toEqual({ kind: 'supported' })
    expect(allowance(ReasoningEffortId('high'))).toMatchObject({ constraints: [{ kind: 'model-output-ceiling', maxTokens: 8_000 }] })
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
  it('OpenAI API-shaped credential binds temperature and keeps legacy allowance protocol-unverified', async () => {
    const p = await probe('openai', {})
    try {
      const { prepared, body } = await dispatch(p, { provider: 'openai', model: 'gpt-5.5', temperature: 0.2, maxTokens: 777 })
      expect(prepared.assessment.fields).toMatchObject({
        temperature: { kind: 'supported' },
        maxTokens: { kind: 'unverified', reason: 'protocol-unverified' },
      })
      expect(body).toMatchObject({ max_output_tokens: 777, temperature: 0.2 })
    } finally { await p.dispose() }
  })

  it('OpenAI allowance below the Responses minimum is not claimed supported: still raised to 16 and unverified', async () => {
    const p = await probe('openai', {})
    try {
      const { prepared, body } = await dispatch(p, { provider: 'openai', model: 'gpt-5.5', maxTokens: 1 })
      expect(prepared.assessment.fields.maxTokens).toEqual({ kind: 'unverified', reason: 'protocol-unverified' })
      expect(body).toMatchObject({ max_output_tokens: 16 })
    } finally { await p.dispose() }
  })

  it('OpenAI sign-in credential on the official endpoint refuses before dispatch', async () => {
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
      await expect(ctx.llm.prepareCall({ provider: 'openai', model: 'gpt-5.5', temperature: 0.2, maxTokens: 777 }))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL', failure: { unsupportedControl: { control: 'temperature', reason: 'account-omits' } } })
      expect(server.requests).toHaveLength(0)
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

  it('finalization preserves pure effort facts and cannot invent support for an undeclared one', () => {
    const profile = resolveProfiles({ openai: {} }).get('openai')
    const model = profile?.piProvider?.getModels()[0]
    if (model === undefined || model.type !== 'chat') throw new Error('missing captured model')
    const effort = { reasoningEffort: ReasoningEffortId('off'), temperature: 0.2 }
    const auth = { source: 'synthetic', auth: { apiKey: 'sk-synthetic' } }
    expect(finalizeOpenAiControls(model, effort, { fields: {} }, auth).fields.reasoningEffort)
      .toEqual({ kind: 'unverified', reason: 'adapter-undeclared' })
    expect(finalizeOpenAiControls(model, effort, { fields: { reasoningEffort: { kind: 'supported' } } }, auth).fields.reasoningEffort)
      .toEqual({ kind: 'supported' })
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
