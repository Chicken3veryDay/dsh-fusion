/** Review r1 probe: ordinary (never reserved) writer close while a store flush is in flight. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPlugin from '../src/index.ts'
import { JsonlSessionHandle } from '../src/storage.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A routed, never-reserved writer whose first materializing header write is held. */
async function ordinaryWriter(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r1-close-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPlugin, { root, compression: 'none' })
  const session = ctx.sessions.prepare(SessionId(id))
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  // Stand-in for a slow fsync: hold the real header materialization.
  const storage = writer['storage']
  const original = storage.persistHeader.bind(storage)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  vi.spyOn(storage, 'persistHeader').mockImplementation(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return original(...args)
  })
  cleanups.push(async () => {
    release.resolve(undefined)
    await writer.close().catch(() => undefined)
    detach()
    await ctx.fiber.dispose().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, session, writer, entered, release }
}

const settle = (promise: Promise<unknown>): Promise<string> =>
  promise.then(() => 'resolved', (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`)

it('closes an unreserved writer normally while sessions.flush(session) is in flight', async () => {
  const { ctx, session, writer, entered, release } = await ordinaryWriter('close-during-store-flush')
  const flushing = settle(ctx.sessions.flush(session))
  await entered.promise
  // Ordinary close contract: idempotent, waits for pending durability, releases ownership.
  const closed = settle(writer.close())
  release.resolve(undefined)
  expect(await flushing).toBe('resolved')
  expect(await closed).toBe('resolved')
  expect(await ctx.sessionPersistence.stat(session.id)).toBeDefined()
})

it('fences a reserved writer synchronously when close lands during an in-flight sessions.flush(session)', async () => {
  const { ctx, session, writer, entered, release } = await ordinaryWriter('reserved-close-during-store-flush')
  const reserved = ctx.sessionPersistence.reserveSessionWriter(session)
  if (reserved.kind !== 'reserved') throw new Error(`reservation refused: ${reserved.reason}`)
  const flushing = settle(ctx.sessions.flush(session))
  await entered.promise
  const closed = settle(writer.close())
  // README: "Close publishes its stable join and synchronously fences all reservations before waiting."
  const fencedAtClose = reserved.reservation.signal.aborted
  release.resolve(undefined)
  await flushing
  expect(await reserved.reservation.release()).toMatchObject({ kind: 'durable' })
  expect({ fencedAtClose, closed: await closed }).toEqual({ fencedAtClose: true, closed: 'resolved' })
})

it('control: the same close during a direct handle flush resolves', async () => {
  const { writer, entered, release } = await ordinaryWriter('close-during-handle-flush')
  const flushing = settle(writer.flush())
  await entered.promise
  const closed = settle(writer.close())
  release.resolve(undefined)
  expect(await flushing).toBe('resolved')
  expect(await closed).toBe('resolved')
})
