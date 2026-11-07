/** Host-wide control baselines materialize every Session through the projection registry. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { SessionControlController } from '../src/control.ts'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'

const ownedContexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
})

it('fails the whole baseline, never a partial one, when one Session fold throws', async () => {
  const ctx = new Context()
  ownedContexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const healthy = await loop.create(SessionId('healthy-session'))
  const broken = await loop.create(SessionId('broken-session'))
  const control = new SessionControlController(ctx)
  const failing = await ctx.sessionProjections.register({
    key: 'test/broken-fold', stateVersion: 1, stateSchema: z.number(),
    init: (header) => {
      if (header.id === broken.session.id) throw new Error('broken fold')
      return 0
    },
    apply: (state: number) => state,
  })
  expect(() => ctx.sessionProjections.snapshot(healthy.session)).not.toThrow()
  const abort = new AbortController()
  const iterator = control.control(abort.signal)[Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toThrow('broken fold')
  abort.abort()
  await failing.dispose()
  const reopened = control.control(new AbortController().signal)[Symbol.asyncIterator]()
  const baseline = await reopened.next()
  expect(baseline.value).toMatchObject({ type: 'baseline', value: { projections: {
    'healthy-session': { values: {} }, 'broken-session': { values: {} },
  } } })
  await reopened.return?.()
})
