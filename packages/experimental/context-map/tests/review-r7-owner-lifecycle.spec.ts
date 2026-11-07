/** A curator run belongs to its live map owner, including while it is selecting a route. */
import { afterEach, expect, it, vi } from 'vitest'
import { disposeWorlds, preStep, requestsOf, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

it.each(['route lookup', 'model stream'] as const)('R7 disposing an owner settles its curator during %s', async (stage) => {
  const w = await world({ curator: {}, script: ['hang'] })
  const owner = await w.spawnRoot('temporary-owner')
  const entered = Promise.withResolvers<undefined>()
  if (stage === 'route lookup') {
    vi.spyOn(w.ctx.llm, 'listModels').mockImplementationOnce(() => {
      entered.resolve(undefined)
      return new Promise(() => {})
    })
  }
  const request = requestsOf(w)
  await preStep(w.ctx, owner)
  if (stage === 'route lookup') await entered.promise
  else await request(1)
  expect(w.ctx.contextCurator.isRunning(owner.id)).toBe(true)
  await w.disposeRoot(owner)
  expect(w.ctx.agents.get(owner.id)).toBeUndefined()
  await vi.waitFor(() => {
    expect(w.ctx.contextCurator.isRunning(owner.id), 'a disposed owner must not retain a live or acquiring curator').toBe(false)
  }, { timeout: 2000 })
})

it('R7 disposed roots do not retain a separate full section-hash table in the map service', async () => {
  const w = await world()
  // Inspect the retaining owner, rather than heap-size deltas that depend on GC timing.
  const hashes: unknown = Reflect.get(w.ctx.contextMap, 'hashes')
  if (!(hashes instanceof Map)) throw new Error('Missing section-hash cache')
  const disposedIds: string[] = []
  for (let index = 0; index < 4; index++) {
    const owner = await w.spawnRoot(`closed-owner-${index}`)
    await w.ctx.contextMap.curationWork(owner)
    const entries: unknown = hashes.get(owner.id)
    expect(entries).toBeInstanceOf(Map)
    expect(entries instanceof Map ? entries.size : 0).toBe((await w.sections()).length)
    disposedIds.push(owner.id)
    await w.disposeRoot(owner)
    expect(w.ctx.agents.get(owner.id)).toBeUndefined()
  }
  expect(disposedIds.filter(id => hashes.has(id)), 'closed conversations must not accumulate full per-root hash tables').toEqual([])
})
