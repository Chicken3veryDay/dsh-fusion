/** A failed producer withdrawal must make provider-teardown ownership sticky. */
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

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(withdraw: () => Promise<void>) {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  await ctx.plugin(Jsonl, { root: '/unused-r2-memory-writer', compression: 'none' })
  const tracker = new JsonlBackendTracker('r2-memory')
  const uninstall = tracker.install(ctx)
  const session = ctx.sessions.prepare()
  const events: SessionEvent[] = []
  const lease = await SessionWriteLease.acquire('/unused-r2-memory-lease', session.id)
  const storage: JsonlHandleStorage = {
    persistBatch: async (_header: SessionHeader, batch: readonly SessionEvent[]) => { events.push(...batch) },
    persistHeader: async () => {}, truncateTornTail: async () => {},
    resolveCurrentLog: async () => 'memory',
    readStoredLog: async () => ({ eventState: 'detached', events }),
    hasPendingSession: () => true, acquireWriteLease: async () => lease,
    releaseHandle: (handle, materialized) => tracker.release(handle, materialized),
  }
  tracker.registerCreated(session.header, SessionLogOffset(0))
  const writer = tracker.adopt(new JsonlSessionHandle(storage, session.id, session.header, 'write', {
    cursor: 0, materialized: false, inheritedEventCount: SessionLogOffset(0),
  }))
  const detach = ctx.sessions.enter(session, { withdraw })
  ctx.sessions.announce(session)
  const result = tracker.reserveSessionWriter(ctx, session, ctx.sessionPersistence.identity)
  if (result.kind !== 'reserved') throw new Error(`reservation refused: ${result.reason}`)
  const pin = result.reservation
  cleanups.push(async () => {
    // Uncertain ownership is intentionally retained; there are no real leases or timers here.
    if (!writer.lifetimeUncertain && !writer.hasReservations) {
      await writer.close()
      await ctx.fiber.dispose()
    }
  })
  return { ctx, tracker, uninstall, session, writer, pin, detach }
}

it('refuses final pin release after provider teardown observes failed producer withdrawal', async () => {
  const f = await fixture(async () => { throw new Error('producer still has unknown completion') })
  await expect(f.detach()).rejects.toThrow('Session withdrawal failed')
  await expect(f.uninstall()).rejects.toThrow('r2-memory dispose failed')
  const result = await f.pin.release()
  const uncertain = f.writer.lifetimeUncertain
  const closeResult = result.kind === 'durable'
    ? await f.writer.close().then(() => 'closed', () => 'rejected')
    : 'retained'
  const claimed = f.tracker.openHandles.has(f.writer)
  // A provider-teardown error is not sufficient if the actual writer is still releasable.
  expect({ uncertain, claimed, result, closeResult }).toMatchObject({
    uncertain: true, claimed: true, result: { kind: 'refused', reason: 'uncertain' }, closeResult: 'retained',
  })
})

it('control: successful withdrawal and teardown release the same final pin and writer', async () => {
  const f = await fixture(async () => {})
  await f.detach()
  const teardown = f.uninstall()
  expect(await f.pin.release()).toMatchObject({ kind: 'durable' })
  await teardown
  expect(f.writer.lifetimeUncertain).toBe(false)
  expect(f.tracker.openHandles.has(f.writer)).toBe(false)
})
