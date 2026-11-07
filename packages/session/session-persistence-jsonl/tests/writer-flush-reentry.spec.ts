/** A close issued from inside the store-flush callback's own call stack is refused; every other caller joins one close. */
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

async function mount(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-flush-reentry-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPlugin, { root, compression: 'none' })
  const session = ctx.sessions.prepare(SessionId(id))
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  cleanups.push(async () => {
    await writer.close().catch((_error: unknown) => { /* a refused close is asserted by the test itself */ })
    detach()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, session, writer }
}

/** Replace the handle flush with one that closes the same handle from inside the flush call stack. */
function reenterFromFlush(writer: JsonlSessionHandle): void {
  vi.spyOn(writer, 'flush').mockImplementation(async () => { await writer.close() })
}

it('refuses only the reentrant caller and closes the writer once the flush unwinds', async () => {
  const { ctx, session, writer } = await mount('flush-reentry')
  reenterFromFlush(writer)
  const refusal = ctx.sessions.flush(session)
  await expect(refusal).rejects.toThrow(JsonlPlugin.JsonlSessionCloseReentryError)
  await expect(refusal).rejects.toMatchObject({ name: 'JsonlSessionCloseReentryError', sessionId: session.id })
  // Every later caller joins the one real close, which resolves.
  await expect(writer.close()).resolves.toBeUndefined()
  expect(writer.durabilityOpen).toBe(false)
})

it('fences a reserved writer synchronously for a reentrant close and still joins it after release', async () => {
  const { ctx, session, writer } = await mount('flush-reentry-reserved')
  const reserved = ctx.sessionPersistence.reserveSessionWriter(session)
  if (reserved.kind !== 'reserved') throw new Error(`reservation refused: ${reserved.reason}`)
  reenterFromFlush(writer)
  await expect(ctx.sessions.flush(session)).rejects.toThrow(JsonlPlugin.JsonlSessionCloseReentryError)
  expect(reserved.reservation.signal.aborted).toBe(true)
  const joined = writer.close()
  expect(await reserved.reservation.release()).toMatchObject({ kind: 'durable' })
  await expect(joined).resolves.toBeUndefined()
  expect(writer.durabilityOpen).toBe(false)
})

it('surfaces a recorded failure to every caller outside the callback while refusing the reentrant one', async () => {
  const { ctx, session, writer } = await mount('flush-reentry-failure')
  const failure = new Error('recorded storage uncertainty')
  writer.retainFailure(failure)
  reenterFromFlush(writer)
  await expect(ctx.sessions.flush(session)).rejects.toThrow(JsonlPlugin.JsonlSessionCloseReentryError)
  await expect(writer.close()).rejects.toBe(failure)
})
