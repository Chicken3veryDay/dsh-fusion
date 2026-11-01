/** Real Loader/configuration/registry/command services; only credentials and HTTP are fake. */
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { load } from 'js-yaml'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import Commands from '@deepseek-ai/dsh-commands'
import CredentialProvider from '@deepseek-ai/dsh-credentials'
import type { CredentialRef, CredentialKey, CredentialRecord, CredentialInfo } from '@deepseek-ai/dsh-credentials'
import FusionConfig, { shippingCatalog } from '../src/index.ts'
import type { ModelDefinition, SelectionDefinition } from '../src/index.ts'

export const SENTINEL = 'sentinel-not-a-real-credential'
export class FakeCredentials extends CredentialProvider {
  present = true
  failure = false
  reads = 0
  async resolve(_ref: CredentialRef) {
    this.reads++
    if (this.failure) throw new Error(SENTINEL)
    return this.present ? { value: SENTINEL, source: 'fake' } : undefined
  }
  async describe(_ref: CredentialRef): Promise<CredentialInfo> { return { configured: this.present, writable: false } }
  async set(_ref: CredentialRef, _value: string) { throw new Error('read-only fake') }
  async unset(_ref: CredentialRef) { throw new Error('read-only fake') }
  async list() { return [] }
  async listRecords() { return [] }
  async readRecord(_key: CredentialKey) { return undefined }
  async describeRecord(_key: CredentialKey) { return { configured: false, writable: false } }
  async modifyRecord(_key: CredentialKey, _fn: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> { throw new Error('read-only fake') }
  async deleteRecord(_key: CredentialKey) { throw new Error('read-only fake') }
}

export async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const requests: { url: string; method: string; credential: string | undefined }[] = []
  let inference = 0
  const http = createServer((request, response) => {
    requests.push({ url: request.url ?? '', method: request.method ?? '', credential: request.headers.authorization ?? request.headers['x-api-key']?.toString() })
    if (request.method !== 'GET') inference++
    handler(request, response)
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Expected allocated TCP address')
  return {
    baseURL: `http://127.0.0.1:${address.port}`, requests,
    get inference() { return inference },
    async close() { const closed = once(http, 'close'); http.close(); http.closeAllConnections(); await closed },
  }
}

export function configuration(baseURL: string) {
  const bindings = shippingCatalog('FUSION_TEST_KEY').slice(0, 8).map((row): ModelDefinition => ({
    ...structuredClone(row), catalogRevision: 'fixture-v1',
    baseURL: row.transport === 'openai-responses' ? `${baseURL}/v1` : baseURL,
  }))
  const reference = (presetId: string) => ({ catalogRevision: 'fixture-v1', presetId })
  const selection: SelectionDefinition = {
    id: 'test-pair', revision: 'fixture-v1', agentPreset: 'standard', auxiliaries: {},
    topology: { kind: 'middle', lead: reference('Astra'), executor: reference('Sonnet'), upgrades: [reference('Opus')] },
    decider: reference('Sol'), takeover: reference('Astra'),
  }
  const providers = Object.fromEntries(['OpenAI', 'Anthropic'].map((family) => {
    const rows = bindings.filter(row => row.family === family)
    const first = rows[0]!
    return [first.providerId, {
      api: first.transport, baseURL: first.baseURL, apiKeyEnv: first.credentialRef, transport: 'sse' as const,
      models: rows.map(row => ({ id: row.wireModelId, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
        ...family === 'Anthropic' ? { compat: { forceAdaptiveThinking: true } } : {} })),
    }]
  }))
  return {
    credentialRef: 'FUSION_TEST_KEY', agentPreset: 'standard', providers, bindings,
    declarations: bindings.map(row => ({ providerId: row.providerId, wireModelId: row.wireModelId, tools: true, structuredDecisions: true, efforts: ['low', 'medium', 'high'] })),
    selections: [selection], metadataLimits: { responseBytes: 32768, totalBytes: 262144, pages: 32, timeoutMs: 5000 },
  }
}

/** YAML composition is the package entry path, with external test inputs supplied before mount. */
export async function harness(document?: unknown) {
  const ctx = new Context()
  ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    group: Group, llm: LlmRuntime, sessions: SessionStore, projections: SessionProjections, prompt: SystemPrompt,
    tools: Tools, agents: AgentRegistry, loop: AgentLoop, presets: AgentPresets, preset: AgentPreset,
    commands: Commands, credentials: FakeCredentials, fusion: FusionConfig,
  })
  const parsed: unknown = load(await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8'))
  // YAML entries are validated by Loader; no registry or command service is replaced.
  const problem = entryListProblem(parsed)
  if (problem !== undefined) throw new Error(problem)
  const entries = parsed as Parameters<typeof ctx.loader.create>[0][]
  for (const entry of entries) await ctx.loader.create(entry)
  await ctx.loader.await()
  if (document !== undefined) {
    const entry = { name: 'cordis:fusion', id: 'fusion', config: { document } }
    await ctx.loader.create(entry)
    await ctx.loader.await()
  }
  const handle = await ctx.agents.create({ sessionId: SessionId('fusion-config-test'), setup: inner => ctx.agentPresets.mount(inner, 'standard').then(() => {}) })
  return { ctx, agent: handle.agent, async dispose() { await ctx.fiber.dispose() } }
}
