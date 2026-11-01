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
    releaseHandle: (handle, materialized) => tracker.release(handle, materialized),
  }
  const state = { cursor: 0, materialized: false, inheritedEventCount: SessionLogOffset(0) }
  tracker.registerCreated(session.header, SessionLogOffset(0))
  const writer = tracker.adopt(new JsonlSessionHandle(storage, session.id, session.header, 'write', state))
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  disposals.push(async () => {
    if (writer.hasReservations || writer.lifetimeUncertain) {
      // Vitest owns this fork until exit; fake uncertain resources are never reported cleaned.
      expect(tracker.openHandles.has(writer)).toBe(true)
      expect(writer.lifetimeUncertain || writer.hasReservations).toBe(true)
      return
    }
    detach()
    await ctx.fiber.dispose()
  })
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
    if (fault === 'cleanup') await expect(f.writer.close()).rejects.toMatchObject({
      message: 'reservation rollback failed', errors: [expect.objectContaining({ message: 'cleanup failed' })],
    })
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

for (const timing of ['before', 'after'] as const) {
  it(`rejects exact direct close when the actual event remover throws ${timing} removal`, async () => {
    const f = await fixture(), pin = f.reserve()
    const events = f.ctx.events
    const unregister = events['unregister']
    const hooks = events['_hooks']['session/event'] ?? []
    const callback = hooks[hooks.length - 1]!.callback
    const failure = new Error(`actual remover ${timing}`)
    let calls = 0
    Object.defineProperty(events, 'unregister', { configurable: true,
      value: (...args: Parameters<typeof unregister>) => {
        if (args[0] !== 'session/event' || args[1] !== callback) return unregister.apply(events, args)
        calls++
        if (timing === 'after') unregister.apply(events, args)
        throw failure
      },
    })
    try {
      const closed = f.writer.close()
      const rejection = expect(closed).rejects.toBe(failure)
      expect(await pin.release()).toMatchObject({ kind: 'durable' })
      await rejection
      expect(f.writer.close()).toBe(closed)
      await expect(f.writer.close()).rejects.toBe(failure)
      expect(calls).toBe(1)
      expect(f.writer.lifetimeUncertain).toBe(true)
      expect(f.writer.hasReservations).toBe(false)
      expect(f.tracker.openHandles.has(f.writer)).toBe(true)
      expect(f.tracker['writers'].get(f.writer.id)).toBe(f.writer)
      expect(f.tracker['bindings'].get(f.writer)).toBe(f.session)
      expect(f.tracker['retainedRoutes'].has(f.writer)).toBe(true)
      expect((events['_hooks']['session/event'] ?? []).some(hook => hook.callback === callback)).toBe(timing === 'before')
      expect(() => { f.tracker.claimWrite(f.writer.id) }).toThrow()
      expect(f.tracker.reserveSessionWriter(f.ctx, f.session, f.ctx.sessionPersistence.identity)).toMatchObject({ reason: 'uncertain' })
      await expect(f.ctx.fiber.dispose()).resolves.toBeUndefined()
      expect(calls).toBe(1)
    } finally {
      Object.defineProperty(events, 'unregister', { configurable: true, value: unregister })
    }
  })
}

it('joins an already-started actual remover without awaiting the enclosing close group', async () => {
  const f = await fixture(), pin = f.reserve()
  const events = f.ctx.events
  const unregister = events['unregister']
  const hooks = events['_hooks']['session/event'] ?? []
  const callback = hooks[hooks.length - 1]!.callback
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  let calls = 0, settled = false
  Object.defineProperty(events, 'unregister', { configurable: true,
    value: (...args: Parameters<typeof unregister>) => {
      if (args[0] !== 'session/event' || args[1] !== callback) return unregister.apply(events, args)
      calls++
      entered.resolve(undefined)
      return resume.promise.then(() => unregister.apply(events, args))
    },
  })
  try {
    const route = f.tracker['retainedRoutes'].get(f.writer)!
    const closed = f.writer.close()
    void closed.then(() => { settled = true })
    expect(await pin.release()).toMatchObject({ kind: 'durable' })
    await entered.promise
    const other = route.remove()
    expect(route.remove()).toBe(other)
    expect(f.writer.close()).toBe(closed)
    expect(settled).toBe(false)
    expect(f.tracker.openHandles.has(f.writer)).toBe(true)
    expect((events['_hooks']['session/event'] ?? []).some(hook => hook.callback === callback)).toBe(true)
    resume.resolve(undefined)
    await other
    await closed
    expect(calls).toBe(1)
    expect(f.tracker.openHandles.size).toBe(0)
    expect(f.tracker['retainedRoutes'].size).toBe(0)
    expect((events['_hooks']['session/event'] ?? []).some(hook => hook.callback === callback)).toBe(false)
    await f.ctx.fiber.dispose()
  } finally {
    resume.resolve(undefined)
    Object.defineProperty(events, 'unregister', { configurable: true, value: unregister })
  }
})

