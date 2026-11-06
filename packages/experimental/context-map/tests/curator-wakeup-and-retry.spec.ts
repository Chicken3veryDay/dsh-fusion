/** Curator wake-up on a full map and the retry bound that a restart does not reset. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ContextMapService, { DefaultContextCurator } from '../src/index.ts'
import { ContextMapError } from '../src/error.ts'
import { contextMapProjectionDefinition, type ContextMapProjectionState } from '../src/projection.ts'
import { disposeWorlds, preStep, requestsOf, world, type World } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

const fail = (): never => { throw new Error('curator model failed') }

/** Fill a map to its content bound as a finished curator would, then leave it unclaimed with the index acknowledged. */
async function fillMap(w: World): Promise<void> {
  const map = w.ctx.contextMap
  const holder = await w.spawnRoot(randomUUID())
  const claimed = await map.claim(w.owner, { holderId: holder.id, route: { provider: 'mock', model: 'small', reasoningEffort: 'low' } })
  const add = async (text: string, cites: string[]): Promise<boolean> => {
    const current = map.snapshotOf(w.owner)
    const group = current.groups.find(entry => entry.notes.length < 8)
    try {
      if (group === undefined) {
        await map.setGroup(holder, { rootSessionId: w.owner.id, expectedRevision: current.revision, group: { path: `Tools/Global/g${current.groups.length}`, title: 'Group', summary: 'Use for tests.', tools: [`tool_${current.groups.length}`] } })
        return true
      }
      await map.addNote(holder, { rootSessionId: w.owner.id, expectedRevision: current.revision, groupId: group.id, text, cites })
      return true
    } catch (error: unknown) {
      if (error instanceof ContextMapError && error.code === 'CONTEXT_MAP_LIMIT') return false
      throw error
    }
  }
  const refs = (count: number): string[] => Array.from({ length: count }, (_, index) => `ref:${String(index)}${'e'.repeat(190)}`)
  for (const [length, cites] of [[400, 4], [200, 1], [60, 1], [16, 1]] as const) {
    while (await add('n'.repeat(length), refs(cites))) { /* fill */ }
  }
  while (await add('n', ['ref:x'])) { /* fill */ }
  await map.release(holder, { rootSessionId: w.owner.id })
  await map.acknowledgeIndex(w.owner, { rootSessionId: w.owner.id, indexDigest: claimed.observedIndexDigest })
}

async function refuseNote(w: World): Promise<ContextMapError> {
  try {
    await w.ctx.contextMap.note(w.owner, { text: 'Releases need NODE_ENV=production.' })
  } catch (error: unknown) {
    if (error instanceof ContextMapError) return error
    throw error
  }
  throw new Error('the full map accepted a note')
}

it('R5-m0 a context_note refused because the map is full wakes the curator, which is told the map is full', async () => {
  const w = await world({ curator: {}, script: [toolCallResponse('v1', 'map_view', {}), textResponse('curated')] })
  const request = requestsOf(w)
  await fillMap(w)
  const settled = await w.ctx.contextMap.view(w.owner, { rootSessionId: w.owner.id })
  // Preconditions: a finished, unclaimed map with nothing pending, nothing stale, a current index, and no room request.
  expect({
    curator: settled.curatorId, pending: settled.omittedPending, stale: settled.staleNotes,
    indexChanged: settled.indexChanged, needsSpace: settled.needsSpace,
  }).toEqual({ curator: null, pending: 0, stale: 0, indexChanged: false, needsSpace: undefined })

  expect((await refuseNote(w)).message).toContain('retry after the curator frees space')
  await request(2)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.adapter.requests, 'the refusal tells the agent to retry after the curator frees space, so the curator must run').toHaveLength(2)
  expect(JSON.stringify(w.adapter.requests[1]?.messages), 'the curator sees that the map is full').toContain('\\"needsSpace\\":true')
  expect((await w.ctx.contextMap.view(w.owner, { rootSessionId: w.owner.id })).needsSpace, 'the finished run answered the refusal').toBeUndefined()
})

