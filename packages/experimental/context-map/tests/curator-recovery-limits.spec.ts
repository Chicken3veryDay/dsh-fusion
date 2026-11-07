/** Completed index acknowledgement, interruption recovery, and claim capacity. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { contextMapProjectionDefinition, type ContextMapProjectionState } from '../src/projection.ts'
import DefaultContextCurator from '../src/curator.ts'
import { ContextMapError } from '../src/error.ts'
import { disposeWorlds, preStep, requestsOf, world, type World } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

it.each(['step bound', 'model error', 'restart'] as const)('an interrupted partial map remains eligible for curation after %s', async (mode) => {
  const ref: { w?: World; section: string | undefined } = { section: undefined }
  const w = await world({
    curator: { maxSteps: mode === 'step bound' ? 2 : 24 },
    script: [
      toolCallResponse('v1', 'map_view', {}),
      () => toolCallResponse('g1', 'map_group', {
        action: 'set', expected_revision: ref.w!.ctx.contextMap.snapshotOf(ref.w!.owner).revision,
        path: 'Instructions/Project/rules', title: 'Project rules', summary: 'Use before changing code.', sections: [ref.section!],
      }),
      ...(mode === 'step bound' ? [] : mode === 'restart' ? ['hang' as const] : [() => { throw new Error('curator model failed') }]),
      textResponse('completed on a later owner step'),
    ],
  })
  const request = requestsOf(w)
  ref.w = w
  ref.section = (await w.projectSections())[0]
  expect(ref.section).toBeDefined()

  await preStep(w.ctx, w.owner)
  await request(1)
  if (mode === 'restart') {
    await request(3)
    await w.curatorFiber!.dispose()
    await w.ctx.plugin(DefaultContextCurator)
  } else {
    await w.ctx.contextCurator.idle(w.owner.id)
  }
  const map = w.ctx.contextMap.snapshotOf(w.owner)
  expect({ groups: map.groups.length, curator: map.curatorId, requests: w.adapter.requests.length }).toEqual({ groups: 1, curator: null, requests: mode === 'step bound' ? 2 : 3 })
  const sections = (await w.sections()).length
  expect(sections).toBeGreaterThan(map.groups.flatMap(group => group.sections).length)

  const view = await w.ctx.contextMap.view(w.owner, { rootSessionId: w.owner.id })
  expect(view.indexChanged, 'an interrupted run did not finish indexing').toBe(true)
  const before = w.adapter.requests.length
  await preStep(w.ctx, w.owner)
  await request(before + 1)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect((await w.ctx.contextMap.view(w.owner)).indexChanged).toBe(false)
})

it('R4-M3 a map filled close to maxSnapshotBytes can still be claimed by the default curator after the working agent files a note', async () => {
  const w = await world({ curator: {}, script: [textResponse('curated')] })
  const request = requestsOf(w)
  const failed = Promise.withResolvers<undefined>()
  const warn = vi.spyOn(w.ctx.logger, 'warn').mockImplementation(() => { failed.resolve(undefined) })
  const map = w.ctx.contextMap
  const size = (): number => Buffer.byteLength(JSON.stringify(map.snapshotOf(w.owner)))
  // A holder whose id and route have the default curator's lengths fills the map, as a long-running curator would.
  const holder = await w.spawnRoot(randomUUID())
  const route = { provider: 'mock', model: 'small', reasoningEffort: 'low' }
  await map.claim(w.owner, { holderId: holder.id, route })
  const add = async (text: string, cites: string[]): Promise<boolean> => {
    if (size() > 65_000) return false
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
  // Leave enough content room for one pending note, then consume it before the next claim. The
  // holder releases the role afterwards; that release hands the waiting work to the default curator.
  let text = Math.min(400, 65_536 - size() - 110)
  for (;; text -= 5) {
    try {
      await map.note(w.owner, { text: 'x'.repeat(Math.max(1, text)) })
      break
    } catch (error: unknown) {
      if (!(error instanceof ContextMapError) || error.code !== 'CONTEXT_MAP_LIMIT' || text < 1) throw error
    }
  }
  expect(map.snapshotOf(w.owner).pending).toHaveLength(1)
  await map.release(holder, { rootSessionId: w.owner.id })
  expect(map.snapshotOf(w.owner).curatorId).toBeNull()
  await Promise.race([request(1), failed.promise])
  await w.ctx.contextCurator.idle(w.owner.id)
  expect({ requests: w.adapter.requests.length, warnings: warn.mock.calls.map(args => String(args[0])) }, 'the curator must be able to take the role to file or drop the note and shrink the map').toEqual({ requests: 1, warnings: [] })
})


it('a full content budget cannot block a role claim or fund another note when the role is released', async () => {
  const w = await world({ map: { maxSnapshotBytes: 1024 } })
  const map = w.ctx.contextMap
  await map.claim(w.owner)
  await map.note(w.owner, { text: 'n'.repeat(400) })
  const current = map.snapshotOf(w.owner)
  const candidate = { ...current, revision: current.revision + 1, curatorId: null, route: null, indexDigest: null,
    pending: [...current.pending, { id: 'pnd_00000000', text: '', cites: [], by: w.owner.id }] }
  const room = 1024 - Buffer.byteLength(JSON.stringify(candidate))
  expect(room).toBeGreaterThan(0)
  expect(room).toBeLessThanOrEqual(400)
  await map.note(w.owner, { text: 'n'.repeat(room) })
  const full = map.snapshotOf(w.owner)
  expect(Buffer.byteLength(JSON.stringify({ ...full, curatorId: null, route: null, indexDigest: null }))).toBe(1024)
  await map.release(w.owner)
  const holder = await w.spawnRoot('curator-' + 'c'.repeat(100))
  await map.claim(w.owner, { holderId: holder.id, route: { provider: 'mock', model: 'small' } })
  expect(map.curatorOf(w.owner)).toBe(holder.id)
  expect(Buffer.byteLength(JSON.stringify(map.snapshotOf(w.owner)))).toBeGreaterThan(1024)
  await map.release(holder, { rootSessionId: w.owner.id })
  const revision = map.snapshotOf(w.owner).revision
  let rejected: ContextMapError | undefined
  try { await map.note(w.owner, { text: 'one more' }) }
  catch (error: unknown) {
    if (!(error instanceof ContextMapError)) throw error
    rejected = error
  }
  expect(rejected?.code).toBe('CONTEXT_MAP_LIMIT')
  expect(map.snapshotOf(w.owner).revision).toBe(revision)
  await expect(rejected!.message + '\n').toMatchFileSnapshot('./expected/full-map-note-error.txt')
})

it('acknowledges only the index observed by the completed run and refuses another holder', async () => {
  const w = await world()
  const map = w.ctx.contextMap
  const claimed = await map.claim(w.owner)
  expect((await map.view(w.owner)).indexChanged).toBe(true)
  await map.release(w.owner)
  w.write('AGENTS.md', '# New instructions\n\nRead the updated rules.\n')
  await map.acknowledgeIndex(w.owner, { indexDigest: claimed.observedIndexDigest })
  expect((await map.view(w.owner)).indexChanged).toBe(true)
  const other = await w.spawnRoot('other-curator')
  await map.claim(w.owner, { holderId: other.id })
  const snapshot = map.snapshotOf(w.owner)
  await expect(map.acknowledgeIndex(w.owner, { indexDigest: claimed.observedIndexDigest }))
    .rejects.toMatchObject({ code: 'CONTEXT_MAP_UNAUTHORIZED' })
  expect(map.snapshotOf(w.owner)).toEqual(snapshot)
})


it('recovers legacy claim snapshots as unacknowledged until an explicit completion event', async () => {
  const w = await world()
  const map = w.ctx.contextMap
  const claim = await map.claim(w.owner)
  const legacy = { ...map.snapshotOf(w.owner), revision: 2, indexDigest: claim.observedIndexDigest ?? claim.indexDigest }
  w.owner.session.append('context-map/state', { version: 1, op: { kind: 'claim', actor: w.owner.id }, snapshot: legacy })
  expect((await map.view(w.owner)).indexChanged).toBe(true)
  await map.acknowledgeIndex(w.owner, { indexDigest: claim.observedIndexDigest })
  expect((await map.view(w.owner)).indexChanged).toBe(false)
  const events = w.owner.session.snapshotEvents()
  const replay = events.reduce<ContextMapProjectionState>((state, event) => contextMapProjectionDefinition.apply(state, event),
    contextMapProjectionDefinition.init(w.owner.session.header))
  expect(replay.snapshot).toEqual(map.snapshotOf(w.owner))
})
