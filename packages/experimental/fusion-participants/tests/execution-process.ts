/** Public Loader process fixture: sticky writer ownership is released only by explicit process exit. */
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Preset from '@deepseek-ai/dsh-agent-preset'
import Commands from '@deepseek-ai/dsh-commands'
import Credentials from '@deepseek-ai/dsh-credentials'
import type { CredentialRef, CredentialInfo, CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import FusionConfig from '@deepseek-ai/dsh-fusion-config'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ExecutionHostProvider } from '../src/execution-host.ts'

class FakeCredentials extends Credentials {
  async resolve(_ref: CredentialRef) { return { value: 'fake-not-a-key', source: 'fake' } }
  async describe(_ref: CredentialRef): Promise<CredentialInfo> { return { configured: true, writable: false } }
  async set(_ref: CredentialRef, _value: string) { throw new Error('read-only fake') }
  async unset(_ref: CredentialRef) { throw new Error('read-only fake') }
  async list() { return [] }
  async listRecords() { return [] }
  async readRecord(_key: CredentialKey) { return undefined }
  async describeRecord(_key: CredentialKey) { return { configured: false, writable: false } }
  async modifyRecord(_key: CredentialKey, _fn: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> { throw new Error('read-only fake') }
  async deleteRecord(_key: CredentialKey) { throw new Error('read-only fake') }
}
const [mode, directory, plane, rootId] = process.argv.slice(2)
assert(directory !== undefined)
const { default: Participants } = await import(plane === 'src' ? '../src/index.ts' : '@deepseek-ai/dsh-experimental-fusion-participants') as typeof import('../src/index.ts')
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(Loader)
Object.assign(ctx.loader.builtins, { group: Group, loop: Loop, presets: Presets, preset: Preset, commands: Commands,
  credentials: FakeCredentials, config: FusionConfig, jsonl: Jsonl, participants: Participants })
for (const entry of [
  { name: 'cordis:jsonl', config: { root: directory, compression: 'none' } },
  { name: 'cordis:loop', config: { agents: [] } },
  { name: 'cordis:presets', config: { default: 'standard' } },
  { name: 'cordis:preset', config: { id: 'standard', plugins: [] } },
  { name: 'cordis:commands' }, { name: 'cordis:credentials' },
  { name: 'cordis:config', config: { document: {
    credentialRef: 'PARTICIPANTS_TEST', agentPreset: 'standard', providers: {}, declarations: [], bindings: [],
    selections: [{ id: 'single-test', revision: 'test-v1', agentPreset: 'standard',
      topology: { kind: 'single', participant: { catalogRevision: 'v1', presetId: 'Sol' } }, auxiliaries: {} }],
    metadataLimits: { responseBytes: 32768, totalBytes: 262144, pages: 32, timeoutMs: 5000 },
  } } }, { name: 'cordis:participants' },
]) await ctx.loader.create(entry)
await ctx.loader.await()
let requests = 0, registrations = 0, preparations = 0, bodies = 0, cleanups = 0, cancellations = 0
ctx.on('llm/stream', () => { requests++; throw new Error('inference forbidden') })
const task = mode === 'recover' ? await ctx.fusionParticipants.recover(SessionId(rootId!)) : await ctx.fusionParticipants.prepare('single-test')
assert.equal(task.execution.owner, null)
assert.equal(registrations, 0)
const adopted = await task.adopt('participant')
const provider: ExecutionHostProvider = {
  name: 'public-process-fake', revision: '1', classify: () => 'mutation',
  registerHeld() {
    registrations++
    if (mode === 'allocation-throw') throw new Error('allocation anchor unavailable')
    return {
      async prepare() {
        preparations++
        return { invoke() {
          bodies++
          if (mode === 'crash') {
            process.stdout.write(JSON.stringify({ rootId: task.roster.rootSessionId, participantId: adopted.agent.session.id, bodies, requests }) + '\n')
            process.exit(0)
          }
          if (mode === 'invoke-throw') throw new Error('entry outcome unknown')
          if (mode === 'result') adopted.agent.session.matchesDurabilityPrefix = async () => false
          return Promise.resolve(mode === 'uncertain' ? 'uncertain' : 'completed')
        } }
      },
      cancel() { cancellations++; if (mode === 'cancel') throw new Error('cancellation outcome unknown') },
      async cleanup() { cleanups++; if (mode === 'cleanup') throw new Error('descendant cleanup unknown') },
    }
  },
}
if (mode === 'rollback') {
  const reserve = ctx.sessionPersistence.reserveSessionWriter.bind(ctx.sessionPersistence)
  ctx.sessionPersistence.reserveSessionWriter = (session) => {
    if (session.id !== task.roster.rootSessionId) return { kind: 'refused', reason: 'missing-writer' }
    const result = reserve(session)
    if (result.kind !== 'reserved') return result
    return { kind: 'reserved', reservation: { ...result.reservation, release: () => Promise.reject(new Error('rollback unknown')) } }
  }
  await assert.rejects(ctx.fusionParticipants.registerExecutionHost(task, provider), /enrollment-cleanup/)
  await assert.rejects(task.dispose())
  assert.equal(task.execution.phase, 'blocked')
  await assert.rejects(ctx.sessionPersistence.open(task.roster.rootSessionId, 'write'))
  process.stdout.write(JSON.stringify({ rootId: task.roster.rootSessionId, participantId: adopted.agent.session.id,
    bodies, preparations, registrations, requests, unknown: 0, blocked: true, independentWriter: 'denied' }) + '\n')
  process.exit(0)
}
const host = await ctx.fusionParticipants.registerExecutionHost(task, provider)
if (mode === 'recover') {
  assert.equal(task.execution.unknown.length, 1)
  await assert.rejects(host.grant(host.controller, adopted.agent.session.id))
  assert.throws(() => host.bindRun(host.issuer, adopted.agent, new AbortController().signal))
  assert.equal(registrations + preparations + bodies + requests, 0)
} else {
  await host.grant(host.controller, adopted.agent.session.id)
  const attempt = host.reserve(host.bindRun(host.issuer, adopted.agent, new AbortController().signal), 'edit')
  const registration = host.register(attempt)
  if (mode === 'allocation-throw') await assert.rejects(registration)
  else {
    await registration
    assert.deepEqual([registrations, preparations, bodies, requests], [1, 0, 0, 0])
    if (mode === 'cancel') await assert.rejects(host.revoke(host.controller, 'cancel'))
    else {
      if (mode === 'start') adopted.agent.session.matchesDurabilityPrefix = async () => false
      const release = host.release(attempt)
      const settled = await release
      assert.equal(host.release(attempt), release)
      if (mode === 'smoke') {
        assert.deepEqual(settled, { kind: 'settled', outcome: 'completed' })
        assert.deepEqual([bodies, cleanups, requests], [1, 1, 0])
        await host.dispose(); await adopted.dispose(); await task.dispose(); await ctx.fiber.dispose()
        process.stdout.write(JSON.stringify({ bodies, cleanups, requests, plane, disposed: true }) + '\n')
        process.exit(0)
      }
      assert.equal(settled.kind, 'blocked')
      assert.equal((await host.release(attempt)).kind, 'blocked')
      assert.equal(bodies, mode === 'start' ? 0 : 1)
    }
  }
}
await assert.rejects(host.grant(host.controller, adopted.agent.session.id))
await assert.rejects(host.dispose())
await assert.rejects(task.dispose())
assert.equal(task.execution.phase, 'blocked')
assert(task.execution.unknown.length > 0)
await assert.rejects(ctx.sessionPersistence.open(adopted.agent.session.id, 'write'))
let closed = false
// The exact retained lease still owns its writer; independent acquisition above cannot steal it.
void Promise.resolve().then(() => { closed = task.execution.phase === 'stopped' })
await setImmediate()
assert.equal(closed, false)
process.stdout.write(JSON.stringify({ rootId: task.roster.rootSessionId, participantId: adopted.agent.session.id,
  bodies, preparations, registrations, cleanups, cancellations, requests, unknown: task.execution.unknown.length,
  blocked: true, independentWriter: 'denied' }) + '\n')
process.exit(0)
