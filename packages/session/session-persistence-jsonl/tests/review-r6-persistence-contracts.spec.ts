/** Round-6 review probes: a refused stock close's real result and the withdrawal release-phase window. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { WriterLifetimeReservation } from '@deepseek-ai/dsh-session-persistence'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Jsonl from '../src/index.ts'
import { JsonlSessionHandle } from '../src/storage.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function mount(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r6-persistence-'))
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose().catch((_error: unknown) => { /* Failure cases assert their own errors. */ })
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  const session = ctx.sessions.prepare(SessionId(id), { meta: { delegationDepth: 0 } })
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
  cleanups.push(async () => {
    await writer.close().catch((_error: unknown) => { /* A failed close is asserted in its case. */ })
  })
  return { ctx, session, writer }
}

it('m1: a refused stock close whose real close fails records no uncertainty and frees the claim', async () => {
  const { ctx, session, writer } = await mount('r6-refused-stock-close')
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  cleanups.push(async () => { detach() })
  const failure = new Error('final drain failed')
  let closing = false
  const drain = writer.drainLive.bind(writer)
  vi.spyOn(writer, 'drainLive').mockImplementation(() => closing ? Promise.reject(failure) : drain())
  let refusal: unknown
  vi.spyOn(writer, 'flush').mockImplementation(async () => {
    closing = true
    refusal = await writer.close().catch((error: unknown) => error)
  })
  await expect(ctx.sessions.flush(session)).resolves.toBe(true)
  expect(refusal).toBeInstanceOf(Jsonl.JsonlSessionCloseReentryError)
  // The real close ran in the background and failed; no caller outside the flush exists yet.
  const retried = writer.close()
  await expect(retried).rejects.toBe(failure)
  // storage.ts:374-376 says the real result is "recorded as uncertainty"; a stock close records none.
  expect(writer.lifetimeUncertain).toBe(false)
  // The claim is freed: a same-id create is admitted again.
  const again = await ctx.sessionPersistence.create(session.header)
  await again.close()
})

it('keeps the fence through the withdrawal release phase while the earlier reservation still releases durably', async () => {
  const { ctx, session, writer } = await mount('r6-release-phase')
  const earlier: { reservation?: WriterLifetimeReservation } = {}
  const observed: Record<string, unknown> = {}
  const detach = ctx.sessions.enter(session, {
    withdraw: () => Promise.resolve(),
    release: async () => {
      observed.isWithdrawing = ctx.sessions.isWithdrawing(session)
      observed.acceptsWithdrawal = ctx.sessions.acceptsWithdrawal(session)
      observed.live = ctx.sessions.get(session.id) === session
      observed.newReservation = ctx.sessionPersistence.reserveSessionWriter(session)
      const reservation = earlier.reservation
      if (reservation?.kind !== 'reserved') throw new Error('expected an earlier reservation')
      observed.dispatch = reservation.reservation.checkDispatch()
      observed.released = await reservation.reservation.release()
      await writer.close()
    },
  })
  ctx.sessions.announce(session)
  const reservation = ctx.sessionPersistence.reserveSessionWriter(session)
  earlier.reservation = reservation
  if (reservation.kind !== 'reserved') throw new Error(`reservation refused: ${reservation.reason}`)
  session.append('turn/start', { turn: 1 })
  await detach()
  expect(observed).toMatchObject({
    isWithdrawing: true,
    acceptsWithdrawal: false,
    live: true,
    newReservation: { kind: 'refused', reason: 'fenced' },
    dispatch: { kind: 'refused', reason: 'fenced' },
    released: { kind: 'durable' },
  })
  expect(ctx.sessions.isWithdrawing(session)).toBe(false)
  expect(ctx.sessions.withdrawalOf(session)).toBeUndefined()
  expect(ctx.sessions.get(session.id)).toBeUndefined()
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  try {
    expect((await reader.read()).events.filter(event => event.type === 'turn/start')).toHaveLength(1)
  } finally { await reader.close() }
})

it('m2: withdrawalOf keeps returning the settled, rejected join after a failed withdrawal', async () => {
  const { ctx, session } = await mount('r6-withdrawal-of-failed')
  const cause = new Error('producer join failed')
  const detach = ctx.sessions.enter(session, { withdraw: () => Promise.reject(cause) })
  ctx.sessions.announce(session)
  const withdrawal = detach()
  await expect(withdrawal).rejects.toMatchObject({ message: 'Session withdrawal failed', errors: [cause] })
  // The JSDoc summary says "the exact pending withdrawal join"; the join has settled, yet it is still returned,
  // and the JSONL route closer (storage.ts:846) and provider teardown (storage.ts:999) depend on that.
  expect(ctx.sessions.withdrawalOf(session)).toBe(withdrawal)
  expect(ctx.sessions.isWithdrawing(session)).toBe(true)
  expect(ctx.sessions.acceptsWithdrawal(session)).toBe(false)
  expect(ctx.sessions.get(session.id)).toBe(session)
})
