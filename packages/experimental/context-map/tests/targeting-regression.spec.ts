import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { resolveConfig } from '../src/config.ts'
import { call, disposeWorlds, preStep, textOf, world } from './fixture.ts'

afterEach(disposeWorlds)

it('R3-M1 a root agent that holds another map still files its own context_note into its own map', async () => {
  const w = await world()
  const other = await w.spawnRoot('other-owner')
  const assistant = await w.spawnRoot('assistant')
  await w.ctx.contextMap.claim(other, { holderId: assistant.id })
  const result = await call(w, assistant, 'context_note', { text: 'The assistant found where builds live.', cites: ['ref:scripts/build.ts'] })
  expect(result.isError, textOf(result)).toBe(false)
  expect({
    own: w.ctx.contextMap.snapshotOf(assistant).pending.map(note => note.text),
    held: w.ctx.contextMap.snapshotOf(other).pending.map(note => note.text),
  }, 'context_note from the root of a lineage targets that root\'s map').toEqual({
    own: ['The assistant found where builds live.'],
    held: [],
  })
})

it('R3-M1b a root agent that holds two maps can still call context_note for its own map', async () => {
  const w = await world()
  const first = await w.spawnRoot('first-owner')
  const second = await w.spawnRoot('second-owner')
  const assistant = await w.spawnRoot('assistant')
  await w.ctx.contextMap.claim(first, { holderId: assistant.id })
  await w.ctx.contextMap.claim(second, { holderId: assistant.id })
  const result = await call(w, assistant, 'context_note', { text: 'A fact about the assistant project.', cites: ['ref:README.md'] })
  expect(result.isError, `context_note has no root_session_id parameter; got: ${textOf(result)}`).toBe(false)
  expect(w.ctx.contextMap.snapshotOf(assistant).pending).toHaveLength(1)
})

it.each([1, 2])('the default curator services its own map while the owner holds %i other maps', async (heldCount) => {
  const w = await world({ curator: {}, script: [textResponse('Done.')] })
  const other = await w.spawnRoot('other-owner')
  const assistant = await w.spawnRoot('assistant')
  const second = heldCount === 2 ? await w.spawnRoot('second-owner') : undefined
  // The assistant's own map still names a holder from before a restart.
  await w.ctx.contextMap.claim(assistant, { holderId: SessionId('curator-before-restart') })
  await w.ctx.contextMap.claim(other, { holderId: assistant.id })
  if (second !== undefined) await w.ctx.contextMap.claim(second, { holderId: assistant.id })
  const claim = vi.spyOn(w.ctx.contextMap, 'claim')
  const view = vi.spyOn(w.ctx.contextMap, 'view')
  const release = vi.spyOn(w.ctx.contextMap, 'release')
  const released = Promise.withResolvers<string>()
  const started = Promise.withResolvers<undefined>()
  const unwatch = w.ctx.contextMap.watch((change) => {
    if (change.kind === 'committed' && (change.ownerSessionId === assistant.id || change.ownerSessionId === other.id)) {
      released.resolve(change.ownerSessionId)
      const holder = w.ctx.contextMap.curatorOf(assistant)
      if (change.ownerSessionId === assistant.id && holder !== null && holder !== 'curator-before-restart') started.resolve(undefined)
    }
  })
  try {
    w.write('AGENTS.md', '# Project rules\n\nUse pnpm 10.\n')
    await preStep(w.ctx, assistant)
    expect(release.mock.calls.map(([owner, target]) => ({ owner: owner.id, target })))
      .toContainEqual({ owner: assistant.id, target: { rootSessionId: assistant.id } })
    const firstCommit = await released.promise
    await started.promise
    await w.ctx.contextCurator.idle(assistant.id)
    expect(claim.mock.calls.map(([owner, request]) => ({ owner: owner.id, target: request?.rootSessionId })))
      .toContainEqual({ owner: assistant.id, target: assistant.id })
    expect(view.mock.calls.map(([owner, target]) => ({ owner: owner.id, target })))
      .toContainEqual({ owner: assistant.id, target: { rootSessionId: assistant.id } })
    expect(release.mock.calls.map(([owner, target]) => ({ owner: owner.id, target })))
      .toContainEqual({ owner: assistant.id, target: { rootSessionId: assistant.id } })
    if (second !== undefined) expect(w.ctx.contextMap.curatorOf(second)).toBe(assistant.id)
    expect({
      firstCommit,
      heldByAssistant: w.ctx.contextMap.curatorOf(other),
      ownHolder: w.ctx.contextMap.curatorOf(assistant),
    }, 'The stale holder of the assistant\'s own map is released, and its role on the other map is kept').toEqual({
      firstCommit: assistant.id,
      heldByAssistant: assistant.id,
      ownHolder: null,
    })
  } finally { unwatch(); vi.restoreAllMocks() }
})

