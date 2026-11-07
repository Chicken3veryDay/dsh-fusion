/** Cache discard diagnostics identify the unit without copying rejected cache payload keys. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import Registry from '../src/index.ts'

it('does not expose rejected payload keys in the discard warning', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(Registry)
  await ctx.sessionProjections.register({ key: 'review/private-state', stateVersion: 1,
    stateSchema: z.object({ count: z.number() }).strict(), init: () => ({ count: 0 }), apply: state => state })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const privateKey = 'PRIVATE_CUSTOMER_PROJECT_NAME'
  const header: import('@deepseek-ai/dsh-session').SessionHeader = { id: SessionId('warning-probe'), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false }
  const restored = ctx.sessionProjections.restore({
    'review/private-state': { ver: 1, seq: SessionSeq(0), val: { count: 1, [privateKey]: 'cached data' } },
  }, [{ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } }], SessionLogOffset(0), header, SessionLogOffset(0))
  expect(restored.checkpoint['review/private-state']?.val).toEqual({ count: 0 })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('discarded the checkpoint row'))
  expect(warn.mock.calls.flat().join(' ')).not.toContain(privateKey)
})
