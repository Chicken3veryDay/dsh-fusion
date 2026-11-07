/** Reservation setup reentry by close, withdrawal, publication and a shared-route reservation. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
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

async function fixture(id: string, optIn: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'review-r4-setup-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  const session = ctx.sessions.prepare(SessionId(id))
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
  const detach: () => void | Promise<void> = optIn
    ? ctx.sessions.enter(session, { withdraw: () => Promise.resolve() })
    : ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  cleanups.push(async () => {
    await writer.close().catch((_error: unknown) => { /* asserted by each case */ })
    await Promise.resolve(detach()).catch((_error: unknown) => { /* asserted by each case */ })
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, session, writer, detach }
}

/** Run `action` once, synchronously, when reservation setup registers `event` on the root. */
function onRegistration(ctx: Context, event: string, action: () => void): () => boolean {
  let fired = false
  const remove = ctx.on('internal/listener', (name) => {
    if (name !== event || fired) return
    fired = true
    action()
  })
  return () => { remove(); return fired }
}

async function storedCount(ctx: Context, session: Session): Promise<number> {
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  try { return (await reader.read()).events.length } finally { await reader.close() }
}

it.each(['session/event', 'session/disposed'])('rolls back once and closes when close reenters setup at %s', async (event) => {
  const { ctx, session, writer } = await fixture(`r4-close-${event.replace('/', '-')}`, false)
  session.append('turn/start', { turn: 1 })
  let closed: Promise<void> | undefined
  const fired = onRegistration(ctx, event, () => { closed = writer.close() })
  const outer = ctx.sessionPersistence.reserveSessionWriter(session)
  const observed = fired()
  const closeResult = await closed?.then(() => 'closed', (error: unknown) => String(error))
  // The claim must be free again and the earlier event persisted exactly once.
  const reopened = await ctx.sessionPersistence.open(session.id, 'write')
  const events = (await reopened.read()).events.length
  await reopened.close()
  expect({ observed, outer, closeResult, events }).toEqual({
    observed: true, outer: { kind: 'refused', reason: 'fenced' }, closeResult: 'closed', events: 1,
  })
})

it('routes an event published by a registration observer exactly once', async () => {
  const { ctx, session } = await fixture('r4-publish-during-setup', false)
  const fired = onRegistration(ctx, 'session/event', () => { session.append('turn/start', { turn: 1 }) })
  const outer = ctx.sessionPersistence.reserveSessionWriter(session)
  const observed = fired()
  if (outer.kind !== 'reserved') throw new Error(`reservation refused: ${outer.reason}`)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const flushed = await ctx.sessionPersistence.flushSessionDurably(session)
  const released = await outer.reservation.release()
  expect({ observed, flushed: flushed.kind, released: released.kind, stored: await storedCount(ctx, session) })
    .toEqual({ observed: true, flushed: 'durable', released: 'durable', stored: 2 })
})

it.each(['session/event', 'internal/plugin'])('refuses setup and leaves withdrawal completing when it begins at %s', async (event) => {
  const { ctx, session, writer, detach } = await fixture(`r4-withdraw-${event.replace('/', '-')}`, true)
  let withdrawal: Promise<void> | undefined
  const fired = onRegistration(ctx, event, () => { withdrawal = Promise.resolve(detach()) })
  const outer = ctx.sessionPersistence.reserveSessionWriter(session)
  const observed = fired()
  const withdrawn = await withdrawal?.then(() => 'withdrawn', (error: unknown) => String(error))
  const closed = await writer.close().then(() => 'closed', (error: unknown) => String(error))
  expect({ observed, outer, withdrawn, closed, live: ctx.sessions.get(session.id) === session }).toEqual({
    observed: true, outer: { kind: 'refused', reason: 'fenced' }, withdrawn: 'withdrawn', closed: 'closed', live: false,
  })
})

it('refuses a nested reservation while a second reservation joins the existing route', async () => {
  const { ctx, session } = await fixture('r4-shared-route', false)
  const first = ctx.sessionPersistence.reserveSessionWriter(session)
  if (first.kind !== 'reserved') throw new Error(`first refused: ${first.reason}`)
  let nested: WriterLifetimeReservation | undefined
  const fired = onRegistration(ctx, 'internal/plugin', () => { nested = ctx.sessionPersistence.reserveSessionWriter(session) })
  const second = ctx.sessionPersistence.reserveSessionWriter(session)
  const observed = fired()
  session.append('turn/start', { turn: 1 })
  const firstRelease = await first.reservation.release()
  const secondRelease = second.kind === 'reserved' ? (await second.reservation.release()).kind : second.reason
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const flushed = await ctx.sessionPersistence.flushSessionDurably(session)
  expect({
    observed, nested: nested?.kind === 'refused' ? nested.reason : nested?.kind,
    firstRelease: firstRelease.kind, secondRelease, flushed: flushed.kind, stored: await storedCount(ctx, session),
  }).toEqual({
    observed: true, nested: 'fenced', firstRelease: 'durable', secondRelease: 'durable', flushed: 'durable', stored: 2,
  })
})
