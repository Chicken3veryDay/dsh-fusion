/** Built Loader smoke: real JSONL refusal preserves the injected handle-flush cause. */
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import CredentialProvider from '@deepseek-ai/dsh-credentials'
import type { CredentialRef, CredentialKey, CredentialRecord, CredentialInfo } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Llm from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import Agents from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Preset from '@deepseek-ai/dsh-agent-preset'
import Commands from '@deepseek-ai/dsh-commands'
import FusionConfig from '@deepseek-ai/dsh-fusion-config'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
const { default: Storage } = await import(new URL('../../../../storage/storage/lib/index.js', import.meta.url).href).then((module: typeof import('@deepseek-ai/dsh-storage')) => module)
const Json = await import(new URL('../../../../storage/storage-json/lib/index.js', import.meta.url).href).then((module: typeof import('@deepseek-ai/dsh-storage-json')) => module)
const Domain = await import(new URL('../../../../storage/storage-domain/lib/index.js', import.meta.url).href).then((module: typeof import('@deepseek-ai/dsh-storage-domain')) => module)
const { default: Cache } = await import(new URL('../../../../session/session-projection-cache/lib/index.js', import.meta.url).href).then((module: typeof import('@deepseek-ai/dsh-session-projection-cache')) => module)
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Participants from '@deepseek-ai/dsh-experimental-fusion-participants'

class FakeCredentials extends CredentialProvider {
  present = true
  failure = false
  reads = 0
  async resolve(_ref: CredentialRef) {
    this.reads++
    if (this.failure) throw new Error('retained-fake')
    return this.present ? { value: 'retained-fake', source: 'fake' } : undefined
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

const artifacts = Object.fromEntries([
  '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-experimental-fusion-participants',
].map(name => [name, import.meta.resolve(name)] as const))
assert.ok(Object.values(artifacts).every(path => path.endsWith('/lib/index.js')))

const root = await mkdtemp(join(tmpdir(), 'retained-cause-built-'))
const ctx = new Context()
let requests = 0
class FakeModel extends LlmAdapter {
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, reasoning: { efforts: ['low', 'medium', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })) } }
  }
  async * stream(): AsyncIterable<StreamChunk> { requests++; throw new Error('inference forbidden') }
}
try {
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    group: Group, llm: Llm, sessions: Sessions, projections: Projections, prompt: Prompt, tools: Tools,
    native: Native, agents: Agents, loop: Loop, presets: Presets, preset: Preset, commands: Commands,
    credentials: FakeCredentials, config: FusionConfig, jsonl: Jsonl, participants: Participants,
    storage: Storage, json: Json, domain: Domain, cache: Cache,
  })
  const entries = [
    ...['llm', 'sessions', 'projections', 'prompt', 'tools', 'native', 'agents'].map(name => ({ name: `cordis:${name}` })),
    { name: 'cordis:jsonl', config: { root, compression: 'none' } },
    { name: 'cordis:loop', config: { agents: [] } },
    { name: 'cordis:presets', config: { default: 'standard' } },
    { name: 'cordis:preset', config: { id: 'standard', plugins: [] } },
    { name: 'cordis:commands' }, { name: 'cordis:credentials' },
    { name: 'cordis:config', config: { document: {
      credentialRef: 'PARTICIPANTS_TEST', agentPreset: 'standard', providers: {}, declarations: [], bindings: [],
      selections: [{ id: 'single-test', revision: 'test-v1', agentPreset: 'standard',
        topology: { kind: 'single', participant: { catalogRevision: 'v1', presetId: 'Sol' } }, auxiliaries: {} }],
      metadataLimits: { responseBytes: 32768, totalBytes: 262144, pages: 32, timeoutMs: 5000 },
    } } },
    { name: 'cordis:participants' },
  ]

  for (const entry of entries) await ctx.loader.create(entry)
  {
    for (const entry of [
      { name: 'cordis:storage' },
      { name: 'cordis:json', config: { root: join(root, 'projection-data') } },
      { name: 'cordis:domain', config: { backend: 'json' } },
      { name: 'cordis:cache', config: { writeEveryEvents: 100, writeIntervalMs: 60000 } },
    ]) await ctx.loader.create(entry)
  }
  await ctx.loader.await()
  assert.ok(ctx.get('sessionProjectionCache'), 'actual projection cache must remain enabled')
  ctx.llm.registerAdapter(['omniroute-openai', 'omniroute-anthropic'], new FakeModel())
  const failure = new Error('built original handle flush failure')
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  let injected = 0, creations = 0, flushes = 0, strictCalls = 0
  const injectCreate: typeof create = async (...args) => {
    creations++
    const writer = await create(...args)
    const flush = writer.flush.bind(writer)
    writer.flush = async (...options: Parameters<typeof flush>) => {
      flushes++
      // The eager cache can flush an empty handle before owner-event routing.
      const state: unknown = Reflect.get(writer, 'state')
      assert.ok(state !== null && typeof state === 'object' && 'cursor' in state && typeof state.cursor === 'number')
      if (state.cursor > 0 && injected === 0) { injected++; throw failure }
      return flush(...options)
    }
    return writer
  }
  Object.defineProperty(ctx.sessionPersistence, 'create', { configurable: true, value: injectCreate })
  let refusals = 0
  const strict = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  const observeStrict: typeof strict = async (session) => {
    strictCalls++
    const refusal = await strict(session)
    if (refusal.kind === 'refused') {
      assert.equal(refusal.reason, 'flush-failed')
      if (refusal.reason !== 'flush-failed') throw new Error('Missing actual JSONL flush refusal')
      assert.equal(refusal.cause, failure)
      refusals++
    }
    return refusal
  }
  Object.defineProperty(ctx.sessionPersistence, 'flushSessionDurably', { configurable: true, value: observeStrict })
  const result: unknown = await ctx.fusionParticipants.prepare('single-test').then(() => undefined, (error: unknown) => error)
  assert.ok(result instanceof Error && result.cause instanceof Error,
    inspect({ result, injected, creations, flushes, strictCalls }, { depth: 6 }))
  assert.equal(result.cause.message, 'retained session durability refused: flush-failed')
  assert.equal(result.cause.cause, failure, 'public refusal retains the exact original handle-flush error')
  assert.equal(refusals, 1)
  assert.equal(creations, 1)
  assert.equal(requests, 0)
  assert.equal(ctx.agents.list().length, 0)
  console.log(JSON.stringify({ kind: 'actual-jsonl-flush-failed', exactCause: true, requests, agents: ctx.agents.list().length, injected, creations, flushes, strictCalls, artifacts }))
} finally {
  try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
}
