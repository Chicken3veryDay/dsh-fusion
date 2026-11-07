/** Recovery and transient-start failures must leave pending work schedulable. */
import { afterEach, expect, it, vi } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { DefaultContextCurator } from '../src/index.ts'
import { disposeWorlds, preStep, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

it('R7 a curator enabled after owner steps picks up already-announced pending work', async () => {
  const w = await world({ script: [textResponse('curated')] })
  const map = w.ctx.contextMap
  const claim = await map.claim(w.owner)
  await map.release(w.owner)
  await map.acknowledgeIndex(w.owner, { indexDigest: claim.observedIndexDigest })
  const pending = await map.note(w.owner, { text: 'File this accepted fact.', cites: ['ref:package.json'] })
  // The owner has already stepped while the curator was disabled or being reloaded.
  await preStep(w.ctx, w.owner)
  expect((await map.view(w.owner)).indexChanged).toBe(false)
  expect(map.snapshotOf(w.owner).pending.map(note => note.id)).toEqual([pending.id])
  await w.ctx.plugin(DefaultContextCurator)
  for (let step = 3; step <= 5; step++) await preStep(w.ctx, w.owner, 1, step)
  await vi.waitFor(() => {
    expect(w.adapter.requests.length, 'the newly enabled curator must recover accepted pending work').toBeGreaterThan(0)
  }, { timeout: 2000 })
  await w.ctx.contextCurator.idle(w.owner.id)
})

it('R7 a transient route-catalog failure does not permanently suppress pending work', async () => {
  const w = await world({ curator: {}, script: [textResponse('curated')] })
  const failed = Promise.withResolvers<undefined>()
  vi.spyOn(w.ctx.logger, 'warn').mockImplementation(() => { failed.resolve(undefined) })
  const listing = vi.spyOn(w.ctx.llm, 'listModels').mockRejectedValueOnce(new Error('temporary catalog outage'))
  const pending = await w.ctx.contextMap.note(w.owner, { text: 'File this accepted fact.', cites: ['ref:package.json'] })
  await failed.promise
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(listing).toHaveBeenCalledTimes(1)
  expect(w.adapter.requests).toHaveLength(0)
  // The first owner step announces the waiting work again; let its second start fail too.
  listing.mockRejectedValueOnce(new Error('temporary catalog outage'))
  await preStep(w.ctx, w.owner)
  await vi.waitFor(() => { expect(listing).toHaveBeenCalledTimes(2) })
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.ctx.contextMap.snapshotOf(w.owner).pending.map(note => note.id)).toEqual([pending.id])
  // The route catalog is healthy now; no source change or new note should be necessary.
  for (let step = 3; step <= 5; step++) await preStep(w.ctx, w.owner, 1, step)
  await vi.waitFor(() => {
    expect(w.adapter.requests.length, 'a recovered route must resume the accepted pending work').toBeGreaterThan(0)
  }, { timeout: 2000 })
  await w.ctx.contextCurator.idle(w.owner.id)
})

it('R7 cancellation during the final claim read preserves a foreign curator handoff', async () => {
  const w = await world({ script: [textResponse('must not start')] })
  const map = w.ctx.contextMap
  const assistant = await w.spawnRoot('assistant')
  const claim = map.claim.bind(map)
  const first = await claim(w.owner)
  await map.release(w.owner)
  await map.acknowledgeIndex(w.owner, { indexDigest: first.observedIndexDigest })
  await map.note(w.owner, { text: 'Pending work.', cites: ['ref:package.json'] })
  await w.ctx.plugin(DefaultContextCurator)
  const handedOff = Promise.withResolvers<undefined>()
  let intercepted = false
  vi.spyOn(map, 'claim').mockImplementation(async (caller, request, signal) => {
    if (request?.work !== undefined && !intercepted) {
      intercepted = true
      const snapshot = w.ctx.contextIndex.snapshot.bind(w.ctx.contextIndex)
      vi.spyOn(w.ctx.contextIndex, 'snapshot').mockImplementationOnce(async (...args) => {
        // Its real index read succeeds. Before its awaiting claim can commit, an assistant
        // takes the role; the real watcher cancels the default curator's controller.
        const result = await snapshot(...args)
        await claim(w.owner, { holderId: assistant.id })
        expect(map.curatorOf(w.owner)).toBe(assistant.id)
        expect(signal?.aborted).toBe(true)
        handedOff.resolve(undefined)
        return result
      })
    }
    return claim(caller, request, signal)
  })
  await preStep(w.ctx, w.owner)
  await handedOff.promise
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(intercepted).toBe(true)
  expect(w.adapter.requests).toHaveLength(0)
  expect(map.curatorOf(w.owner), 'an aborted default claim must not overwrite and release the assistant role').toBe(assistant.id)
})
