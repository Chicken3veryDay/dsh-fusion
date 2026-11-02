/** Real JSONL leases and driver publication for inert retained contexts. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'
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

function observe(promise: Promise<void>) {
  return promise.then(() => ({ kind: 'complete' as const }), (error: unknown) => ({ kind: 'failed' as const, error }))
}
function leaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(leaves) : [error]
}
it('enters every Session producer synchronously and memoizes the public terminal before reentry', async () => {
  const { ctx } = await mount()
  const retained = await ctx.agents.retain(options)
  const hold = Promise.withResolvers<undefined>()
  const failure = { owner: 'first producer' }
  const phases: string[] = []
  let reentered: Promise<void> | undefined
  ctx.sessions.registerWithdrawal(retained.session, () => {
    phases.push('first')
    reentered = retained.dispose()
    throw failure
  })
  ctx.sessions.registerWithdrawal(retained.session, () => { phases.push('last'); return hold.promise })
  const proof = await ctx.sessionPersistence.flushSessionDurably(retained.session)
  const join = retained.dispose()
  const result = observe(join)
  const synchronous = [...phases]
  hold.resolve(undefined)
  expect(synchronous).toEqual(['first', 'last'])
  expect(reentered).toBe(join)
  expect(retained.dispose()).toBe(join)
  expect(ctx.sessions.get(id)).toBe(retained.session)
  expect(() => ctx.sessions.registerWithdrawal(retained.session, () => Promise.resolve(undefined))).toThrow('cannot register')
  hold.resolve(undefined)
  const terminal = await result
  expect(terminal.kind).toBe('failed')
  if (terminal.kind !== 'failed') throw new Error('missing public failure')
  expect(leaves(terminal.error)).toEqual([failure])
  expect(await observe(retained.dispose())).toEqual(terminal)
  const repeated = await observe(retained.dispose())
  expect(repeated.kind === 'failed' && repeated.error).toBe(terminal.error)
  const next = await ctx.sessionPersistence.flushSessionDurably(retained.session)
  expect(next).toMatchObject({ kind: 'durable', ...proof.kind === 'durable' ? { writer: proof.writer } : {} })
  expect(ctx.sessions.get(id)).toBe(retained.session)
})
it('separates held same-Session adoption cancellation from cleanup before initialization', async () => {
  const { ctx, adapter } = await mount()
  const setup = vi.fn()
  const retained = await ctx.agents.retain({ ...options, setup })
  const proof = await ctx.sessionPersistence.flushSessionDurably(retained.session)
  const entered = Promise.withResolvers<undefined>(), hold = Promise.withResolvers<undefined>()
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  let receipt: Awaited<ReturnType<typeof flush>> | undefined
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementationOnce(async (session) => {
    expect(session).toBe(retained.session)
    entered.resolve(undefined)
    await hold.promise
    receipt = await flush(session)
    return receipt
  })
  const adoption = retained.adopt().then(() => ({ kind: 'complete' as const }), (error: unknown) => ({ kind: 'failed' as const, error }))
  await entered.promise
  const phases: string[] = []
  ctx.sessions.registerWithdrawal(retained.session, () => { phases.push('fenced'); return Promise.resolve(undefined) })
  const disposing = retained.dispose(), result = observe(disposing)
  const synchronous = [...phases]
  hold.resolve(undefined)
  expect(synchronous).toEqual(['fenced'])
  expect(ctx.sessions.get(id)).toBe(retained.session)
  expect(setup).not.toHaveBeenCalled()
  hold.resolve(undefined)
  const operation = await adoption, terminal = await result
  expect(receipt).toMatchObject({ kind: 'durable', session: retained.session,
    ...proof.kind === 'durable' ? { writer: proof.writer } : {} })
  expect(operation.kind).toBe('failed')
  expect(terminal.kind).toBe('failed')
  if (operation.kind !== 'failed' || terminal.kind !== 'failed') throw new Error('missing original cancellation')
  expect(leaves(terminal.error)).toEqual([operation.error])
  expect(ctx.sessions.get(id)).toBeUndefined()
  expect(ctx.agents.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
  const repeated = await observe(retained.dispose())
  expect(repeated.kind === 'failed' && repeated.error).toBe(terminal.error)
})
it.each([undefined, { source: 'scope cleanup' }])('retains exact parent and child writers for unknown cleanup %j', async (failure) => {
  const { ctx } = await mount()
  const root = await ctx.agents.retain(options)
  let cleanups = 0
  const child = await ctx.agents.retain({ ...options, sessionId: SessionId('child'), root,
    setup(owner) { owner.effect(() => () => { cleanups++; throw failure }) },
  })
  await child.adopt()
  const proofs = await Promise.all([root, child].map(lease => ctx.sessionPersistence.flushSessionDurably(lease.session)))
  const fenced = vi.fn()
  ctx.sessions.registerWithdrawal(child.session, () => { fenced(); return Promise.resolve(undefined) })
  const disposing = root.dispose()
  expect(fenced).toHaveBeenCalledTimes(1)
  const terminal = await observe(disposing)
  expect(terminal.kind).toBe('failed')
  if (terminal.kind !== 'failed') throw new Error('missing cleanup failure')
  expect(leaves(terminal.error)).toContain(failure)
  for (const [index, lease] of [root, child].entries()) {
    expect(ctx.sessions.get(lease.session.id)).toBe(lease.session)
    const proof = proofs[index]
    expect(await ctx.sessionPersistence.flushSessionDurably(lease.session)).toMatchObject({ kind: 'durable',
      ...proof?.kind === 'durable' ? { writer: proof.writer } : {} })
    await expect(lease.adopt()).rejects.toThrow('disposed')
  }
  const repeated = await observe(root.dispose())
  expect(repeated.kind === 'failed' && repeated.error).toBe(terminal.error)
  expect(cleanups).toBe(1)
})
it.each([false, true])('accounts for initializer rollback before release with cleanup failure %s', async (fails) => {
  const { ctx } = await mount()
  const primary = { source: 'setup', cause: undefined }, cleanup = { source: 'rollback' }
  let cleanups = 0
  const retained = await ctx.agents.retain({ ...options, setup(owner) {
    owner.effect(() => () => { cleanups++; if (fails) throw cleanup })
    throw primary
  } })
  const operation = await retained.adopt().catch((error: unknown) => error)
  expect(leaves(operation)).toContain(primary)
  expect(Object.hasOwn(primary, 'cause')).toBe(true)
  const terminal = await observe(retained.dispose())
  expect(cleanups).toBe(1)
  if (fails) {
    expect(terminal.kind).toBe('failed')
    if (terminal.kind !== 'failed') throw new Error('missing rollback failure')
    expect(leaves(terminal.error)).toContain(cleanup)
    expect(ctx.sessions.get(id)).toBe(retained.session)
  } else {
    expect(terminal.kind).toBe('complete')
    expect(ctx.sessions.get(id)).toBeUndefined()
  }
})

it('keeps an entered setup alive until its real terminal before accounting for rollback', async () => {
  const { ctx } = await mount()
  const entered = Promise.withResolvers<undefined>(), hold = Promise.withResolvers<undefined>()
  const phases: string[] = []
  const retained = await ctx.agents.retain({ ...options, async setup(owner) {
    entered.resolve(undefined)
    await hold.promise
    owner.effect(() => () => { phases.push('cleanup') })
    phases.push('setup-terminal')
  } })
  const adoption = retained.adopt().catch((error: unknown) => error)
  await entered.promise
  const disposing = retained.dispose(), result = observe(disposing)
  expect(ctx.sessions.get(id)).toBe(retained.session)
  expect(phases).toEqual([])
  hold.resolve(undefined)
  const operation = await adoption, terminal = await result
  expect(phases).toEqual(['setup-terminal', 'cleanup'])
  expect(terminal.kind).toBe('failed')
  if (terminal.kind !== 'failed') throw new Error('missing original cancellation')
  expect(leaves(terminal.error)).toEqual([operation])
  expect(ctx.sessions.get(id)).toBeUndefined()
})

it('preserves producer failure order and raw undefined without skipping the final fence', async () => {
  const { ctx } = await mount()
  const retained = await ctx.agents.retain(options)
  const cause = { source: 'producer rejection', cause: undefined }
  const phases: string[] = []
  ctx.sessions.registerWithdrawal(retained.session, () => { phases.push('throw'); throw undefined })
  ctx.sessions.registerWithdrawal(retained.session, () => {
    phases.push('reject')
    const rejection = Promise.withResolvers<undefined>()
    rejection.reject(cause)
    return rejection.promise
  })
  ctx.sessions.registerWithdrawal(retained.session, () => { phases.push('last'); return Promise.resolve(undefined) })
  const result = observe(retained.dispose())
  expect(phases).toEqual(['throw', 'reject', 'last'])
  const terminal = await result
  if (terminal.kind !== 'failed') throw new Error('missing ordered producer failures')
  expect(leaves(terminal.error)).toEqual([undefined, cause])
  expect(leaves(terminal.error)[1]).toBe(cause)
  expect(Object.hasOwn(cause, 'cause')).toBe(true)
  expect(ctx.sessions.get(id)).toBe(retained.session)
})

it('keeps the original pending adoption failure while child cleanup delays its producer join', async () => {
  const { ctx } = await mount()
  const root = await ctx.agents.retain(options)
  const entered = Promise.withResolvers<undefined>(), finishChild = Promise.withResolvers<undefined>()
  const child = await ctx.agents.retain({ ...options, sessionId: SessionId('child'), root, setup(owner) {
    owner.effect(() => async () => { entered.resolve(undefined); await finishChild.promise })
  } })
  await child.adopt()
  const flushing = Promise.withResolvers<undefined>(), finishFlush = Promise.withResolvers<undefined>()
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementationOnce(async (session) => {
    flushing.resolve(undefined)
    await finishFlush.promise
    return flush(session)
  })
  const adoption = root.adopt().catch((error: unknown) => error)
  await flushing.promise
  const disposing = observe(root.dispose())
  await entered.promise
  finishFlush.resolve(undefined)
  const operation = await adoption
  const members = ctx.sessions.list()
  finishChild.resolve(undefined)
  const terminal = await disposing
  expect(members).toContain(root.session)
  expect(members).toContain(child.session)
  if (terminal.kind !== 'failed') throw new Error('missing original adoption cancellation')
  expect(leaves(terminal.error)).toEqual([operation])
  expect(ctx.sessions.list()).toHaveLength(0)
})
