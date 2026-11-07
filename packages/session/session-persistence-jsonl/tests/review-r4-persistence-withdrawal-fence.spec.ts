/** Evidence for round-4 minor findings; each case pins the current behavior it describes. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
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
  const root = await mkdtemp(join(tmpdir(), 'review-r4-minors-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  const session = ctx.sessions.prepare(SessionId(id))
  const writer = await ctx.sessionPersistence.create(session.header)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('expected JSONL writer')
  cleanups.push(async () => {
    await ctx.fiber.dispose().catch((_error: unknown) => { /* failed withdrawal keeps the writer open by design */ })
    await writer['lease']?.release()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, session, writer }
}

it('m2: isWithdrawing stays true after a failed withdrawal, keeping reservations fenced', async () => {
  const { ctx, session, writer } = await mount('r4-failed-withdrawal')
  const cause = new Error('producer join failed')
  const detach = ctx.sessions.enter(session, { withdraw: () => Promise.reject(cause) })
  ctx.sessions.announce(session)
  const first = ctx.sessionPersistence.reserveSessionWriter(session)
  if (first.kind !== 'reserved') throw new Error(`reservation refused: ${first.reason}`)
  const withdrawal = await detach().then(() => 'withdrawn', () => 'failed')
  const after = ctx.sessionPersistence.reserveSessionWriter(session)
  const dispatch = first.reservation.checkDispatch()
  const released = await first.reservation.release()
  expect({
    withdrawal, isWithdrawing: ctx.sessions.isWithdrawing(session), live: ctx.sessions.get(session.id) === session,
    after: after.kind === 'refused' ? after.reason : after.kind, dispatch, released: released.kind,
    writerOpen: writer.durabilityOpen,
  }).toEqual({
    withdrawal: 'failed', isWithdrawing: true, live: true, after: 'fenced',
    dispatch: { kind: 'refused', reason: 'fenced' }, released: 'durable', writerOpen: true,
  })
})
