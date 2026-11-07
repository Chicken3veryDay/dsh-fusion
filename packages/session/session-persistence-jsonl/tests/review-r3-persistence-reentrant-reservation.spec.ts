/** Reservation setup must publish one route before invoking registration observers. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { WriterLifetimeReservation } from '@deepseek-ai/dsh-session-persistence'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as Jsonl from '../src/index.ts'
import { JsonlSessionHandle } from '../src/storage.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'review-r3-reservation-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  const session = ctx.sessions.prepare(SessionId(id))
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  cleanups.push(async () => {
    // Failed proofs intentionally retain pins. Only test teardown abandons them,
    // after all real drains and release operations have settled.
    writer['pins'].clear()
    await writer.close().catch((_error: unknown) => { /* The tested failed proof retains uncertainty. */ })
    await writer['lease']?.release()
    detach()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, session, writer }
}

it.each([false, true])('keeps routing single when reservation reenters during registration (nested=%s)', async (reenter) => {
  const { ctx, session, writer } = await fixture(`reserve-reentry-${String(reenter)}`)
  let nested: WriterLifetimeReservation | undefined
  let observed = false
  const removeObserver = ctx.on('internal/listener', (name) => {
    if (name !== 'session/event' || observed) return
    observed = true
    if (reenter) nested = ctx.sessionPersistence.reserveSessionWriter(session)
  })
  const outer = ctx.sessionPersistence.reserveSessionWriter(session)
  removeObserver()
  if (outer.kind !== 'reserved') throw new Error(`outer reservation refused: ${outer.reason}`)
  if (nested?.kind === 'refused') expect(nested.reason).toBe('fenced')
  session.append('turn/start', { turn: 1 })
  const flushed = await ctx.sessionPersistence.flushSessionDurably(session)
  const outerRelease = await outer.reservation.release()
  const nestedRelease = nested?.kind === 'reserved' ? await nested.reservation.release() : undefined
  const read = await writer.read()
  expect({
    observed,
    flushed: flushed.kind,
    flushFailure: flushed.kind === 'refused' && flushed.reason === 'flush-failed'
      ? String(flushed.cause) : undefined,
    outerRelease: outerRelease.kind,
    nestedRelease: nestedRelease === undefined || nestedRelease.kind === 'durable',
    storedEvents: read.events.length,
  }).toEqual({
    observed: true,
    flushed: 'durable',
    flushFailure: undefined,
    outerRelease: 'durable',
    nestedRelease: true,
    storedEvents: 1,
  })
})
