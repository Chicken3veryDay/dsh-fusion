/** Providers must opt in explicitly; ordinary service implementations cannot authorize a reservation. */
import { Context } from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { SessionPersistence } from '../src/index.ts'

it('refuses exact-writer reservation and durability for unsupported providers', async () => {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  try {
    const session = ctx.sessions.prepare()
    expect(SessionPersistence.prototype.reserveSessionWriter(session)).toEqual({ kind: 'refused', reason: 'unsupported' })
    await expect(SessionPersistence.prototype.flushSessionDurably(session)).resolves.toEqual({ kind: 'refused', reason: 'unsupported' })
  } finally { await ctx.fiber.dispose() }
})
