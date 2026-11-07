/**
 * Probe for the order the curator's disposal sets `stopping` and removes its map watcher, which decides whether the
 * `v8 ignore if` on `if (this.stopping) return` in `DefaultContextCurator.onChange` hides a reachable window.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { disposeWorlds, requestsOf, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

it('sets stopping before it removes the map watcher, with no later microtask in between', async () => {
  const w = await world({ curator: {}, script: ['hang'] })
  vi.spyOn(w.ctx.logger, 'warn').mockImplementation(() => undefined)
  const request = requestsOf(w)
  const root = await w.spawnRoot('root')
  await w.ctx.contextMap.note(root, { text: 'Map this.' })
  await request(1)
  const order: string[] = []
  let tick = 0
  const curator = w.ctx.get('contextCurator') as object as { stopping: boolean }
  let stopping = curator.stopping
  Object.defineProperty(curator, 'stopping', {
    configurable: true,
    get: () => stopping,
    set: (value: boolean) => { order.push(`stopping=${String(value)}@${tick}`); stopping = value },
  })
  const watchers = (w.ctx.contextMap as object as { watchers: Set<unknown> }).watchers
  const remove = watchers.delete.bind(watchers)
  watchers.delete = (value: unknown) => { order.push(`watcher removed@${tick}`); return remove(value) }
  const disposing = w.curatorFiber!.dispose()
  order.push('dispose() returned')
  // A bounded microtask counter: it marks how many microtasks after the call each step ran.
  for (let i = 0; i < 50; i++) { await Promise.resolve(); tick++ }
  await disposing
  // The ignore reason says the watcher goes first; cordis runs disposers in reverse registration order, so the
  // stopping disposer starts first, and the watcher goes before any microtask queued after dispose() is called.
  expect(order).toEqual(['dispose() returned', 'stopping=true@0', 'watcher removed@0'])
})
