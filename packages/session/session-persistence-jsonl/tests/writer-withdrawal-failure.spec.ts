/** Retained-writer cleanup and rollback when a Session's producer withdrawal or route disposal fails; memory storage and fake leases. */
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonlBackendTracker, JsonlSessionHandle } from '../src/storage.ts'
import type { JsonlHandleStorage } from '../src/storage.ts'
import { SessionWriteLease } from '../src/lease.ts'
import * as Jsonl from '../src/index.ts'

vi.mock('../src/lease.ts', () => ({ SessionWriteLease: class {
  static async acquire() { return new this() }
  async assertOwned() {}
  async release() {}
} }))

const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})

/** Make every effect registered on the root Context settle its disposal with `failure` after the real disposal ran. */
function failRouteDisposal(ctx: Context, failure: Error): void {
  const effect = ctx.root.effect.bind(ctx.root)
  vi.spyOn(ctx.root, 'effect').mockImplementation((execute, label) => {
    const dispose = effect(execute, label)
    return Object.assign(async () => { await dispose(); throw failure }, { then: dispose.then.bind(dispose) })
  })
}

/** A reserved-capable writer over a Session entered with a controllable producer withdrawal. */
async function fixture(withdraw: () => Promise<void> = async () => {}) {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  await ctx.plugin(Jsonl, { root: '/unused-memory-writer-fixture', compression: 'none' })
  const tracker = new JsonlBackendTracker('memory-fixture')
  const uninstall = tracker.install(ctx)
  const session = ctx.sessions.prepare()
  const events: SessionEvent[] = []
  const lease = await SessionWriteLease.acquire('/unused-memory-lease', session.id)
  const storage: JsonlHandleStorage = {
    persistBatch: vi.fn(async (_header: SessionHeader, batch: readonly SessionEvent[]) => { events.push(...batch) }),
    persistHeader: vi.fn(async () => {}), truncateTornTail: vi.fn(async () => {}),
    resolveCurrentLog: vi.fn(async () => 'memory'),
    readStoredLog: vi.fn(async () => ({ eventState: 'detached' as const, events })),
    hasPendingSession: () => true, acquireWriteLease: async () => lease,
    releaseHandle: (handle, materialized) => tracker.release(handle, materialized),
  }
  const state = { cursor: 0, materialized: false, inheritedEventCount: SessionLogOffset(0) }
  tracker.registerCreated(session.header, SessionLogOffset(0))
  const writer = tracker.adopt(new JsonlSessionHandle(storage, session.id, session.header, 'write', state))
  const withdrawSession = ctx.sessions.enter(session, { withdraw })
  ctx.sessions.announce(session)
  // Writers this suite leaves open model process-owned uncertain resources; Vitest owns the fork until exit.
  disposals.push(async () => {
    if (writer.lifetimeUncertain || writer.hasReservations) return
    await withdrawSession().catch((_error: unknown) => { /* a failed withdrawal is the fixture's own subject */ })
    await ctx.fiber.dispose().catch((_error: unknown) => { /* the same retained failure surfaces here */ })
  })
  const reserve = () => {
    const result = tracker.reserveSessionWriter(ctx, session, ctx.sessionPersistence.identity)
    if (result.kind !== 'reserved') throw new Error(`reservation refused: ${result.reason}`)
    return result.reservation
  }
  return { ctx, tracker, uninstall, session, writer, reserve, withdrawSession }
}

it('keeps a reserved writer open, uncertain and reported when its Session withdrawal fails during route disposal', async () => {
  const failure = new Error('producer stop failed')
  const f = await fixture(() => Promise.reject(failure))
  const pin = f.reserve()
  const closes = vi.spyOn(f.writer, 'close')
  const withdrawing = f.withdrawSession()
  void withdrawing.catch((_error: unknown) => { /* observed below through the route closer */ })
  const route = f.tracker['retainedRoutes'].get(f.writer)
  if (route === undefined) throw new Error('missing retained route')
  await expect(Promise.resolve(route.dispose())).rejects.toMatchObject({
    message: `session "${f.session.id}": retained writer kept open because Session withdrawal failed`,
    cause: { message: 'Session withdrawal failed', errors: [failure] },
  })
  expect(closes).not.toHaveBeenCalled()
  expect(f.writer.lifetimeUncertain).toBe(true)
  expect(pin.checkDispatch()).toMatchObject({ kind: 'refused', reason: 'uncertain' })
  expect(f.tracker.openHandles.has(f.writer)).toBe(true)
})

it('closes the retained writer after its Session withdrawal succeeds during route disposal', async () => {
  const f = await fixture()
  const pin = f.reserve()
  expect(await pin.release()).toMatchObject({ kind: 'durable' })
  const withdrawing = f.withdrawSession()
  const route = f.tracker['retainedRoutes'].get(f.writer)
  if (route === undefined) throw new Error('missing retained route')
  await route.dispose()
  await withdrawing
  expect(f.writer.durabilityOpen).toBe(false)
  expect(f.tracker.openHandles.has(f.writer)).toBe(false)
})

it('reports a write handle kept open because its Session withdrawal failed at provider teardown', async () => {
  const failure = new Error('producer stop failed')
  const f = await fixture(() => Promise.reject(failure))
  // Teardown keeps the Session binding only for a writer that still owns a retained route.
  f.reserve()
  const withdrawing = f.withdrawSession()
  void withdrawing.catch((_error: unknown) => { /* observed through the teardown report */ })
  await expect(f.uninstall()).rejects.toMatchObject({
    message: 'memory-fixture dispose failed',
    errors: [{
      message: `memory-fixture: session "${f.session.id}" write handle kept open because Session withdrawal failed`,
      cause: { message: 'Session withdrawal failed', errors: [failure] },
    }],
  })
  expect(f.writer.durabilityOpen).toBe(true)
  expect(f.tracker.openHandles.has(f.writer)).toBe(true)
})

it('joins a successful Session withdrawal before closing the handle at provider teardown', async () => {
  const f = await fixture()
  expect(await f.reserve().release()).toMatchObject({ kind: 'durable' })
  const withdrawing = f.withdrawSession()
  await f.uninstall()
  await withdrawing
  expect(f.writer.durabilityOpen).toBe(false)
  expect(f.tracker.openHandles.has(f.writer)).toBe(false)
})

it('records uncertainty and a warning when route disposal fails after a detached setup rollback', async () => {
  const f = await fixture()
  const on = f.ctx.root.on.bind(f.ctx.root)
  let calls = 0
  vi.spyOn(f.ctx.root, 'on').mockImplementation((...args) => {
    if (++calls === 2) throw new Error('registration failed')
    return on(...args)
  })
  // The listener detaches synchronously; the effect's own asynchronous disposal then fails.
  failRouteDisposal(f.ctx, new Error('route effect disposal failed'))
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  expect(() => f.reserve()).toThrow('registration failed')
  await vi.waitFor(() => { expect(f.writer.lifetimeUncertain).toBe(true) })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('retained route disposal failed after setup rollback'))
  expect(f.tracker['retainedRoutes'].has(f.writer)).toBe(false)
  expect(f.writer.hasReservations).toBe(false)
})

it('completes close when the route group disposal rejects after the exact listener removal succeeded', async () => {
  const f = await fixture()
  failRouteDisposal(f.ctx, new Error('route group disposal failed'))
  const pin = f.reserve()
  const closed = f.writer.close()
  expect(await pin.release()).toMatchObject({ kind: 'durable' })
  await expect(closed).resolves.toBeUndefined()
  expect(f.tracker.openHandles.has(f.writer)).toBe(false)
})
