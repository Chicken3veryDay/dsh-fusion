/** Offline requests through the installed pi-ai implementations with synthetic grants. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as PiAi from '../src/index.ts'
import { assemble } from './assemble.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

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
    expect((await ctx.llm.listModels('openai')).map(({ id, name }) => ({ id, name }))).toEqual([{ id: 'gpt-5.4-mini', name: 'Account mini' }, { id: 'gpt-5.4', name: 'Account flagship' }])
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve({ ...grant, payload: { ...grant.payload, access: 'second-account' } }))
    expect((await ctx.llm.listModels('openai')).map(({ id, name }) => ({ id, name }))).toEqual([{ id: 'gpt-5.4', name: 'Second account' }])
    expect(server.paths).toEqual(['/v1/models', '/v1/models'])
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer synthetic-access', 'Bearer second-account'])
  })

  it('refuses a saved Anthropic grant on an explicit keyless route without I/O or deleting it', async () => {
    const server = await mockServer([{ events: anthropicTextEvents }])
    const ctx = await signedIn('anthropic', server.url)
    expect((await assemble(ctx, { provider: 'anthropic', model: 'claude-sonnet-4-5', messages: [] })).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH', message: expect.stringContaining('API key') } })
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
    expect(await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).toEqual([{ id: 'gpt-5.4', name: 'Plan model' }])
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
