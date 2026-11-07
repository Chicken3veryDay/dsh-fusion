/** Independent caller and host teardown retain admitted result persistence in either order. */
import { expect, it } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-scope'
import { mount, read } from './harness.ts'

it.each(['host', 'caller'] as const)('settles admitted work when %s withdrawal starts first', async (first) => {
  const { ctx, adapter } = await mount()
  const caller = createScope(ctx, {}), declaring = createScope(ctx, {})
  const task = await caller.ctx.get('fusionParticipants')!.prepare('single-test')
  const resident = await task.adopt('participant')
  const invoked = Promise.withResolvers<undefined>(), body = Promise.withResolvers<undefined>()
  const cleaning = Promise.withResolvers<undefined>(), cleanup = Promise.withResolvers<undefined>()
  let canceled = 0, cleanups = 0
  const host = await declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, {
    name: 'overlapping-cleanup', revision: '1', classify: () => 'read',
    registerHeld() {
      return {
        async prepare() { return { async invoke() { invoked.resolve(undefined); await body.promise; return 'completed' as const } } },
        cancel() { canceled++ },
        async cleanup() { cleaning.resolve(undefined); await cleanup.promise; cleanups++ },
      }
    },
  })
  const attempt = host.reserve(host.bindRun(host.issuer, resident.agent, new AbortController().signal), 'inspect')
  await host.register(attempt)
  const work = host.release(attempt)
  await invoked.promise
  const finished = new Set<string>()
  const stop = (who: 'caller' | 'host') => (who === 'caller' ? caller : declaring).dispose().then(() => { finished.add(who) })
  const initial = stop(first)
  body.resolve(undefined)
  await cleaning.promise
  const subsequent = stop(first === 'host' ? 'caller' : 'host')
  try {
    expect(finished.size).toBe(0)
    expect(() => host.bindRun(host.issuer, resident.agent, new AbortController().signal)).toThrow()
    expect(ctx.sessions.get(resident.agent.id)).toBe(resident.agent.session)
    expect(await ctx.sessionPersistence.flushSessionDurably(resident.agent.session)).toMatchObject({ kind: 'durable' })
    cleanup.resolve(undefined)
    expect(await work).toEqual({ kind: 'settled', outcome: 'completed' })
    await Promise.all([initial, subsequent])
    expect(finished.size).toBe(2)
    expect({ canceled, cleanups }).toEqual({ canceled: 1, cleanups: 1 })
    expect((await read(ctx, resident.agent.id)).filter(event => event.type === 'fusion/effect-settled')
      .map(event => event.data.outcome)).toEqual(['completed'])
    expect(adapter.requests).toHaveLength(0)
  } finally {
    body.resolve(undefined); cleanup.resolve(undefined)
    await Promise.allSettled([work, initial, subsequent])
    await host.dispose(); await resident.dispose(); await task.dispose()
    await caller.dispose(); await declaring.dispose()
  }
})
