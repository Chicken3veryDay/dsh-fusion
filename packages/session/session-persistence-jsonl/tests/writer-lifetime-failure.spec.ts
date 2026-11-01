/** Provider failure transitions with memory storage and fake leases; no kernel lock exists in this suite. */
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

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  // Only the declaring service identity is used; this provider never creates an artifact here.
  await ctx.plugin(Jsonl, { root: '/unused-memory-writer-fixture', compression: 'none' })
  const tracker = new JsonlBackendTracker('memory-fixture')
  tracker.install(ctx)
  const session = ctx.sessions.prepare()
  let events: SessionEvent[] = []
  const lease = await SessionWriteLease.acquire('/unused-memory-lease', session.id)
  const storage: JsonlHandleStorage = {
    persistBatch: vi.fn(async (_header: SessionHeader, batch: readonly SessionEvent[]) => { events.push(...batch) }),
    persistHeader: vi.fn(async () => {}), truncateTornTail: vi.fn(async () => {}),
    resolveCurrentLog: vi.fn(async () => 'memory'),
    readStoredLog: vi.fn(async () => ({ eventState: 'detached' as const, events })),
    hasPendingSession: () => true, acquireWriteLease: async () => lease,
    releaseHandle: (handle, materialized) => { tracker.release(handle, materialized) },
  }
  const state = { cursor: 0, materialized: false, inheritedEventCount: SessionLogOffset(0) }
  tracker.registerCreated(session.header, SessionLogOffset(0))
  const writer = tracker.adopt(new JsonlSessionHandle(storage, session.id, session.header, 'write', state))
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  // These handles have no OS lease or file resource. Keep unknown pins intact while removing only
  // the fake teardown's wait; real unknown-lock tests own a child process until kernel release on exit.
  disposals.push(async () => { tracker.openHandles.clear(); detach(); await ctx.fiber.dispose() })
  const reserve = () => {
    const result = tracker.reserveSessionWriter(ctx, session, ctx.sessionPersistence.identity)
    if (result.kind !== 'reserved') throw new Error(`reservation refused: ${result.reason}`)
    return result.reservation
  }
  return { ctx, tracker, session, writer, storage, state, lease, reserve, setEvents: (value: SessionEvent[]) => { events = value } }
}

for (const fault of ['missing-artifact', 'prefix', 'header', 'inherited', 'lease', 'sticky'] as const) {
  it(`retains writer ownership after ${fault} verification failure`, async () => {
    const f = await fixture(), pin = f.reserve()
    const other = f.reserve()
    if (fault === 'missing-artifact') vi.spyOn(f.storage, 'resolveCurrentLog').mockResolvedValue(undefined)
    if (fault === 'prefix') vi.spyOn(f.session, 'matchesDurabilityPrefix').mockResolvedValue(false)
    const headerSpy = fault === 'header' ? vi.spyOn(f.session, 'header', 'get').mockReturnValue({ ...f.session.header, createdAt: 1 }) : undefined
    if (fault === 'inherited') f.state.inheritedEventCount = SessionLogOffset(1)
    if (fault === 'lease') vi.spyOn(f.lease, 'assertOwned').mockRejectedValue(new Error('ownership lost'))
    if (fault === 'sticky') vi.spyOn(f.storage, 'readStoredLog').mockImplementation(async () => {
      f.writer.retainFailure(new Error('concurrent failure'))
      return { eventState: 'detached', events: [] }
    })
    expect(await pin.flushDurably()).toMatchObject({ kind: 'refused', reason: 'uncertain' })
    headerSpy?.mockRestore()
    expect(pin.checkDispatch()).toMatchObject({ kind: 'refused', reason: 'uncertain' })
    expect(other.signal.aborted).toBe(true)
    expect(f.tracker.reserveSessionWriter(f.ctx, f.session, f.ctx.sessionPersistence.identity)).toMatchObject({ reason: 'uncertain' })
    expect(await pin.flushDurably()).toMatchObject({ kind: 'refused', reason: 'uncertain' })
    const release = pin.release()
    expect(pin.release()).toBe(release)
    expect(await release).toMatchObject({ kind: 'refused', reason: 'uncertain' })
    expect(await pin.flushDurably()).toMatchObject({ kind: 'refused', reason: 'uncertain' })
    expect(f.writer.hasReservations).toBe(true)
  })
}

it('refuses stale provider identity before registering a route or pin', async () => {
  const f = await fixture()
  expect(f.tracker.reserveSessionWriter(f.ctx, f.session, Symbol('foreign'))).toMatchObject({ reason: 'fenced' })
  expect(f.writer.hasReservations).toBe(false)
})

