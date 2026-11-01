/** Real JSONL leases and driver publication for inert retained contexts. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '../src/index.ts'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function mount(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'retained-'))
  if (!roots.includes(root)) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('stock')])
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, root, adapter }
}
const id = SessionId('retained')
const options = { sessionId: id, mode: 'create' as const, agentOptions: { provider: 'mock', model: 'fake' } }
const message = () => createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
async function read(ctx: Context) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try { return (await handle.read()).events } finally { await handle.close() }
}
it('retains the exact routed writer across parked adoption, detach and restart', async () => {
  const { ctx, root, adapter } = await mount()
  const retained = await ctx.agents.retain(options)
  const proof = await ctx.sessionPersistence.flushSessionDurably(retained.session)
  const open = vi.spyOn(ctx.sessionPersistence, 'open')
  const claims = vi.fn()
  ctx.on('agent/inbox/claimed', claims)
  const handle = await retained.adopt()
  expect(handle.agent.session).toBe(retained.session)
  handle.agent.followup(message())
  handle.agent.steer(message())
  await handle.agent.whenIdle()
  expect(claims).not.toHaveBeenCalled()
  expect(adapter.requests).toHaveLength(0)
  await expect(retained.adopt()).rejects.toThrow('twice')
  await handle.dispose()
  expect(ctx.sessions.get(id)).toBe(retained.session)
  expect(ctx.agents.get(id)).toBeUndefined()
  const next = await retained.adopt()
  expect(next.agent.session).toBe(retained.session)
  expect(next.agent.inbox.nextTurn).toHaveLength(1)
  const nextProof = await ctx.sessionPersistence.flushSessionDurably(retained.session)
  expect(proof.kind).toBe('durable')
  expect(nextProof).toMatchObject({ kind: 'durable', ...proof.kind === 'durable' ? { writer: proof.writer } : {} })
  expect(open).not.toHaveBeenCalled()
  await retained.dispose()
  expect(ctx.sessions.get(id)).toBeUndefined()
  const stored = await read(ctx)
  expect(stored.some(event => event.type === 'agent/runtime-owner')).toBe(true)
  await expect(ctx.agents.resume({ resumeSessionId: id })).rejects.toThrow('retained runtime owner')
  const second = await mount(root)
  const resumed = await second.ctx.agents.retain({ ...options, mode: 'resume' })
  const agent = await resumed.adopt()
  expect(agent.agent.inbox.nextTurn).toHaveLength(1)
  agent.agent.followup(message())
  await agent.agent.whenIdle()
  expect(second.adapter.requests).toHaveLength(0)
  await resumed.dispose()
})
it('refuses missing recovery, wrong-root ownership and absent durable routing', async () => {
  const { ctx } = await mount()
  await expect(ctx.agents.retain({ ...options, mode: 'resume' })).rejects.toThrow()
  const retained = await ctx.agents.retain(options)
  await retained.dispose()
  await expect(ctx.agents.retain({ ...options, mode: 'resume', root: retained })).rejects.toThrow('capability')
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockResolvedValue({ kind: 'refused', reason: 'missing-writer' })
  await expect(ctx.agents.retain({ ...options, sessionId: SessionId('unrouted') })).rejects.toThrow('missing-writer')
  expect(ctx.sessions.get(SessionId('unrouted'))).toBeUndefined()
})
it('leaves stock creation and followup active', async () => {
  const { ctx, adapter } = await mount()
  const handle = await ctx.agents.create({ sessionId: SessionId('stock'), agentOptions: options.agentOptions })
  handle.agent.followup(message())
  await handle.agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  await handle.dispose()
})

it('rejects retention without persistence and stock factories without the optional seam', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const releaseFactory = ctx.agents.setFactory({
    async createAgent() { throw new Error('unused') },
    async resume() { throw new Error('unused') },
  })
  await expect(ctx.agents.retain(options)).rejects.toThrow('support retained')
  releaseFactory()
  await ctx.plugin(AgentLoop, { agents: [] })
  await expect(ctx.agents.retain(options)).rejects.toThrow('require session persistence')
})

it('cancels an acquired writer before publication and releases its lease', async () => {
  const { ctx } = await mount()
  const abort = new AbortController()
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    const writer = await create(...args)
    abort.abort(new Error('cancel acquisition'))
    return writer
  })
  await expect(ctx.agents.retain({ ...options, signal: abort.signal })).rejects.toThrow('cancel acquisition')
  expect(ctx.sessions.get(id)).toBeUndefined()
  vi.restoreAllMocks()
  const replacement = await ctx.agents.retain(options)
  await replacement.dispose()
})

it('rejects wrong-root and duplicate markers read from durable storage', async () => {
  const { ctx } = await mount()
  const root = await ctx.agents.retain({ ...options, sessionId: SessionId('root') })
  const child = await ctx.agents.retain({ ...options, root })
  await child.dispose()
  await expect(ctx.agents.retain({ ...options, mode: 'resume' })).rejects.toThrow('ownership')
  const childAgain = await ctx.agents.retain({ ...options, mode: 'resume', root })
  childAgain.session.append('agent/runtime-owner', { rootSessionId: root.session.id })
  await childAgain.dispose()
  await expect(ctx.agents.retain({ ...options, mode: 'resume', root })).rejects.toThrow('ownership')
  await root.dispose()
})

it('drains child adoption on cancellation before closing its retained writer', async () => {
  const { ctx } = await mount()
  const root = await ctx.agents.retain({ ...options, sessionId: SessionId('root') })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const abort = new AbortController()
  const child = await ctx.agents.retain({ ...options, root, signal: abort.signal, setup: async () => {
    entered.resolve(undefined)
    await release.promise
  } })
  const adopting = child.adopt()
  const rejected = expect(adopting).rejects.toThrow()
  await entered.promise
  abort.abort(new Error('cancel adoption'))
  release.resolve(undefined)
  await rejected
  await root.dispose()
  expect(ctx.agents.list()).toHaveLength(0)
  expect(ctx.sessions.list()).toHaveLength(0)
  await expect(child.adopt()).rejects.toThrow()
  const writer = await ctx.sessionPersistence.open(id, 'write')
  await writer.close()
})

it('propagates writer cleanup failures and refuses durability failure during adoption', async () => {
  const { ctx } = await mount()
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    const writer = await create(...args)
    const close = writer.close.bind(writer)
    vi.spyOn(writer, 'close').mockImplementation(async () => { await close(); throw new Error('close outcome unknown') })
    return writer
  })
  const retained = await ctx.agents.retain(options)
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockResolvedValue({ kind: 'refused', reason: 'flush-failed', cause: new Error('injected flush failure') })
  await expect(retained.adopt()).rejects.toThrow('durability')
  await expect(retained.dispose()).rejects.toThrow('cleanup failed')
  expect(ctx.sessions.list()).toHaveLength(0)
})

it('repairs an interrupted retained turn before parked recovery', async () => {
  const { ctx } = await mount()
  const retained = await ctx.agents.retain(options)
  retained.session.append('turn/start', { turn: 1 })
  retained.session.append('step/start', { turn: 1, step: 1 })
  await retained.dispose()
  const recovered = await ctx.agents.retain({ ...options, mode: 'resume' })
  const handle = await recovered.adopt()
  expect((await read(ctx)).some(event => event.type === 'turn/end')).toBe(true)
  expect(handle.agent.inbox.nextTurn).toHaveLength(0)
  await recovered.dispose()
})

it('reports failed acquisition cleanup and failed adopted scope cleanup', async () => {
  const { ctx } = await mount()
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    const writer = await create(...args)
    const close = writer.close.bind(writer)
    vi.spyOn(writer, 'close').mockImplementation(async () => { await close(); throw new Error('cleanup unknown') })
    return writer
  })
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockResolvedValue({ kind: 'refused', reason: 'coverage' })
  await expect(ctx.agents.retain(options)).rejects.toThrow('acquisition and cleanup failed')
  vi.restoreAllMocks()
  const root = await ctx.agents.retain({ ...options, sessionId: SessionId('root') })
  const child = await ctx.agents.retain({ ...options, sessionId: SessionId('child'), root,
    setup: (ctx) => { ctx.effect(() => () => { throw new Error('scope cleanup unknown') }) },
  })
  await child.adopt()
  await expect(root.dispose()).rejects.toThrow('cleanup failed')
  expect(ctx.sessions.list()).toHaveLength(0)
})

it('preserves retained ownership when initialization or its cleanup fails', async () => {
  const { ctx } = await mount()
  const invalid = await ctx.agents.retain({ ...options, agentOptions: { maxTokens: -1 } })
  await expect(invalid.adopt()).rejects.toThrow('positive safe integer')
  await invalid.dispose()
  const broken = await ctx.agents.retain({ ...options, sessionId: SessionId('broken'), setup: (ctx) => {
    ctx.effect(() => () => { throw new Error('scope cleanup unknown') })
    throw new Error('setup rejected')
  } })
  await expect(broken.adopt()).rejects.toThrow('initialization and cleanup failed')
  expect(ctx.sessions.get(SessionId('broken'))).toBe(broken.session)
  await broken.dispose()
})

it('rejects test activation for stock drivers and in a production runtime', async () => {
  const { ReactLoopAgent } = await import('../src/agent.ts')
  const { ctx } = await mount()
  const retained = await ctx.agents.retain(options)
  const handle = await retained.adopt()
  if (!(handle.agent instanceof ReactLoopAgent)) throw new Error('expected production loop')
  vi.stubEnv('NODE_ENV', 'production')
  try { await expect(handle.agent.testOnlyTurn(message())).rejects.toThrow('unavailable') }
  finally { vi.unstubAllEnvs() }
  await retained.dispose()
})
