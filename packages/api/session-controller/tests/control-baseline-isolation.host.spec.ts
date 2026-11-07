/** One Session whose projections fail to fold leaves every other Session's control baseline exact. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionControlController } from '../src/control.ts'
import type { SessionControlFrame } from '../src/types.ts'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'

const ownedContexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
})

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/broken-fold': number
  }
}

async function firstBaseline(control: SessionControlController): Promise<Extract<SessionControlFrame, { type: 'baseline' }>> {
  const iterator = control.control(new AbortController().signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  await iterator.return?.()
  if (first.done === true || first.value.type !== 'baseline') throw new Error('control stream opened without a baseline')
  return first.value
}

it('delivers healthy Sessions and reports the Session whose projection fold throws', async () => {
  const ctx = new Context()
  ownedContexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const healthy = await loop.create(SessionId('healthy-session'))
  const broken = await loop.create(SessionId('broken-session'))
  const control = new SessionControlController(ctx)
  const logged = vi.spyOn(ctx.logger, 'error')
  // A client-visible unit: its failure leaves the broken Session without a complete cut.
  const failing = await ctx.sessionProjections.register({
    key: 'test/broken-fold', stateVersion: 1, stateSchema: z.number(),
    init: (header) => {
      if (header.id === broken.session.id) throw new Error('broken fold')
      return 0
    },
    apply: (state: number) => state,
    wire: { viewSchema: z.number(), view: (state: number) => state },
  })

  const isolated = await firstBaseline(control)
  expect(Object.keys(isolated.value.projections)).toEqual([healthy.session.id])
  expect(isolated.value.projections[healthy.session.id]?.values).toHaveProperty('inbox')
  expect(isolated.value.failed).toEqual([broken.session.id])
  expect(logged).toHaveBeenCalledWith(expect.stringMatching(/Session "broken-session".*broken fold/))

  await failing.dispose()
  const recovered = await firstBaseline(control)
  expect(Object.keys(recovered.value.projections).sort()).toEqual([broken.session.id, healthy.session.id].sort())
  expect(recovered.value).not.toHaveProperty('failed')
})

it('delivers a Session whose only failed unit is host-only', async () => {
  const ctx = new Context()
  ownedContexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const session = await loop.create(SessionId('host-failure-session'))
  const control = new SessionControlController(ctx)
  vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  await ctx.sessionProjections.register({
    key: 'test/host-broken-fold', stateVersion: 1, stateSchema: z.number(),
    init: () => {
      throw new Error('host-only fold')
    },
    apply: (state: number) => state,
  })

  const baseline = await firstBaseline(control)
  expect(Object.keys(baseline.value.projections)).toEqual([session.session.id])
  expect(baseline.value.projections[session.session.id]?.values).toHaveProperty('inbox')
  expect(baseline.value).not.toHaveProperty('failed')
})