it('releases ordinary handle bookkeeping synchronously', async () => {
  const f = await fixture()
  expect(f.tracker.release(f.writer, false)).toBeUndefined()
  expect(f.tracker.openHandles.size).toBe(0)
  expect(f.tracker.hasPending(f.writer.id)).toBe(false)
  expect(f.tracker['writers'].has(f.writer.id)).toBe(false)
  await f.writer.close()
})

it('preserves the setup cause when actual route rollback also fails', async () => {
  const f = await fixture()
  const events = f.ctx.events, unregister = events['unregister']
  const setup = new Error('setup failed'), removal = new Error('route rollback failed')
  const on = f.ctx.root.on.bind(f.ctx.root)
  let registered = false
  vi.spyOn(f.ctx.root, 'on').mockImplementation((...args) => {
    if (registered) throw setup
    registered = true
    return on(...args)
  })
  Object.defineProperty(events, 'unregister', { configurable: true,
    value: (...args: Parameters<typeof unregister>) => {
      if (args[0] === 'session/event') throw removal
      return unregister.apply(events, args)
    },
  })
  try {
    expect(() => f.reserve()).toThrow(expect.objectContaining({
      errors: [setup, expect.objectContaining({ errors: [removal] })],
    }))
    expect(f.writer.hasReservations).toBe(false)
    expect(f.writer.lifetimeUncertain).toBe(true)
    expect(f.tracker.openHandles.has(f.writer)).toBe(true)
    await expect(f.writer.close()).rejects.toMatchObject({ errors: [removal] })
  } finally {
    Object.defineProperty(events, 'unregister', { configurable: true, value: unregister })
  }
})

it('observes grouped close rejection while preserving ordinary unpinned drain failure', async () => {
  const f = await fixture(), pin = f.reserve()
  expect(await pin.release()).toMatchObject({ kind: 'durable' })
  const failure = new Error('ordinary close drain failure')
  vi.spyOn(f.writer, 'drainLive').mockRejectedValue(failure)
  await expect(f.writer.close()).rejects.toBe(failure)
  await f.ctx.fiber.dispose()
  expect(f.writer.lifetimeUncertain).toBe(false)
  expect(f.tracker.openHandles.has(f.writer)).toBe(false)
  expect(f.tracker['writers'].has(f.writer.id)).toBe(false)
  expect(f.tracker['retainedRoutes'].has(f.writer)).toBe(false)
})

it('preserves setup and lifecycle-listener rollback causes without releasing another pin', async () => {
  const f = await fixture(), first = f.reserve()
  const setup = new Error('later setup failed'), cleanup = new Error('own lifecycle cleanup failed')
  const on = f.ctx.root.on.bind(f.ctx.root)
  let registrations = 0
  vi.spyOn(f.ctx.root, 'on').mockImplementation((...args) => {
    if (++registrations === 2) throw setup
    const remove = on(...args)
    return () => { remove(); throw cleanup }
  })
  expect(() => f.reserve()).toThrow(expect.objectContaining({
    errors: [setup, expect.objectContaining({ errors: [expect.objectContaining({ errors: [cleanup] })] })],
  }))
  expect(f.writer.hasReservations).toBe(true)
  expect(f.writer.lifetimeUncertain).toBe(true)
  expect(first.checkDispatch()).toMatchObject({ kind: 'refused', reason: 'uncertain' })
  expect(f.tracker['retainedRoutes'].has(f.writer)).toBe(true)
  expect(f.tracker.openHandles.has(f.writer)).toBe(true)
})