it('rejects view budgets that cannot show a maximum-size pending note at load', async () => {
  expect(() => resolveConfig({ maxViewBytes: 1024 })).toThrow(/maxViewBytes/)
  const config = resolveConfig({})
  const w = await world({ map: config })
  await w.ctx.contextMap.note(w.owner, {
    text: '\u0001'.repeat(config.maxNoteBytes),
    cites: Array.from({ length: config.maxCitesPerNote }, (_, i) => `ref:${i}` + '\u0001'.repeat(config.maxEvidenceBytes - 1)),
  })
  await w.ctx.contextMap.claim(w.owner)
  const view = await w.ctx.contextMap.view(w.owner)
  expect(view.pending).toHaveLength(1)
  expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(config.maxViewBytes)
})

it('resolves untargeted reads and releases to the caller root while preserving explicitly targeted curator edits', async () => {
  const w = await world()
  const other = await w.spawnRoot('other-owner')
  const assistant = await w.spawnRoot('assistant')
  await w.ctx.contextMap.claim(other, { holderId: assistant.id })
  expect(w.ctx.contextMap.isCurator(assistant)).toBe(false)
  expect(w.ctx.contextMap.isCurator(assistant, other.id)).toBe(true)
  expect(w.ctx.contextMap.curatedRoots(assistant)).toEqual([other.id])
  await w.ctx.contextMap.claim(assistant)
  expect((await w.ctx.contextMap.view(assistant)).ownerSessionId).toBe(assistant.id)
  expect((await call(w, assistant, 'map_view')).isError).toBe(false)
  expect(JSON.parse(textOf(await call(w, assistant, 'map_view')))).toMatchObject({ ownerSessionId: assistant.id })
  expect(JSON.parse(textOf(await call(w, assistant, 'map_view', { root_session_id: other.id })))).toMatchObject({ ownerSessionId: other.id })
  const ownRevision = w.ctx.contextMap.snapshotOf(assistant).revision
  expect((await call(w, assistant, 'map_core', { expected_revision: ownRevision, sections: [] })).isError).toBe(false)
  expect(w.ctx.contextMap.snapshotOf(other).revision).toBe(1)
  await w.ctx.contextMap.release(assistant)
  expect(w.ctx.contextMap.curatorOf(assistant)).toBeNull()
  expect(w.ctx.contextMap.curatorOf(other)).toBe(assistant.id)
})

it('rejects an oversized group header before it can make a group page unreachable', async () => {
  const w = await world()
  await w.ctx.contextMap.claim(w.owner)
  const before = w.ctx.contextMap.snapshotOf(w.owner)
  await expect(w.ctx.contextMap.setGroup(w.owner, {
    expectedRevision: before.revision,
    group: { path: 'Tools/Global/large', title: 'Large', summary: 'Use for large tools.', tools: ['x'.repeat(9000)] },
  })).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT' })
  expect(w.ctx.contextMap.snapshotOf(w.owner)).toEqual(before)
})