it('R5-m0 a map that stays full is curated for at most maxAttempts refused notes', async () => {
  const w = await world({ curator: {}, script: [textResponse('could not free room'), textResponse('could not free room'), fail] })
  const request = requestsOf(w)
  await fillMap(w)
  for (const run of [1, 2]) {
    await refuseNote(w)
    await request(run)
    await w.ctx.contextCurator.idle(w.owner.id)
  }
  await refuseNote(w)
  // The third refusal finds the attempts for this unchanged map used up; new work then proves no run was pending.
  w.write('AGENTS.md', '# Changed\n\nNew rules.\n')
  await preStep(w.ctx, w.owner)
  await request(3)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.adapter.requests).toHaveLength(3)
})

it('R5-m3 a curator run that fails on the same index is not restarted on every owner step', async () => {
  const w = await world({ curator: {}, script: [fail, fail, fail, fail, fail] })
  const request = requestsOf(w)
  expect((await w.sections()).length).toBeGreaterThan(0)
  for (const run of [1, 2]) {
    await preStep(w.ctx, w.owner, 1, run + 1)
    await request(run)
    await w.ctx.contextCurator.idle(w.owner.id)
  }
  for (let step = 4; step <= 7; step++) {
    await preStep(w.ctx, w.owner, 1, step)
    await w.ctx.contextCurator.idle(w.owner.id)
  }
  // Control: the index is still unacknowledged, so the map stays eligible; new source work then runs once more.
  expect((await w.ctx.contextMap.view(w.owner, { rootSessionId: w.owner.id })).indexChanged).toBe(true)
  w.write('AGENTS.md', '# Changed\n\nNew rules.\n')
  await preStep(w.ctx, w.owner, 1, 8)
  await request(3)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.adapter.requests, 'two failing runs for one index, then one for the changed index').toHaveLength(3)
})

it('R5-m3 the retry bound survives a restart of the map service and the curator', async () => {
  const w = await world({ curator: {}, script: [fail, fail, fail, fail] })
  const request = requestsOf(w)
  for (const run of [1, 2]) {
    await preStep(w.ctx, w.owner, 1, run + 1)
    await request(run)
    await w.ctx.contextCurator.idle(w.owner.id)
  }
  await w.curatorFiber!.dispose()
  await [...w.ctx.registry.get(ContextMapService)!.fibers][0]!.dispose()
  await w.ctx.plugin(ContextMapService)
  await w.ctx.plugin(DefaultContextCurator)
  for (let step = 4; step <= 6; step++) {
    await preStep(w.ctx, w.owner, 1, step)
    await w.ctx.contextCurator.idle(w.owner.id)
  }
  w.write('AGENTS.md', '# Changed\n\nNew rules.\n')
  await preStep(w.ctx, w.owner, 1, 7)
  await request(3)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.adapter.requests, 'a restart did not give the failed index a fresh set of attempts').toHaveLength(3)
})

it('counts claims for the same work in the log and restarts the count for different work', async () => {
  const w = await world()
  const map = w.ctx.contextMap
  const claimFor = async (work: string | undefined): Promise<void> => {
    await map.claim(w.owner, work === undefined ? {} : { work })
    await map.release(w.owner)
  }
  await claimFor('work-a')
  await claimFor('work-a')
  await claimFor(undefined)
  const replay = (): ContextMapProjectionState => w.owner.session.snapshotEvents().reduce<ContextMapProjectionState>(
    (state, event) => contextMapProjectionDefinition.apply(state, event), contextMapProjectionDefinition.init(w.owner.session.header),
  )
  expect(replay().attempts, 'a claim without work leaves the count alone').toEqual({ work: 'work-a', count: 2 })
  await claimFor('work-b')
  expect(replay().attempts).toEqual({ work: 'work-b', count: 1 })
  expect(JSON.parse(JSON.stringify(replay())), 'the state survives a checkpoint round trip').toEqual(replay())
})
