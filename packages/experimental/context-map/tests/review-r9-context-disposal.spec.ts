/** Teardown must settle curator work while its resources remain usable. */
import { afterEach, expect, it, vi } from 'vitest'
import ContextMapService, { DefaultContextCurator } from '../src/index.ts'
import { disposeWorlds, logged, preStep, requestsOf, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

it('R9 map provider disposal releases the active curator role durably', async () => {
  const w = await world({ curator: {}, script: ['hang'] })
  const request = requestsOf(w)
  await preStep(w.ctx, w.owner)
  await request(1)
  const service = w.ctx.contextMap
  const before = service.snapshotOf(w.owner)
  expect(before.curatorId).not.toBeNull()
  const fiber = [...w.ctx.registry.get(ContextMapService)!.fibers][0]!
  await fiber.dispose()
  expect(w.ctx.agents.get(before.curatorId!)).toBeUndefined()
  const events = await logged(w.ctx, w.owner.id)
  const maps = events.filter(event => event.type === 'context-map/state')
  expect(maps.at(-1)?.data, 'map disposal must retain the writer until the curator releases its role')
    .toMatchObject({ op: { kind: 'release' }, snapshot: { curatorId: null } })
})

it('R9 curator-only disposal releases its active role as a control', async () => {
  const w = await world({ curator: {}, script: ['hang'] })
  const request = requestsOf(w)
  await preStep(w.ctx, w.owner)
  await request(1)
  await w.curatorFiber!.dispose()
  expect(w.ctx.contextMap.snapshotOf(w.owner).curatorId).toBeNull()
})

it('R9 disposing an owner cancels its in-progress work evaluation', async () => {
  const w = await world()
  // The existing root holds its own map, so only the temporary root evaluates index work at load.
  await w.ctx.contextMap.claim(w.owner)
  const owner = await w.spawnRoot('evaluation-owner')
  const entered = Promise.withResolvers<undefined>()
  const unblock = Promise.withResolvers<undefined>()
  const stat = w.ctx.fs.stat.bind(w.ctx.fs)
  let evaluating = false
  vi.spyOn(w.ctx.fs, 'stat').mockImplementationOnce(async (target, signal) => {
    evaluating = true
    entered.resolve(undefined)
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => { aborted.reject(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal?.aborted) onAbort()
      await Promise.race([unblock.promise, aborted.promise])
      return await stat(target, signal)
    } finally {
      evaluating = false
      signal?.removeEventListener('abort', onAbort)
    }
  })
  const fiber = await w.ctx.plugin(DefaultContextCurator)
  try {
    await entered.promise
    expect(evaluating).toBe(true)
    await w.disposeRoot(owner)
    expect(w.ctx.agents.get(owner.id)).toBeUndefined()
    await w.ctx.contextCurator.idle(owner.id)
    expect(evaluating, 'owner disposal and curator idle must not leave its accepted evaluation running').toBe(false)
  } finally {
    unblock.resolve(undefined)
    await fiber.dispose()
  }
})
