/** The curator tools: each action's arguments reach the map service, and a missing argument names itself. */
import { afterEach, describe, expect, it } from 'vitest'
import { call, disposeWorlds, SIGNAL, textOf, world, type World } from './fixture.ts'

afterEach(disposeWorlds)

async function curated() {
  const w = await world()
  const map = w.ctx.contextMap
  await map.claim(w.owner)
  const sections = await w.projectSections()
  return { w, map, sections }
}

/** Run a tool as the model would and parse its JSON result; a failed call throws with its text. */
async function run(w: World, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await call(w, w.owner, name, args)
  if (result.isError) throw new Error(textOf(result))
  return JSON.parse(textOf(result))
}

interface ViewJson {
  readonly pending: readonly { readonly id: string }[]
  readonly groups: readonly { readonly id: string; readonly notes: readonly { readonly id: string }[] }[]
}

const viewOf = async (w: World, args: Record<string, unknown>): Promise<ViewJson> => await run(w, 'map_view', args) as ViewJson

const revisionOf = (w: World): number => w.ctx.contextMap.snapshotOf(w.owner).revision

async function group(w: World, path: string, sections: readonly string[], extra: Record<string, unknown> = {}): Promise<string> {
  await run(w, 'map_group', {
    action: 'set', expected_revision: revisionOf(w), path, title: path.split('/').pop(), summary: `Use for ${path}.`, sections, ...extra,
  })
  return w.ctx.contextMap.snapshotOf(w.owner).groups.find(entry => entry.path === path)!.id
}

describe('map_group', () => {
  it('replaces a group by id, merges one group into another, and names a missing argument', async () => {
    const { w, map, sections } = await curated()
    const first = await group(w, 'Instructions/Project/rules', [sections[0]!])
    const second = await group(w, 'Instructions/Project/testing', [sections[1]!])

    await run(w, 'map_group', {
      action: 'set', expected_revision: revisionOf(w), group_id: first, path: 'Instructions/Project/rules', title: 'Renamed', summary: 'Use for renamed rules.', sections: [sections[0]!],
    })
    expect(map.snapshotOf(w.owner).groups.find(entry => entry.id === first)?.title).toBe('Renamed')

    await expect(run(w, 'map_group', { action: 'merge', expected_revision: revisionOf(w), group_id: first })).rejects.toThrow('merge needs from_group')
    expect(await run(w, 'map_group', { action: 'merge', expected_revision: revisionOf(w), group_id: first, from_group: second }))
      .toMatchObject({ groups: 1 })
    expect(map.snapshotOf(w.owner).groups[0]!.sections).toEqual(sections)
  })
})

describe('map_note', () => {
  it('adds, verifies, retires, files, and drops notes, and names a missing argument', async () => {
    const { w, map, sections } = await curated()
    const target = await group(w, 'Instructions/Project/rules', sections)
    const add = (extra: Record<string, unknown>) => run(w, 'map_note', { action: 'add', expected_revision: revisionOf(w), group_id: target, text: 'Tests run with vitest.', ...extra })

    await expect(add({})).rejects.toThrow(/citation/)
    await add({ cites: [sections[0]!] })
    const noteId = map.snapshotOf(w.owner).groups[0]!.notes[0]!.id
    await run(w, 'map_note', { action: 'verify', expected_revision: revisionOf(w), note_id: noteId })
    await run(w, 'map_note', { action: 'verify', expected_revision: revisionOf(w), note_id: noteId, text: 'Tests run with vitest --run.' })
    expect(map.snapshotOf(w.owner).groups[0]!.notes[0]!.text).toBe('Tests run with vitest --run.')
    await expect(run(w, 'map_note', { action: 'retire', expected_revision: revisionOf(w) })).rejects.toThrow('retire needs note_id')
    await run(w, 'map_note', { action: 'retire', expected_revision: revisionOf(w), note_id: noteId })
    expect(map.snapshotOf(w.owner).groups[0]!.notes).toEqual([])

    await map.note(w.owner, { text: 'First pending.', cites: [sections[0]!] })
    await map.note(w.owner, { text: 'Second pending.', cites: [sections[1]!] })
    const [filing, dropping] = map.snapshotOf(w.owner).pending.map(note => note.id)
    await run(w, 'map_note', { action: 'file', expected_revision: revisionOf(w), pending_id: filing, group_id: target, text: 'Filed with new text.', cites: [sections[1]!] })
    expect(map.snapshotOf(w.owner).groups[0]!.notes.map(note => note.text)).toEqual(['Filed with new text.'])
    await expect(run(w, 'map_note', { action: 'drop', expected_revision: revisionOf(w) })).rejects.toThrow('drop needs pending_id')
    await run(w, 'map_note', { action: 'drop', expected_revision: revisionOf(w), pending_id: dropping })
    expect(map.snapshotOf(w.owner).pending).toEqual([])
  })
})

describe('map_view', () => {
  it('pages pending notes, groups, and one group\'s notes from the cursors it is given', async () => {
    const { w, map, sections } = await curated()
    const first = await group(w, 'Instructions/Project/rules', [sections[0]!])
    const second = await group(w, 'Instructions/Project/testing', [sections[1]!])
    for (const text of ['Note one.', 'Note two.']) {
      await run(w, 'map_note', { action: 'add', expected_revision: revisionOf(w), group_id: first, text, cites: [sections[0]!] })
    }
    await map.note(w.owner, { text: 'First pending.', cites: [sections[0]!] })
    await map.note(w.owner, { text: 'Second pending.', cites: [sections[0]!] })
    const snapshot = map.snapshotOf(w.owner)
    const [pendingA, pendingB] = snapshot.pending.map(note => note.id).toSorted()
    const [groupA, groupB] = [first, second].toSorted()
    const notes = snapshot.groups.find(entry => entry.id === first)!.notes.map(note => note.id).toSorted()

    const afterPending = await viewOf(w, { pending_after: pendingA })
    expect(afterPending.pending.map(note => note.id)).toEqual([pendingB])
    const groupsOnly = await viewOf(w, { group_after: '' })
    expect({ pending: groupsOnly.pending, groups: groupsOnly.groups.map(entry => entry.id) })
      .toEqual({ pending: [], groups: [groupA, groupB] })
    const afterGroup = await viewOf(w, { group_after: groupA })
    expect(afterGroup.groups.map(entry => entry.id)).toEqual([groupB])
    const one = await viewOf(w, { group_id: first, note_after: '' })
    expect(one.groups[0]?.notes.map(note => note.id)).toEqual(notes)
    const rest = await viewOf(w, { group_id: first, note_after: notes[0] })
    expect(rest.groups[0]?.notes.map(note => note.id)).toEqual([notes[1]])
  })
})

describe('map_core', () => {
  it('sets the core from section ids', async () => {
    const { w, map, sections } = await curated()
    await run(w, 'map_core', { expected_revision: revisionOf(w), sections: [sections[1]!] })
    expect(map.snapshotOf(w.owner).core).toEqual([sections[1]])
  })
})

describe('tool callers', () => {
  it('refuses a call that carries no live agent', async () => {
    const { w } = await curated()
    const note = w.ctx.tools.get('context_note', w.owner)!
    await expect(note.execute({ text: 'A fact.' }, { signal: SIGNAL } as never)).rejects.toThrow('map tools require a live calling Agent')
  })
})
