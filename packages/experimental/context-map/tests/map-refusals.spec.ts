/**
 * Refusals and failures of the map service seen by its callers: authorization, missing targets, bounds,
 * stale callers, a disposed service, a map written under a larger view budget, and a failing observer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextSectionId } from '@deepseek-ai/dsh-experimental-context-index/types'
import type { MapGroupId, MapNoteId, MapPendingId, MapSnapshot } from '../src/index.ts'
import { disposeWorlds, preStep, world, type World } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

const toolsGroup = (name: string) => ({ path: `Tools/Global/${name}`, title: name, summary: `Use for ${name}.`, tools: [`${name}_tool`] })

/** Claim the role for the owner and create one tools group per name. */
async function withGroups(options: Parameters<typeof world>[0], ...names: string[]) {
  const w = await world(options)
  const map = w.ctx.contextMap
  await map.claim(w.owner)
  const groups: MapGroupId[] = []
  let revision = map.snapshotOf(w.owner).revision
  for (const name of names) {
    const set = await map.setGroup(w.owner, { expectedRevision: revision, group: toolsGroup(name) })
    revision = set.revision
    groups.push(set.groups.at(-1)!.id)
  }
  return { w, map, groups, revision: () => map.snapshotOf(w.owner).revision }
}

describe('claim and release', () => {
  it('refuses a claim whose expected holder is not the holder, naming who holds the role', async () => {
    const w = await world()
    const map = w.ctx.contextMap
    const stranger = SessionId('stranger')
    await expect(map.claim(w.owner, { expectedHolder: stranger })).rejects.toMatchObject({
      code: 'CONTEXT_MAP_CONFLICT', message: expect.stringContaining('held by nobody'),
    })
    await map.claim(w.owner)
    await expect(map.claim(w.owner, { expectedHolder: stranger })).rejects.toMatchObject({
      code: 'CONTEXT_MAP_CONFLICT', message: expect.stringContaining(`held by ${w.owner.id}`),
    })
    await expect(map.claim(w.owner, { expectedHolder: w.owner.id })).resolves.toMatchObject({ curatorId: w.owner.id })
  })

  it('refuses a claim on the map of an owner that is not live', async () => {
    const w = await world()
    await expect(w.ctx.contextMap.claim(w.owner, { rootSessionId: SessionId('nobody') })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
  })

  it('lets only the holder or the owner release, and only the owner return an unstarted claim', async () => {
    const w = await world()
    const map = w.ctx.contextMap
    const assistant = await w.spawnRoot('assistant')
    const bystander = await w.spawnRoot('bystander')
    await map.claim(w.owner, { holderId: assistant.id })
    await expect(map.release(bystander, { rootSessionId: w.owner.id })).rejects.toMatchObject({ code: 'CONTEXT_MAP_UNAUTHORIZED' })
    await expect(map.release(assistant, { rootSessionId: w.owner.id, unstartedWork: 'work' })).rejects.toMatchObject({
      code: 'CONTEXT_MAP_UNAUTHORIZED',
    })
    expect(map.curatorOf(w.owner)).toBe(assistant.id)
    await map.release(assistant, { rootSessionId: w.owner.id })
    expect(map.curatorOf(w.owner)).toBeNull()
  })

  it('answers a release of an unheld role with the current map and commits nothing', async () => {
    const w = await world()
    const map = w.ctx.contextMap
    await map.claim(w.owner)
    await map.release(w.owner)
    const before = map.snapshotOf(w.owner)
    const events = w.owner.session.snapshotEvents().length
    expect(await map.release(w.owner)).toEqual(before)
    expect(w.owner.session.snapshotEvents()).toHaveLength(events)
  })

  it('keeps a map unreadable to an agent outside its lineage that does not hold the role', async () => {
    const w = await world()
    const bystander = await w.spawnRoot('bystander')
    await expect(w.ctx.contextMap.view(bystander, { rootSessionId: w.owner.id })).rejects.toMatchObject({ code: 'CONTEXT_MAP_UNAUTHORIZED' })
  })

  it('knows no holder for a stale agent or a disposed service, and whether the recorded holder is live', async () => {
    const w = await world()
    const map = w.ctx.contextMap
    const assistant = await w.spawnRoot('assistant')
    expect(map.hasLiveCurator(w.owner)).toBe(false)
    await map.claim(w.owner, { holderId: assistant.id })
    expect(map.hasLiveCurator(w.owner)).toBe(true)
    expect(map.isCurator(assistant, w.owner.id)).toBe(true)
    expect(map.curatedRoots(assistant)).toEqual([w.owner.id])
    await w.disposeRoot(assistant)
    // The disposed holder's claim is still recorded until its end is logged, but nobody live holds it.
    expect(map.hasLiveCurator(w.owner)).toBe(false)
    expect(map.isCurator(assistant, w.owner.id)).toBe(false)
    expect(map.curatedRoots(assistant)).toEqual([])

    await map.claim(w.owner)
    expect(map.isCurator(w.owner)).toBe(true)
    await w.ctx.fiber.dispose()
    expect(map.isCurator(w.owner)).toBe(false)
    expect(map.curatedRoots(w.owner)).toEqual([])
    await expect(map.curationWork(w.owner)).rejects.toMatchObject({ code: 'CONTEXT_MAP_DISPOSED' })
  })
})

describe('group and note edits', () => {
  it('refuses to replace a group that does not exist', async () => {
    const { w, map, revision } = await withGroups({})
    await expect(map.setGroup(w.owner, {
      expectedRevision: revision(), group: { ...toolsGroup('alpha'), groupId: brandString<MapGroupId>('grp_missing') },
    })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
  })

  it('merges only two different groups of one root within the note bound, leaving the others as they were', async () => {
    const { w, map, groups, revision } = await withGroups({ map: { maxNotesPerGroup: 2 } }, 'alpha', 'beta', 'gamma')
    const [alpha, beta, gamma] = groups as [MapGroupId, MapGroupId, MapGroupId]
    const rules = await map.setGroup(w.owner, {
      expectedRevision: revision(),
      group: { path: 'Instructions/Project/rules', title: 'Rules', summary: 'Use for rules.', sections: await w.projectSections() },
    })
    const rulesId = rules.groups.at(-1)!.id
    await expect(map.mergeGroups(w.owner, { expectedRevision: revision(), from: alpha, into: alpha })).rejects.toMatchObject({
      code: 'CONTEXT_MAP_INVALID_INPUT', message: expect.stringContaining('two different groups'),
    })
    await expect(map.mergeGroups(w.owner, { expectedRevision: revision(), from: rulesId, into: alpha })).rejects.toMatchObject({
      code: 'CONTEXT_MAP_INVALID_INPUT', message: expect.stringContaining('same root'),
    })
    for (const [group, name] of [[alpha, 'a'], [beta, 'b']] as const) {
      for (const n of [1, 2]) {
        await map.addNote(w.owner, { expectedRevision: revision(), groupId: group, text: `${name}${n} fact`, cites: [`ref:${name}${n}`] })
      }
    }
    await expect(map.mergeGroups(w.owner, { expectedRevision: revision(), from: alpha, into: beta })).rejects.toMatchObject({
      code: 'CONTEXT_MAP_LIMIT',
    })
    await map.retireNote(w.owner, { expectedRevision: revision(), noteId: map.snapshotOf(w.owner).groups[0]!.notes[0]!.id })
    await map.retireNote(w.owner, { expectedRevision: revision(), noteId: map.snapshotOf(w.owner).groups[0]!.notes[0]!.id })
    const merged = await map.mergeGroups(w.owner, { expectedRevision: revision(), from: alpha, into: beta })
    expect(merged.groups.map(group => group.id)).toEqual([beta, gamma, rulesId])
    expect(merged.groups.find(group => group.id === beta)!.notes).toHaveLength(2)
  })

  it('finds, re-verifies, and retires a note in any group while the other notes and groups stay as they were', async () => {
    const { w, map, groups, revision } = await withGroups({}, 'alpha', 'beta')
    const [alpha, beta] = groups as [MapGroupId, MapGroupId]
    for (const [group, text] of [[alpha, 'alpha fact'], [beta, 'beta one'], [beta, 'beta two']] as const) {
      await map.addNote(w.owner, { expectedRevision: revision(), groupId: group, text, cites: ['ref:evidence'] })
    }
    const textsOf = (id: MapGroupId) => map.snapshotOf(w.owner).groups.find(group => group.id === id)!.notes.map(note => note.text)
    const betaOne = map.snapshotOf(w.owner).groups[1]!.notes[0]!.id

    await map.verifyNote(w.owner, { expectedRevision: revision(), noteId: betaOne, text: 'beta one, rechecked' })
    expect(textsOf(alpha)).toEqual(['alpha fact'])
    expect(textsOf(beta)).toEqual(['beta one, rechecked', 'beta two'])

    await map.retireNote(w.owner, { expectedRevision: revision(), noteId: betaOne })
    expect(textsOf(alpha)).toEqual(['alpha fact'])
    expect(textsOf(beta)).toEqual(['beta two'])

    const missing = brandString<MapNoteId>('note_missing')
    await expect(map.verifyNote(w.owner, { expectedRevision: revision(), noteId: missing })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
    await expect(map.retireNote(w.owner, { expectedRevision: revision(), noteId: missing })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
  })

  it('files only a pending note that exists, within the citation bound', async () => {
    const { w, map, groups, revision } = await withGroups({}, 'alpha')
    await expect(map.filePending(w.owner, {
      expectedRevision: revision(), pendingId: brandString<MapPendingId>('pnd_missing'), groupId: groups[0]!,
    })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
    await map.release(w.owner)
    const { id } = await map.note(w.owner, { text: 'A fact.', cites: ['ref:a', 'ref:b', 'ref:c', 'ref:d'] })
    await map.claim(w.owner)
    await expect(map.filePending(w.owner, {
      expectedRevision: revision(), pendingId: id, groupId: groups[0]!, cites: ['ref:e'],
    })).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT', message: expect.stringContaining('at most 4 citations') })
    await expect(map.filePending(w.owner, { expectedRevision: revision(), pendingId: id, groupId: groups[0]! })).resolves.toBeDefined()
  })

  it('reports a note whose cited section changed as curation work', async () => {
    const { w, map, groups, revision } = await withGroups({}, 'alpha')
    const testing = (await w.sections()).find(section => section.headingPath.includes('Testing'))!
    await map.addNote(w.owner, { expectedRevision: revision(), groupId: groups[0]!, text: 'Tests run with vitest.', cites: [testing.id] })
    await map.acknowledgeIndex(w.owner, { indexDigest: (await map.claim(w.owner)).observedIndexDigest })
    expect(await map.curationWork(w.owner)).toBeNull()
    w.write('AGENTS.md', '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest with the --run flag.\n')
    expect((await map.curationWork(w.owner))?.reasons).toEqual(expect.arrayContaining(['stale']))
  })
})

describe('view bounds of a map written under a larger budget', () => {
  /** Append a map the way a log written under a larger `maxViewBytes` would hold it. */
  function replayed(w: World, change: (current: MapSnapshot) => Omit<MapSnapshot, 'revision'>): void {
    const current = w.ctx.contextMap.snapshotOf(w.owner)
    const snapshot: MapSnapshot = { ...change(current), revision: current.revision + 1 }
    w.owner.session.append('context-map/state', { version: 1, op: { kind: 'group-set', actor: w.owner.id }, snapshot })
  }
  const group = (extra: object) => ({
    id: brandString<MapGroupId>('grp_big'), path: 'Tools/Global/big', title: 'Big', summary: 'Big.', sections: [], tools: [], notes: [], ...extra,
  })

  it('refuses a map whose metadata alone exceeds the budget', async () => {
    const w = await world()
    const core = Array.from({ length: 400 }, (_, i) => brandString<ContextSectionId>(`sec_${i.toString(16).padStart(16, '0')}`))
    replayed(w, current => ({ ...current, core }))
    await expect(w.ctx.contextMap.view(w.owner)).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT', message: expect.stringContaining('metadata') })
  })

  it('refuses a pending note that cannot be shown on a page', async () => {
    const w = await world()
    const big = { id: brandString<MapPendingId>('pnd_big'), text: 'x'.repeat(9000), cites: [], by: w.owner.id }
    replayed(w, current => ({ ...current, pending: [big] }))
    await expect(w.ctx.contextMap.view(w.owner)).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT', message: expect.stringContaining('pending note') })
  })

  it('refuses a group note that cannot be shown on a page', async () => {
    const w = await world()
    const note = { id: brandString<MapNoteId>('note_big'), text: 'x'.repeat(9000), cites: [{ kind: 'evidence' as const, ref: 'r' }] }
    replayed(w, current => ({ ...current, groups: [group({ notes: [note] })] }))
    const view = await w.ctx.contextMap.view(w.owner)
    expect(view.groups[0]).toMatchObject({ id: 'grp_big', notes: [], omittedNotes: 1 })
    await expect(w.ctx.contextMap.view(w.owner, { groupId: brandString<MapGroupId>('grp_big') })).rejects.toMatchObject({
      code: 'CONTEXT_MAP_LIMIT', message: expect.stringContaining('group note'),
    })
  })

  it('leaves a group that cannot be shown to a page that starts at it, and refuses that page', async () => {
    const w = await world()
    replayed(w, current => ({ ...current, groups: [group({ tools: ['x'.repeat(9000)] })] }))
    const first = await w.ctx.contextMap.view(w.owner)
    expect(first).toMatchObject({ groups: [], omittedGroups: 1, nextGroupAfter: '' })
    await expect(w.ctx.contextMap.view(w.owner, { groupAfter: '' })).rejects.toMatchObject({
      code: 'CONTEXT_MAP_LIMIT', message: expect.stringContaining('One group exceeds'),
    })
  })

  it('refuses a note continuation without the group it continues', async () => {
    const w = await world()
    await expect(w.ctx.contextMap.view(w.owner, { noteAfter: '' })).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
  })
})

describe('observers', () => {
  it('contains a failing watcher and tells the log', async () => {
    const w = await world()
    const warn = vi.spyOn(w.ctx.logger, 'warn').mockImplementation(() => undefined)
    const unwatch = w.ctx.contextMap.watch(() => { throw new Error('watcher broke') })
    try {
      await expect(w.ctx.contextMap.note(w.owner, { text: 'A fact.' })).resolves.toMatchObject({ pending: 1 })
    } finally { unwatch() }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('watcher failed: Error: watcher broke'))
  })

  it('logs a failed index observation at an owner step and lets the step go on', async () => {
    const w = await world()
    const warn = vi.spyOn(w.ctx.logger, 'warn').mockImplementation(() => undefined)
    vi.spyOn(w.ctx.contextIndex, 'latest').mockImplementationOnce(() => { throw new Error('index unreadable') })
    await expect(preStep(w.ctx, w.owner)).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('index observation failed: Error: index unreadable'))
  })

  it('does not log an index observation canceled with its step', async () => {
    const w = await world()
    const warn = vi.spyOn(w.ctx.logger, 'warn').mockImplementation(() => undefined)
    const stop = new AbortController()
    vi.spyOn(w.ctx.contextIndex, 'latest').mockImplementationOnce(() => {
      stop.abort(new Error('step canceled'))
      throw new Error('index unreadable')
    })
    await expect(agentEvents(w.ctx, w.owner).waterfall(
      'agent/pre-step',
      { modelSelection: { provider: 'mock', model: 'big' }, messages: [], turn: 1, step: 2, signal: stop.signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).rejects.toThrow('step canceled')
    expect(warn).not.toHaveBeenCalled()
  })

  it('ignores a map event of a Session whose agent is gone', async () => {
    const w = await world()
    const bare = w.ctx.sessions.create(SessionId('bare'))
    const snapshot: MapSnapshot = {
      ownerSessionId: bare.id, revision: 1, curatorId: bare.id, route: null, indexDigest: null, core: [], groups: [], pending: [],
    }
    bare.append('context-map/state', { version: 1, op: { kind: 'claim', actor: bare.id }, snapshot })
    expect(w.ctx.contextMap.hasLiveCurator(w.owner)).toBe(false)
    expect(w.ctx.agents.get(bare.id)).toBeUndefined()
  })
})
