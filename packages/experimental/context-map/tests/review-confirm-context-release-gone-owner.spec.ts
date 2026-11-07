/**
 * Shows that the `v8 ignore if` on `if (owner === undefined || this.disposed) return` in `ContextMapService.releaseGone`
 * hides a reachable path: a root that holds its own map's curator role is the holder and the owner at once, and the
 * agent registry removes it before `agent/disposed` runs, so `releaseGone` finds no owner.
 */
import { afterEach, expect, it, vi } from 'vitest'
import ContextMapService from '../src/index.ts'
import { disposeWorlds, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

it('reaches the releaseGone early return when a root that holds its own map is disposed', async () => {
  const w = await world()
  const root = await w.spawnRoot('root')
  await w.ctx.contextMap.claim(root)
  expect(w.ctx.contextMap.snapshotOf(root).curatorId).toBe(root.id)
  type Probe = { releaseGone: (ownerId: string, holderId: string) => Promise<void> }
  const proto = ContextMapService.prototype as object as Probe
  const original = proto.releaseGone
  const calls: { ownerId: string; holderId: string; ownerLive: boolean }[] = []
  proto.releaseGone = function (this: Probe, ownerId, holderId) {
    calls.push({ ownerId, holderId, ownerLive: w.ctx.agents.get(ownerId as never) !== undefined })
    return original.call(this, ownerId, holderId)
  }
  const snapshotOf = vi.spyOn(w.ctx.contextMap, 'snapshotOf')
  try {
    await w.disposeRoot(root)
  } finally {
    proto.releaseGone = original
  }
  // The handler calls releaseGone for the root's own map while the root is already out of the registry, so the guard
  // returns before releaseGone reads the snapshot.
  expect(calls).toEqual([{ ownerId: root.id, holderId: root.id, ownerLive: false }])
  expect(snapshotOf).not.toHaveBeenCalled()
})
