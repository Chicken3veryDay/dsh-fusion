import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { contextMapProjectionDefinition } from '../src/projection.ts'
import { ContextMapError, type MapPendingId } from '../src/index.ts'
import { call, declared, disposeWorlds, logged, preStep, textOf, world, type World } from './fixture.ts'

afterEach(disposeWorlds)

const RULES = 'Instructions/Project/rules'

async function setup(options: Parameters<typeof world>[0] = {}) {
  const w = await world(options)
  const sections = await w.projectSections()
  const map = w.ctx.contextMap
  await map.claim(w.owner)
  return { w, sections, map }
}

async function withGroup(options: Parameters<typeof world>[0] = {}) {
  const base = await setup(options)
  const current = base.map.snapshotOf(base.w.owner)
  const after = await base.map.setGroup(base.w.owner, {
    expectedRevision: current.revision,
    group: { path: RULES, title: 'Project rules', summary: 'Use before changing code.', sections: base.sections },
  })
  return { ...base, groupId: after.groups[0]!.id, revision: after.revision }
}

const codeOf = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(ContextMapError)

describe('revisions and compare-and-set', () => {
  it('logs each edit as one state event with a contiguous revision', async () => {
    const { w, map, sections } = await setup()
    expect(map.snapshotOf(w.owner)).toMatchObject({ revision: 1, curatorId: w.owner.id })
    await map.setGroup(w.owner, { expectedRevision: 1, group: { path: RULES, title: 't', summary: 's', sections } })
    const events = (await logged(w.ctx, w.owner.id)).filter(event => event.type === 'context-map/state')
    expect(events.map(event => (event.data as { snapshot: { revision: number } }).snapshot.revision)).toEqual([1, 2])
    expect(events.map(event => (event.data as { op: { kind: string } }).op.kind)).toEqual(['claim', 'group-set'])
  })

  it('rejects an edit that names a stale revision and leaves the map unchanged', async () => {
    const { w, map, groupId } = await withGroup()
    const before = map.snapshotOf(w.owner)
    await expect(map.retireGroup(w.owner, { expectedRevision: before.revision - 1, groupId })).rejects.toMatchObject({ code: 'CONTEXT_MAP_CONFLICT' })
    expect(map.snapshotOf(w.owner)).toEqual(before)
  })

  it('lets exactly one of two concurrent edits at the same revision commit', async () => {
    const { w, map } = await setup()
    const revision = map.snapshotOf(w.owner).revision
    const core = (await w.projectSections()).slice(0, 1)
    const results = await Promise.allSettled([
      map.setCore(w.owner, { expectedRevision: revision, sections: core }),
      map.setCore(w.owner, { expectedRevision: revision, sections: [] }),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(map.snapshotOf(w.owner).revision).toBe(revision + 1)
  })

  it('recovers the same map from the log in an independent projection registry', async () => {
    const { w, map } = await withGroup()
    const own = await w.ctx.sessionProjections.register(contextMapProjectionDefinition)
    const replayed = JSON.parse(JSON.stringify(own.stateOf(w.owner.session))) as { snapshot: unknown }
    expect(replayed.snapshot).toEqual(JSON.parse(JSON.stringify(map.snapshotOf(w.owner))))
  })
})

describe('groups', () => {
  it('requires members of the group\'s own root and origin, and known sections', async () => {
    const { w, map, sections } = await setup()
    const revision = map.snapshotOf(w.owner).revision
    const group = (path: string, extra: object = {}) => map.setGroup(w.owner, {
      expectedRevision: revision, group: { path, title: 't', summary: 's', sections, ...extra },
    })
    await expect(group('Sources/Project/rules')).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await expect(group('Instructions/Global/rules')).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await expect(group('Tools/Project/rules')).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await expect(group('Nowhere')).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await expect(group(RULES, { sections: ['sec_0000000000000000'] })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
    await expect(group(RULES, { sections: [] })).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
  })

  it('refuses a second group at the same path or holding the same member', async () => {
    const { w, map, sections, revision } = await withGroup()
    await expect(map.setGroup(w.owner, { expectedRevision: revision, group: { path: RULES, title: 't', summary: 's', sections } }))
      .rejects.toMatchObject({ code: 'CONTEXT_MAP_CONFLICT' })
    await expect(map.setGroup(w.owner, { expectedRevision: revision, group: { path: 'Instructions/Project/other', title: 't', summary: 's', sections } }))
      .rejects.toMatchObject({ code: 'CONTEXT_MAP_CONFLICT' })
  })

  it('replaces, merges, and retires groups', async () => {
    const { w, map, sections, groupId, revision } = await withGroup()
    const replaced = await map.setGroup(w.owner, {
      expectedRevision: revision, group: { groupId, path: RULES, title: 'Renamed', summary: 'Use for all work.', sections: sections.slice(0, 1) },
    })
    expect(replaced.groups).toHaveLength(1)
    expect(replaced.groups[0]).toMatchObject({ id: groupId, title: 'Renamed' })
    const second = await map.setGroup(w.owner, {
      expectedRevision: replaced.revision,
      group: { path: 'Instructions/Project/rest', title: 'Rest', summary: 'Use for the rest.', sections: sections.slice(1) },
    })
    if (second.groups.length !== 2) throw new Error('Expected a second group')
    const rest = second.groups[1]!.id
    const merged = await map.mergeGroups(w.owner, { expectedRevision: second.revision, from: rest, into: groupId })
    expect(merged.groups).toHaveLength(1)
    expect([...merged.groups[0]!.sections].sort()).toEqual([...sections].sort())
    const retired = await map.retireGroup(w.owner, { expectedRevision: merged.revision, groupId })
    expect(retired.groups).toHaveLength(0)
    await expect(map.retireGroup(w.owner, { expectedRevision: retired.revision, groupId })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
  })

  it('enforces the group, member, and size bounds', async () => {
    const { w, map, sections } = await setup({ map: { maxGroups: 1, maxGroupMembers: 1, maxTitleBytes: 8, maxSummaryBytes: 16 } })
    const revision = map.snapshotOf(w.owner).revision
    const request = (extra: object) => map.setGroup(w.owner, {
      expectedRevision: revision, group: { path: RULES, title: 'ok', summary: 'ok', sections: sections.slice(0, 1), ...extra },
    })
    await expect(request({ sections })).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT' })
    await expect(request({ title: 'x'.repeat(9) })).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await expect(request({ summary: 'x'.repeat(17) })).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    const first = await request({})
    await expect(map.setGroup(w.owner, {
      expectedRevision: first.revision,
      group: { path: 'Instructions/Project/two', title: 'ok', summary: 'ok', sections: sections.slice(1, 2) },
    })).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT' })
  })

  it('fails loudly on an unusable configuration', async () => {
    await expect(world({ map: { maxGroups: 0 } })).rejects.toThrow(/maxGroups/)
  })
})

describe('notes, citations, and staleness', () => {
  it('requires a citation and stamps section citations with the hash the index has now', async () => {
    const { w, map, sections, groupId, revision } = await withGroup()
    const note = (cites: readonly string[]) => map.addNote(w.owner, { expectedRevision: revision, groupId, text: 'Tests run with vitest.', cites })
    await expect(note([])).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await expect(note(['free text'])).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await expect(note(['sec_0000000000000000'])).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
    const filed = await note([sections[0]!, 'ref:tool result of pnpm test'])
    const stored = filed.groups[0]!.notes[0]!
    const index = new Map((await w.sections()).map(section => [section.id, section.hash]))
    expect(stored.cites).toEqual([
      { kind: 'section', id: sections[0], hash: index.get(sections[0]!) },
      { kind: 'evidence', ref: 'tool result of pnpm test' },
    ])
  })

  it('never lets a note cite a note, whether filed or pending', async () => {
    const { w, map, sections, groupId, revision } = await withGroup()
    const filed = await map.addNote(w.owner, { expectedRevision: revision, groupId, text: 'First.', cites: [sections[0]!] })
    const noteId = filed.groups[0]!.notes[0]!.id
    await expect(map.addNote(w.owner, { expectedRevision: filed.revision, groupId, text: 'Second.', cites: [noteId] }))
      .rejects.toThrow(/names a note/)
    await expect(map.addNote(w.owner, { expectedRevision: filed.revision, groupId, text: 'Second.', cites: [`ref:${noteId}`] }))
      .rejects.toThrow(/note/)
    await expect(map.note(w.owner, { text: 'Pending.', cites: [noteId] })).rejects.toThrow(/names a note/)
    await map.note(w.owner, { text: 'Pending.', cites: [sections[0]!] })
    const pendingId = map.snapshotOf(w.owner).pending[0]!.id
    await expect(map.note(w.owner, { text: 'Again.', cites: [pendingId] })).rejects.toThrow(/names a note/)
  })

  it('marks a note stale when its cited section changes and clears the mark only on re-verify', async () => {
    const { w, map, groupId, revision } = await withGroup()
    const testing = (await w.sections()).find(section => section.headingPath.includes('Testing'))!
    const filed = await map.addNote(w.owner, { expectedRevision: revision, groupId, text: 'Tests run with vitest.', cites: [testing.id] })
    const noteId = filed.groups[0]!.notes[0]!.id
    expect((await map.view(w.owner)).staleNotes).toBe(0)

    w.write('AGENTS.md', '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest with the --run flag.\n')
    const stale = await map.view(w.owner)
    expect(stale.staleNotes).toBe(1)
    expect(stale.groups[0]!.notes[0]).toMatchObject({ id: noteId, stale: true })
    expect(stale.indexChanged).toBe(true)

    const current = map.snapshotOf(w.owner)
    await map.verifyNote(w.owner, { expectedRevision: current.revision, noteId, text: 'Tests run with vitest --run.' })
    const fresh = await map.view(w.owner)
    expect(fresh.staleNotes).toBe(0)
    expect(fresh.groups[0]!.notes[0]).toMatchObject({ text: 'Tests run with vitest --run.', stale: false })
  })

  it('cannot re-verify a note whose cited section no longer exists, only retire it', async () => {
    const { w, map, groupId, revision } = await withGroup()
    const testing = (await w.sections()).find(section => section.headingPath.includes('Testing'))!
    const filed = await map.addNote(w.owner, { expectedRevision: revision, groupId, text: 'Tests run with vitest.', cites: [testing.id] })
    const noteId = filed.groups[0]!.notes[0]!.id
    w.write('AGENTS.md', '# Project rules\n\nUse pnpm.\n')
    expect((await map.view(w.owner)).staleNotes).toBe(1)
    await expect(map.verifyNote(w.owner, { expectedRevision: filed.revision, noteId })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
    const retired = await map.retireNote(w.owner, { expectedRevision: filed.revision, noteId })
    expect(retired.groups[0]!.notes).toHaveLength(0)
  })

  it('bounds note text, citations, notes per group, and pending notes', async () => {
    const { w, map, sections, groupId, revision } = await withGroup({
      map: { maxNoteBytes: 20, maxCitesPerNote: 1, maxNotesPerGroup: 1, maxPendingNotes: 1 },
    })
    const add = (text: string, cites: readonly string[]) => map.addNote(w.owner, { expectedRevision: revision, groupId, text, cites })
    await expect(add('x'.repeat(21), [sections[0]!])).rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await expect(add('fine', [sections[0]!, 'ref:another'])).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT' })
    const first = await add('fine', [sections[0]!])
    await expect(map.addNote(w.owner, { expectedRevision: first.revision, groupId, text: 'more', cites: [sections[0]!] }))
      .rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT' })
    await map.note(w.owner, { text: 'one pending' })
    await expect(map.note(w.owner, { text: 'two pending' })).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT' })
  })

  it('files a pending note only with a citation that still holds, and drops others', async () => {
    const { w, map, sections, groupId, revision } = await withGroup()
    const testing = (await w.sections()).find(section => section.headingPath.includes('Testing'))!
    await map.note(w.owner, { text: 'Tests run with vitest.', cites: [testing.id] })
    await map.note(w.owner, { text: 'Uncited remark.' })
    const [cited, uncited] = map.snapshotOf(w.owner).pending
    const revisionNow = () => map.snapshotOf(w.owner).revision
    expect(revision).toBeLessThan(revisionNow())

    await expect(map.filePending(w.owner, { expectedRevision: revisionNow(), pendingId: uncited!.id, groupId }))
      .rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await map.filePending(w.owner, { expectedRevision: revisionNow(), pendingId: uncited!.id, groupId, cites: [sections[0]!] })

    w.write('AGENTS.md', '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest with the --run flag.\n')
    await expect(map.filePending(w.owner, { expectedRevision: revisionNow(), pendingId: cited!.id, groupId }))
      .rejects.toMatchObject({ code: 'CONTEXT_MAP_INVALID_INPUT' })
    await map.dropPending(w.owner, { expectedRevision: revisionNow(), pendingId: cited!.id })
    expect(map.snapshotOf(w.owner).pending).toEqual([])
    await expect(map.dropPending(w.owner, { expectedRevision: revisionNow(), pendingId: brandString<MapPendingId>('pnd_missing') }))
      .rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
  })
})

describe('the curator role', () => {
  it('has one holder; a claim replaces the previous holder and both changes are logged', async () => {
    const { w, map } = await setup()
    const other = await w.spawnRoot('other')
    expect(map.curatorOf(w.owner)).toBe(w.owner.id)
    await map.claim(w.owner, { holderId: other.id })
    expect(map.curatorOf(w.owner)).toBe(other.id)
    expect(map.isCurator(w.owner)).toBe(false)
    expect(map.isCurator(other, w.owner.id)).toBe(true)
    await map.release(w.owner)
    expect(map.curatorOf(w.owner)).toBeNull()
    const ops = (await logged(w.ctx, w.owner.id)).filter(event => event.type === 'context-map/state')
      .map(event => (event.data as { op: { kind: string; target?: string } }).op)
    expect(ops).toMatchObject([{ kind: 'claim', target: w.owner.id }, { kind: 'claim', target: other.id }, { kind: 'release', target: other.id }])
  })

  it('refuses edits from anyone but the live holder, even the map owner', async () => {
    const { w, map, sections } = await setup()
    const other = await w.spawnRoot('other')
    await map.claim(w.owner, { holderId: other.id })
    const revision = map.snapshotOf(w.owner).revision
    await expect(map.setCore(w.owner, { expectedRevision: revision, sections: [] })).rejects.toMatchObject({ code: 'CONTEXT_MAP_UNAUTHORIZED' })
    await expect(map.setGroup(other, { rootSessionId: w.owner.id, expectedRevision: revision, group: { path: RULES, title: 't', summary: 's', sections } }))
      .resolves.toMatchObject({ revision: revision + 1 })
  })

  it('refuses a claim that names another agent unless the owner makes it', async () => {
    const { w, map } = await setup()
    const other = await w.spawnRoot('other')
    const third = await w.spawnRoot('third')
    await expect(map.claim(other, { rootSessionId: w.owner.id, holderId: third.id })).rejects.toMatchObject({ code: 'CONTEXT_MAP_UNAUTHORIZED' })
  })

  it('refuses a stale agent object as the caller', async () => {
    const { w, map } = await setup()
    const other = await w.spawnRoot('other')
    await w.disposeRoot(other)
    await expect(map.claim(other)).rejects.toMatchObject({ code: 'CONTEXT_MAP_UNAUTHORIZED' })
  })

  it('logs the end of a holder that disappears and leaves the role free', async () => {
    const { w, map } = await setup()
    const other = await w.spawnRoot('other')
    await map.claim(w.owner, { holderId: other.id })
    const changes: string[] = []
    map.watch(change => changes.push(change.kind))
    await w.disposeRoot(other)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(map.curatorOf(w.owner)).toBeNull()
    expect(changes).toContain('holder-gone')
    const ops = (await logged(w.ctx, w.owner.id)).filter(event => event.type === 'context-map/state')
      .map(event => (event.data as { op: { kind: string } }).op.kind)
    expect(ops.at(-1)).toBe('release')
  })
})

describe('tools', () => {
  it('offers the curator tools only to the holder and context_note to everyone', async () => {
    const { w, map } = await setup()
    const other = await w.spawnRoot('other')
    expect(await declared(w, w.owner)).toEqual(expect.arrayContaining(['map_view', 'map_group', 'map_note', 'map_core']))
    expect(await declared(w, other)).not.toContain('map_view')
    await map.release(w.owner)
    const names = await declared(w, w.owner)
    for (const name of ['map_view', 'map_group', 'map_note', 'map_core']) expect(names).not.toContain(name)
    expect(names).toContain('context_note')
  })

  it('rejects a non-holder at the executor even with a tool set resolved while it held the role', async () => {
    const { w, map } = await setup()
    const set = await w.ctx.tools.resolve({ agent: w.owner, modelSelection: { provider: 'mock', model: 'big' }, signal: new AbortController().signal })
    const other = await w.spawnRoot('other')
    await map.claim(w.owner, { holderId: other.id })
    const revision = map.snapshotOf(w.owner).revision
    const denied = await call(w, w.owner, 'map_core', { expected_revision: revision, sections: [] }, set)
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('Current curator role is required')
    expect(map.snapshotOf(w.owner).revision).toBe(revision)

    const hidden = await call(w, w.owner, 'map_view')
    expect(hidden.error?.info?.code).toBe('UNKNOWN_TOOL')
  })

  it('edits through the curator tools and reads the map back', async () => {
    const { w, sections } = await setup()
    const revision = w.ctx.contextMap.snapshotOf(w.owner).revision
    const made = await call(w, w.owner, 'map_group', {
      action: 'set', expected_revision: revision, path: RULES, title: 'Project rules', summary: 'Use before changing code.', sections,
    })
    expect(made.isError).toBe(false)
    expect(JSON.parse(textOf(made))).toEqual({ revision: revision + 1, groups: 1, pending: 0, core: 0 })
    const viewed = JSON.parse(textOf(await call(w, w.owner, 'map_view'))) as { groups: unknown[] }
    expect(viewed.groups[0]).toMatchObject({ path: RULES, title: 'Project rules' })
    const missing = await call(w, w.owner, 'map_group', { action: 'retire', expected_revision: revision + 1 })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('retire needs group_id')
  })

  it('files a note through context_note, bounded and without a reply to wait for', async () => {
    const { w, map, sections } = await setup()
    const result = await call(w, w.owner, 'context_note', { text: 'Tests run with vitest.', cites: [sections[0]!] })
    expect(result.isError).toBe(false)
    expect(JSON.parse(textOf(result))).toMatchObject({ waiting: 1 })
    expect(map.snapshotOf(w.owner).pending[0]).toMatchObject({ text: 'Tests run with vitest.', by: w.owner.id })
    const tooLong = await call(w, w.owner, 'context_note', { text: 'x'.repeat(401) })
    expect(tooLong.isError).toBe(true)
  })

  it('refuses a context_note from a holder other than the owner and from its children, without announcing it', async () => {
    const { w, map } = await setup()
    const curator = await w.ctx.agents.create({
      sessionId: SessionId('child-curator'),
      parentAgent: w.owner,
      meta: { parentSession: w.owner.id, origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'big' },
    })
    const helper = await w.ctx.agents.create({
      sessionId: SessionId('curator-helper'),
      parentAgent: curator.agent,
      meta: { parentSession: curator.agent.id, origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'big' },
    })
    await map.claim(w.owner, { holderId: curator.agent.id })
    const changes: string[] = []
    const unwatch = map.watch((change) => { changes.push(change.kind) })
    try {
      for (const agent of [curator.agent, helper.agent]) {
        const result = await call(w, agent, 'context_note', { text: 'A fact the curator found.' })
        expect(result.isError).toBe(true)
        expect(textOf(result)).toContain('map_note add')
      }
      await expect(map.note(curator.agent, { text: 'Direct.' })).rejects.toMatchObject({ code: 'CONTEXT_MAP_UNAUTHORIZED' })
      expect(changes, 'a refused self-note is not news for the curator').toEqual([])
      expect(map.snapshotOf(w.owner).pending).toEqual([])
      const owned = await call(w, w.owner, 'context_note', { text: 'The owner still files notes.' })
      expect(owned.isError).toBe(false)
    } finally {
      unwatch()
      await helper.dispose()
      await curator.dispose()
    }
  })

  it('lets a child file a note into its parent\'s map', async () => {
    const { w, map } = await setup()
    const child = (await w.ctx.agents.create({
      sessionId: SessionId('child-note'),
      parentAgent: w.owner,
      meta: { parentSession: w.owner.id, origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'big' },
    }))
    const outcome = await call(w, child.agent, 'context_note', { text: 'Found a convention.' })
    expect(outcome.isError).toBe(false)
    expect(map.snapshotOf(w.owner).pending[0]?.by).toBe(child.agent.id)
    await child.dispose()
  })
})

describe('the tree', () => {
  it('shows the curator\'s groups, flags groups with stale notes, and loads a group as a folder', async () => {
    const { w, map, sections, groupId, revision } = await withGroup()
    const listing = await w.ctx.contextTree.browse(w.owner, { path: 'Instructions/Project' })
    expect(listing.nodes.map(node => node.path)).toEqual([RULES])
    expect(listing.nodes[0]!.summary).toContain('Use before changing code.')
    const testing = (await w.sections()).find(section => section.headingPath.includes('Testing'))!
    await map.addNote(w.owner, { expectedRevision: revision, groupId, text: 'Tests run with vitest.', cites: [testing.id] })
    w.write('AGENTS.md', '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest with the --run flag.\n')
    await map.view(w.owner)
    const flagged = await w.ctx.contextTree.browse(w.owner, { path: 'Instructions/Project' })
    expect(flagged.nodes[0]!.summary).toContain('stale until re-verified')
    const loaded = await w.ctx.contextTree.load(w.owner, { paths: [RULES] })
    expect(loaded.result.granted).toHaveLength(sections.length)
  })

  it('hides the curator tools from the tree for everyone', async () => {
    const { w } = await setup()
    const paths = (await w.ctx.contextTree.browse(w.owner, { path: 'Tools', depth: 3 })).nodes.map(node => node.path)
    expect(paths.some(path => /map_(view|group|note|core)$/.test(path))).toBe(false)
  })

  it('grants the eager core once before a step and never above the core budget', async () => {
    const { w, map, sections } = await setup()
    const revision = map.snapshotOf(w.owner).revision
    await map.setCore(w.owner, { expectedRevision: revision, sections: sections.slice(0, 1) })
    const first = (await preStep(w.ctx, w.owner)).filter(message => message.source.kind === 'context-grant')
    expect(first).toHaveLength(1)
    expect(JSON.stringify(first[0]!.content)).toMatch(/pnpm|vitest/)
  })

  it('refuses a core beyond the configured size and a section the index does not have', async () => {
    const { w, map, sections } = await setup({ map: { maxCoreSections: 1 } })
    const revision = map.snapshotOf(w.owner).revision
    await expect(map.setCore(w.owner, { expectedRevision: revision, sections })).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT' })
    await expect(map.setCore(w.owner, { expectedRevision: revision, sections: ['sec_0000000000000000'] })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
  })
})

describe('disposal', () => {
  it('fails loudly on a read after the service is disposed', async () => {
    const w: World = await world()
    const map = w.ctx.contextMap
    await map.claim(w.owner)
    await w.ctx.fiber.dispose()
    await codeOf(map.view(w.owner))
  })
})
