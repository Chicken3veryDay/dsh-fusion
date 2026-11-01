/** Loader composition, real JSONL restart and parked Agent context lineage. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Llm from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
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
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeCredentials } from '../../../preset/fusion-config/tests/harness.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ReactLoopAgent } from '../../../core/agent-loop/src/agent.ts'
import Participants from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function mount(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'fusion-participants-'))
  if (!roots.includes(root)) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    group: Group, llm: Llm, sessions: Sessions, projections: Projections, prompt: Prompt, tools: Tools,
    native: Native, agents: Agents, loop: Loop, presets: Presets, preset: Preset, commands: Commands,
    credentials: FakeCredentials, config: FusionConfig, jsonl: Jsonl, participants: Participants,
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
  await ctx.loader.await()
  const adapter = new MockAdapter(Array.from({ length: 8 }, () => textResponse('retained answer')), {
    efforts: ['low', 'medium', 'high'].map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
  })
  ctx.llm.registerAdapter(['omniroute-openai', 'omniroute-anthropic'], adapter)
  return { ctx, root, adapter }
}
async function read(ctx: Context, id: SessionId) {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try { return (await reader.read()).events } finally { await reader.close() }
}
const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

it('captures Top role links, holds root first, re-adopts exact writers and restores queued input without claims', async () => {
  const { ctx, root, adapter } = await mount()
  const creates: SessionId[] = []
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => { creates.push(header.id); return create(header, options) })
  const claims = vi.fn()
  ctx.on('agent/inbox/claimed', claims)
  const task = await ctx.fusionParticipants.prepare('top')
  const roster = task.roster
  expect(roster.participants).toHaveLength(3)
  expect(roster.roles.decider).toBe(roster.roles.userFacingLead)
  expect(roster.roles.takeover).toBe(roster.roles.userFacingLead)
  expect(roster.roles.userFacingLead).not.toBe(roster.roles.otherCoLead)
  expect(creates).toEqual([roster.rootSessionId, ...roster.participants.map(row => row.id)])
  expect(adapter.requests).toHaveLength(0)
  expect(claims).not.toHaveBeenCalled()
  const rootEvents = await read(ctx, roster.rootSessionId)
  expect(rootEvents.filter(event => event.type === 'fusion/participant-established')).toHaveLength(3)
  const one = await task.adopt('userFacingLead')
  const proof = await ctx.sessionPersistence.flushSessionDurably(one.agent.session)
  one.agent.followup(message('first'))
  await one.agent.whenIdle()
  expect(claims).not.toHaveBeenCalled()
  expect(adapter.requests).toHaveLength(0)
  await one.dispose()
  const two = await task.adopt('decider')
  expect(two.agent.session).toBe(one.agent.session)
  expect(two.agent.inbox.nextTurn).toHaveLength(1)
  const after = await ctx.sessionPersistence.flushSessionDurably(two.agent.session)
  expect(after).toMatchObject({ kind: 'durable', ...proof.kind === 'durable' ? { writer: proof.writer } : {} })
  await task.dispose()
  const second = await mount(root)
  const opens: SessionId[] = []
  const open = second.ctx.sessionPersistence.open.bind(second.ctx.sessionPersistence)
  vi.spyOn(second.ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => { if (access === 'write') opens.push(id); return open(id, access, options) })
  const recovered = await second.ctx.fusionParticipants.recover(roster.rootSessionId)
  expect(recovered.roster).toEqual(roster)
  expect(opens).toEqual([roster.rootSessionId, ...roster.participants.map(row => row.id)])
  const three = await recovered.adopt('userFacingLead')
  expect(three.agent.inbox.nextTurn).toHaveLength(1)
  three.agent.steer(message('second'))
  await three.agent.whenIdle()
  expect(second.adapter.requests).toHaveLength(0)
  await expect(second.ctx.agents.resume({ resumeSessionId: three.agent.id })).rejects.toThrow()
  await recovered.dispose()
})

it('keeps a single participant and actually reuses fake model context after detach and restart', async () => {
  const { ctx, root, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  expect(task.roster.participants).toHaveLength(1)
  const first = await task.adopt('participant')
  if (!(first.agent instanceof ReactLoopAgent)) throw new Error('expected production driver')
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  await first.agent.testOnlyTurn(message('remember alpha'))
  expect(errors).toEqual([])
  expect(adapter.requests).toHaveLength(1)
  await first.dispose()
  const second = await task.adopt('decider')
  if (!(second.agent instanceof ReactLoopAgent)) throw new Error('expected production driver')
  await second.agent.testOnlyTurn(message('remember beta'))
  expect(adapter.requests).toHaveLength(2)
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('remember alpha')
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('retained answer')
  const rootId = task.roster.rootSessionId
  await task.dispose()
  const restarted = await mount(root)
  const recovered = await restarted.ctx.fusionParticipants.recover(rootId)
  const third = await recovered.adopt('participant')
  if (!(third.agent instanceof ReactLoopAgent)) throw new Error('expected production driver')
  await third.agent.testOnlyTurn(message('recall both'))
  expect(restarted.adapter.requests).toHaveLength(1)
  expect(JSON.stringify(restarted.adapter.requests[0]?.messages)).toContain('remember alpha')
  expect(JSON.stringify(restarted.adapter.requests[0]?.messages)).toContain('remember beta')
  await recovered.dispose()
})

it('fails closed on held root and participant leases, without replacing IDs or claiming work', async () => {
  const { ctx, root, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('top')
  const roster = task.roster
  const second = await mount(root)
  await expect(second.ctx.fusionParticipants.recover(roster.rootSessionId)).rejects.toThrow()
  await task.dispose()
  const held = await ctx.sessionPersistence.open(roster.participants[1]!.id, 'write')
  await expect(second.ctx.fusionParticipants.recover(roster.rootSessionId)).rejects.toThrow()
  expect(second.ctx.sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
  expect(second.adapter.requests).toHaveLength(0)
  await held.close()
  const recovered = await second.ctx.fusionParticipants.recover(roster.rootSessionId)
  expect(recovered.roster).toEqual(roster)
  await recovered.dispose()
})

it('keeps partial provisioning recoverable and never replaces an established missing participant', async () => {
  const { ctx, root, adapter } = await mount()
  const stat = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence)
  let rootId: SessionId | undefined
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  let count = 0
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    if (++count === 1) rootId = args[0].id
    if (count === 3) throw new Error('participant acquisition failed')
    return create(...args)
  })
  await expect(ctx.fusionParticipants.prepare('top')).rejects.toMatchObject({ code: 'fusion-participants/preparation-blocked', cleanup: 'complete' })
  expect(rootId).toBeDefined()
  expect(ctx.sessions.list()).toHaveLength(0)
  vi.restoreAllMocks()
  const recovered = await ctx.fusionParticipants.recover(rootId!)
  const roster = recovered.roster
  await recovered.dispose()
  vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(async (id, options) => id === roster.participants[0]!.id ? undefined : stat(id, options))
  await expect(ctx.fusionParticipants.recover(rootId!)).rejects.toMatchObject({ rootSessionId: rootId, cleanup: 'complete' })
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
  const restarted = await mount(root)
  const task = await restarted.ctx.fusionParticipants.recover(rootId!)
  expect(task.roster).toEqual(roster)
  await task.dispose()
})

it('refuses failed barriers, stale task capabilities and unknown roles without admitting input', async () => {
  const { ctx, adapter } = await mount()
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockResolvedValue({ kind: 'refused', reason: 'flush-failed', cause: new Error('injected flush failure') })
  await expect(ctx.fusionParticipants.prepare('top')).rejects.toMatchObject({ cleanup: 'complete' })
  vi.restoreAllMocks()
  const task = await ctx.fusionParticipants.prepare('single-test')
  await expect(task.adopt('unknown')).rejects.toThrow('not owned')
  await task.dispose()
  await expect(task.adopt('participant')).rejects.toThrow('not owned')
  expect(adapter.requests).toHaveLength(0)
})

it('awaits cancellation during root acquisition and leaves no live routes', async () => {
  const { ctx } = await mount()
  const abort = new AbortController()
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    const writer = await create(...args)
    abort.abort(new Error('stop preparing'))
    return writer
  })
  await expect(ctx.fusionParticipants.prepare('top', abort.signal)).rejects.toMatchObject({ cleanup: 'complete' })
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(ctx.agents.list()).toHaveLength(0)
})

it('validates immutable restored membership and preserves separately selected decider contexts', async () => {
  const { captureRoster, rosterSchema } = await import('../src/roster.ts')
  const { ctx } = await mount()
  const selection = ctx.fusionConfig.selection('middle')
  const digest = 'a'.repeat(64)
  const roster = captureRoster(selection, digest)
  expect(roster.tier).toBe('middle')
  expect(roster.upgrades).toEqual(selection.upgrades)
  const separate = captureRoster({ ...selection, authority: { ...selection.authority, decider: 'decider' } }, digest)
  expect(separate.roles.decider).not.toBe(separate.roles.lead)
  expect(() => captureRoster({ ...selection, roles: {} }, digest)).toThrow('decider')
  expect(() => captureRoster({ ...selection, authority: { decider: 'decider', takeover: 'otherCoLead' } }, digest)).toThrow('takeover')
  expect(rosterSchema.safeParse({ ...roster, roles: {} }).success).toBe(false)
  expect(rosterSchema.safeParse({ ...roster, mode: 'single' }).success).toBe(false)
  const top = captureRoster(ctx.fusionConfig.selection('top'), digest)
  expect(rosterSchema.safeParse({ ...top, roles: { ...top.roles, otherCoLead: top.roles.userFacingLead } }).success).toBe(false)
  expect(rosterSchema.safeParse({ ...top, participants: [...top.participants].reverse() }).success).toBe(false)
  const single = captureRoster(ctx.fusionConfig.selection('single-test'), digest)
  expect(rosterSchema.safeParse({ ...single, participants: [...single.participants, ...single.participants] }).success).toBe(false)
  expect(Object.isFrozen(single)).toBe(true)
})

it('refuses malformed or duplicate required lifecycle records during real restart', async () => {
  const { ctx } = await mount()
  const { rosterProjection } = await import('../src/state.ts')
  const task = await ctx.fusionParticipants.prepare('single-test')
  const roster = task.roster
  const session = ctx.sessions.get(roster.rootSessionId)!
  session.append('fusion/roster', roster)
  await task.dispose()
  await expect(ctx.fusionParticipants.recover(roster.rootSessionId)).rejects.toMatchObject({ cleanup: 'complete' })
  const other = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(other.roster.rootSessionId)!
  root.append('fusion/participant-established', { participantId: SessionId('foreign') })
  await other.dispose()
  await expect(ctx.fusionParticipants.recover(other.roster.rootSessionId)).rejects.toMatchObject({ cleanup: 'complete' })
  expect(rosterProjection.init()).toEqual({ roster: null, established: [] })
})

it('refuses a root without a roster, composition replacement, and service disposal with a parked resident', async () => {
  const { ctx } = await mount()
  const rootId = SessionId('no-roster')
  const root = await ctx.agents.retain({ sessionId: rootId, mode: 'create', agentOptions: {} })
  await root.dispose()
  await expect(ctx.fusionParticipants.recover(rootId)).rejects.toMatchObject({ cleanup: 'complete' })
  const task = await ctx.fusionParticipants.prepare('single-test')
  const id = task.roster.rootSessionId
  await task.dispose()
  const read = ctx.agentPresets.readDocument.bind(ctx.agentPresets)
  vi.spyOn(ctx.agentPresets, 'readDocument').mockImplementation(async preset => ({ ...await read(preset), content: 'changed' }))
  await expect(ctx.fusionParticipants.recover(id)).rejects.toMatchObject({ cleanup: 'complete' })
  vi.restoreAllMocks()
  const recovered = await ctx.fusionParticipants.recover(id)
  const resident = await recovered.adopt('participant')
  await ctx.fiber.dispose()
  expect(resident.agent.status).toBe('idle')
  await expect(recovered.adopt('participant')).rejects.toThrow()
})
