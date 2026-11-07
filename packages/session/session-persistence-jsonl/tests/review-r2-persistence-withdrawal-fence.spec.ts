/** Exact-writer admission must close when an opted-in Session begins withdrawal. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPlugin from '../src/index.ts'
import { JsonlSessionHandle } from '../src/storage.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('fences dispatch and new reservations synchronously when Session withdrawal begins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r2-withdrawal-'))
  const ctx = new Context()
  const finishProducer = Promise.withResolvers<undefined>()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlPlugin, { root, compression: 'none' })
    const session = ctx.sessions.prepare(SessionId('withdrawal-admission'))
    const writer = await ctx.sessionPersistence.create(session.header)
    if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
    const detach = ctx.sessions.enter(session, { withdraw: () => finishProducer.promise })
    ctx.sessions.announce(session)
    const initial = ctx.sessionPersistence.reserveSessionWriter(session)
    if (initial.kind !== 'reserved') throw new Error(`reservation refused: ${initial.reason}`)
    const pin = initial.reservation
    const withdrawal = detach()
    const isWithdrawing = ctx.sessions.isWithdrawing(session)
    const aborted = pin.signal.aborted
    const dispatch = pin.checkDispatch()
    const next = ctx.sessionPersistence.reserveSessionWriter(session)
    // Settle all resources before asserting the admission snapshot, so a red test cannot hang teardown.
    finishProducer.resolve(undefined)
    if (next.kind === 'reserved') await next.reservation.release()
    await pin.release()
    await withdrawal
    await writer.close()
    expect({ isWithdrawing, aborted, dispatch, admission: next.kind }).toEqual({
      isWithdrawing: true, aborted: true,
      dispatch: { kind: 'refused', reason: 'fenced' }, admission: 'refused',
    })
  } finally {
    finishProducer.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