for (const fault of ['registration', 'cleanup', 'reentry'] as const) {
  it(`rolls back listener ${fault} before returning setup failure`, async () => {
    const f = await fixture()
    const on = f.ctx.root.on.bind(f.ctx.root)
    let calls = 0
    vi.spyOn(f.ctx.root, 'on').mockImplementation((...args) => {
      calls++
      if (calls === 2) {
        if (fault === 'reentry') { f.writer.close().catch(() => {}); return on(...args) }
        throw new Error('registration failed')
      }
      const remove = on(...args)
      return fault === 'cleanup' ? () => { remove(); throw new Error('cleanup failed') } : remove
    })
    if (fault === 'reentry') expect(f.tracker.reserveSessionWriter(f.ctx, f.session, f.ctx.sessionPersistence.identity)).toMatchObject({ reason: 'fenced' })
    else expect(() => f.reserve()).toThrow(fault === 'cleanup' ? 'reservation setup and rollback failed' : 'registration failed')
    expect(f.writer.hasReservations).toBe(false)
    if (fault === 'cleanup') await expect(f.writer.close()).rejects.toThrow('cleanup failed')
    else await f.writer.close()
  })
}

it('preserves an earlier pin when later setup fails', async () => {
  const f = await fixture(), first = f.reserve()
  const on = f.ctx.root.on.bind(f.ctx.root)
  vi.spyOn(f.ctx.root, 'on').mockImplementationOnce(() => { throw new Error('later setup failed') })
  expect(() => f.reserve()).toThrow('later setup failed')
  expect(f.writer.hasReservations).toBe(true)
  vi.spyOn(f.ctx.root, 'on').mockImplementation(on)
  expect(await first.release()).toMatchObject({ kind: 'durable' })
  await f.writer.close()
})

it('retains listener-removal failure rather than resolving close', async () => {
  const f = await fixture()
  const on = f.ctx.root.on.bind(f.ctx.root)
  vi.spyOn(f.ctx.root, 'on').mockImplementation((...args) => {
    const remove = on(...args)
    return () => { remove(); throw new Error('listener removal failed') }
  })
  const pin = f.reserve()
  await expect(pin.release()).rejects.toThrow('reservation listener cleanup failed')
  expect(f.writer.hasReservations).toBe(true)
  expect(pin.checkDispatch()).toMatchObject({ reason: 'uncertain' })
})

for (const fault of ['drain', 'lease-release', 'prior-failure'] as const) {
  it(`keeps a retained close ${fault} failure sticky after pins finish`, async () => {
    const f = await fixture()
    const done = Promise.withResolvers<undefined>()
    const remove = f.writer.retain({ fence: () => {}, done: done.promise })
    await f.writer.flushRetained(f.session, SessionLogOffset(0))
    const closed = f.writer.close()
    const observed = expect(closed).rejects.toThrow()
    if (fault === 'drain') vi.spyOn(f.writer, 'drainLive').mockRejectedValue(new Error('final drain failed'))
    if (fault === 'lease-release') vi.spyOn(f.lease, 'release').mockRejectedValue(new Error('lease release failed'))
    if (fault === 'prior-failure') f.writer.retainFailure(new Error('previous uncertainty'))
    remove(); done.resolve(undefined)
    await observed
    expect(f.writer.lifetimeUncertain).toBe(true)
    expect(f.writer.close()).toBe(closed)
    expect(f.tracker.openHandles.has(f.writer)).toBe(true)
  })
}

it('detects lost private routing before accepting same-writer durability', async () => {
  const f = await fixture(), pin = f.reserve()
  f.tracker['retainedRoutes'].delete(f.writer)
  expect(await pin.flushDurably()).toMatchObject({ kind: 'refused', reason: 'uncertain' })
  expect(f.writer.hasReservations).toBe(true)
  expect(pin.checkDispatch()).toMatchObject({ reason: 'uncertain' })
})

it('contains routed background storage failure and fences all registered operations', async () => {
  const f = await fixture(), pin = f.reserve()
  vi.spyOn(f.writer, 'enqueueLive').mockImplementation((_event, report) => { report(new Error('background failed')) })
  f.session.append('turn/start', { turn: 1 })
  expect(pin.signal.aborted).toBe(true)
  expect(pin.checkDispatch()).toMatchObject({ reason: 'uncertain' })
})

it('fences only the exact detached session and refuses dispatch through a withdrawn current binding', async () => {
  const f = await fixture(), pin = f.reserve()
  f.ctx.emit('session/disposed', f.ctx.sessions.prepare())
  expect(pin.signal.aborted).toBe(false)
  f.tracker['bindings'].delete(f.writer)
  expect(pin.checkDispatch()).toMatchObject({ reason: 'fenced' })
  expect(pin.signal.aborted).toBe(true)
})
