/** Store-flush descendants must stop being reentrant once the flush has settled. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPlugin from '../src/index.ts'
import { JsonlSessionHandle } from '../src/storage.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r2-flush-scope-'))
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPlugin, { root, compression: 'none' })
  const session = ctx.sessions.prepare(SessionId(id))
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  cleanups.push(async () => {
    await writer.close().catch(() => undefined)
    await writer['lease']?.release()
    detach()
  })
  return { ctx, session, writer }
}

const outcome = (promise: Promise<void>): Promise<string> => promise.then(
  () => 'closed', (error: unknown) => error instanceof Error ? error.message : String(error),
)

it.each(['promise', 'immediate'] as const)('joins a completed flush from a %s descendant instead of refusing a noncyclic close', async (schedule) => {
  const { ctx, session, writer } = await fixture('descendant-close')
  const startCleanup = Promise.withResolvers<undefined>()
  let cleanup: Promise<string> | undefined
  const storage = writer['storage']
  const persistHeader = storage.persistHeader.bind(storage)
  vi.spyOn(storage, 'persistHeader').mockImplementation(async (...args) => {
    // This task is launched inside the physical flush but is not awaited by it.
    cleanup = (async () => {
      if (schedule === 'immediate') await nextImmediate()
      await startCleanup.promise
      return outcome(writer.close())
    })()
    return persistHeader(...args)
  })
  cleanups.push(async () => { startCleanup.resolve(undefined); await cleanup })
  await ctx.sessions.flush(session)
  // There is no in-flight flush left for close to await, hence no possible self-join.
  startCleanup.resolve(undefined)
  const descendantResult = await cleanup
  const externalResult = await outcome(writer.close())
  expect({ descendantResult, externalResult }).toEqual({ descendantResult: 'closed', externalResult: 'closed' })
})

it('preserves the real close failure for an async descendant after the flush settled', async () => {
  const { ctx, session, writer } = await fixture('descendant-failure')
  const startCleanup = Promise.withResolvers<undefined>()
  let cleanup: Promise<string> | undefined
  const storage = writer['storage']
  const persistHeader = storage.persistHeader.bind(storage)
  vi.spyOn(storage, 'persistHeader').mockImplementation(async (...args) => {
    cleanup = (async () => { await startCleanup.promise; return outcome(writer.close()) })()
    return persistHeader(...args)
  })
  cleanups.push(async () => { startCleanup.resolve(undefined); await cleanup })
  await ctx.sessions.flush(session)
  writer.retainFailure(new Error('actual ownership uncertainty'))
  // The fixture observes this deliberately retained failure during teardown too.
  cleanups.push(async () => { await writer.close().catch(() => undefined) })
  startCleanup.resolve(undefined)
  const descendantResult = await cleanup
  const externalResult = await outcome(writer.close())
  expect({ descendantResult, externalResult }).toEqual({
    descendantResult: 'actual ownership uncertainty', externalResult: 'actual ownership uncertainty',
  })
})

it('control: an outside continuation receives the normal close result after the same flush', async () => {
  const { ctx, session, writer } = await fixture('external-close-control')
  await ctx.sessions.flush(session)
  expect(await outcome(writer.close())).toBe('closed')
})

it('control: another Session can close while the first Session flush is active', async () => {
  const { ctx, session, writer } = await fixture('first-session')
  const other = await ctx.sessionPersistence.create(ctx.sessions.prepare(SessionId('other-session')).header)
  cleanups.push(() => other.close())
  const storage = writer['storage']
  const persistHeader = storage.persistHeader.bind(storage)
  vi.spyOn(storage, 'persistHeader').mockImplementation(async (...args) => {
    await other.close()
    return persistHeader(...args)
  })
  await expect(ctx.sessions.flush(session)).resolves.toBe(true)
})
