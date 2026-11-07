/** Review r1 probe: reservation setup rollback whose new route removal fails. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
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

it('retains uncertainty (or keeps routing single) after a failed setup rollback of the new route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r1-rollback-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPlugin, { root, compression: 'none' })
  const session = ctx.sessions.prepare(SessionId('rollback-route'))
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
  ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  const events = ctx.events
  const unregister = events['unregister']
  cleanups.push(async () => {
    process.off('unhandledRejection', onUnhandled)
    Object.defineProperty(events, 'unregister', { configurable: true, value: unregister })
    await writer.close().catch(() => undefined)
    await ctx.fiber.dispose().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })
  // Setup fails after the new retained route listener was installed (first lifecycle
  // listener registration), and that route's listener removal fails during rollback.
  const on = ctx.root.on.bind(ctx.root)
  let registrations = 0
  const setup = new Error('lifecycle listener registration failed')
  const onSpy = vi.spyOn(ctx.root, 'on').mockImplementation((...args) => {
    if (++registrations === 2) throw setup
    return on(...args)
  })
  const removal = new Error('route listener removal failed')
  Object.defineProperty(events, 'unregister', { configurable: true,
    value: (...args: Parameters<typeof unregister>) => {
      if (args[0] === 'session/event') throw removal
      return unregister.apply(events, args)
    },
  })
  let thrown: unknown
  try { ctx.sessionPersistence.reserveSessionWriter(session) } catch (error: unknown) { thrown = error }
  onSpy.mockImplementation(on)
  // Rollback disposes the route effect asynchronously; keep the removal fault until it has run.
  await new Promise(resolve => setTimeout(resolve, 0))
  Object.defineProperty(events, 'unregister', { configurable: true, value: unregister })

  // README: "Failed rollback retains storage uncertainty."
  const observed = {
    thrownIncludesRemoval: thrown instanceof AggregateError, uncertain: writer.lifetimeUncertain, unhandled: unhandled.length,
  }

  // The routed log must still persist exactly once per event.
  session.append('turn/start', { turn: 1 })
  const flushed = await ctx.sessions.flush(session).then(() => 'flushed', (error: unknown) => String(error))
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  const stored: readonly SessionEvent[] = (await reader.read()).events
  await reader.close()
  expect({ ...observed, flushed, stored: stored.length }).toEqual({
    thrownIncludesRemoval: true, uncertain: true, unhandled: 0, flushed: 'flushed', stored: 1,
  })
})

it('routes each event once when a Session event lands right after an ordinary setup rollback (no removal fault)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r1-rollback-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPlugin, { root, compression: 'none' })
  const session = ctx.sessions.prepare(SessionId('rollback-window'))
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
  ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  cleanups.push(async () => {
    await writer.close().catch(() => undefined)
    await ctx.fiber.dispose().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  })
  const on = ctx.root.on.bind(ctx.root)
  let registrations = 0
  const onSpy = vi.spyOn(ctx.root, 'on').mockImplementation((...args) => {
    if (++registrations === 2) throw new Error('lifecycle listener registration failed')
    return on(...args)
  })
  expect(() => ctx.sessionPersistence.reserveSessionWriter(session)).toThrow('lifecycle listener registration failed')
  onSpy.mockImplementation(on)
  // The caller records its refusal synchronously, before the rollback's async route removal runs.
  session.append('turn/start', { turn: 1 })
  const flushed = await ctx.sessions.flush(session).then(() => 'flushed', (error: unknown) => String(error))
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  const stored = (await reader.read()).events.length
  await reader.close()
  expect({ flushed, stored }).toEqual({ flushed: 'flushed', stored: 1 })
})
