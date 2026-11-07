/** Edit validation reached through the map service: group homes, member rules, and citation forms. */
import { afterEach, describe, expect, it } from 'vitest'
import { disposeWorlds, world } from './fixture.ts'

afterEach(disposeWorlds)

async function setup() {
  const w = await world()
  const map = w.ctx.contextMap
  await map.claim(w.owner)
  const sections = await w.sections()
  return { w, map, sections }
}

const idsOf = (sections: Awaited<ReturnType<typeof setup>>['sections'], kind: string): string[] => sections.filter(section => section.kind === kind).map(section => section.id)

describe('group homes', () => {
  it('groups the user file under Instructions/Global and documents under Sources/Project', async () => {
    const { w, map, sections } = await setup()
    const personal = await map.setGroup(w.owner, {
      expectedRevision: map.snapshotOf(w.owner).revision,
      group: { path: 'Instructions/Global/personal', title: 'Personal', summary: 'How the owner likes answers.', sections: idsOf(sections, 'user-instructions') },
    })
    const docs = await map.setGroup(w.owner, {
      expectedRevision: personal.revision,
      group: { path: 'Sources/Project/architecture', title: 'Architecture', summary: 'How the services fit.', sections: idsOf(sections, 'doc') },
    })
    expect(docs.groups.map(group => group.path)).toEqual(['Instructions/Global/personal', 'Sources/Project/architecture'])
  })

  it('names the home of a section placed under another origin', async () => {
    const { w, map, sections } = await setup()
    await expect(map.setGroup(w.owner, {
      expectedRevision: map.snapshotOf(w.owner).revision,
      group: { path: 'Instructions/Project/rules', title: 't', summary: 's', sections: idsOf(sections, 'user-instructions') },
    })).rejects.toThrow(/belongs under Instructions\/Global, not Instructions\/Project\/rules/)
  })

  it('refuses a tool in a section group, an unusable tool name, and an empty title', async () => {
    const { w, map, sections } = await setup()
    const revision = map.snapshotOf(w.owner).revision
    const project = idsOf(sections, 'project-instructions')
    await expect(map.setGroup(w.owner, { expectedRevision: revision, group: { path: 'Instructions/Project/rules', title: 't', summary: 's', sections: project, tools: ['deploy_run'] } }))
      .rejects.toThrow(/holds sections, not tools/)
    await expect(map.setGroup(w.owner, { expectedRevision: revision, group: { path: 'Tools/Project/ship', title: 't', summary: 's', tools: ['two words'] } }))
      .rejects.toThrow(/tool names must not be empty or hold whitespace/)
    await expect(map.setGroup(w.owner, { expectedRevision: revision, group: { path: 'Instructions/Project/rules', title: '  ', summary: 's', sections: project } }))
      .rejects.toThrow(/title must not be empty/)
  })

  it('reports a malformed section id as not in the index', async () => {
    const { w, map } = await setup()
    await expect(map.setGroup(w.owner, {
      expectedRevision: map.snapshotOf(w.owner).revision,
      group: { path: 'Instructions/Project/rules', title: 't', summary: 's', sections: ['bogus'] },
    })).rejects.toMatchObject({ code: 'CONTEXT_MAP_NOT_FOUND' })
  })
})

describe('citations', () => {
  async function grouped() {
    const base = await setup()
    const after = await base.map.setGroup(base.w.owner, {
      expectedRevision: base.map.snapshotOf(base.w.owner).revision,
      group: { path: 'Instructions/Project/rules', title: 'Rules', summary: 'Project rules.', sections: idsOf(base.sections, 'project-instructions') },
    })
    return { ...base, groupId: after.groups[0]!.id, revision: after.revision }
  }

  it('refuses an evidence reference shaped like a note id even when no such note exists', async () => {
    const { w, map, groupId, revision } = await grouped()
    await expect(map.addNote(w.owner, { expectedRevision: revision, groupId, text: 'Claim.', cites: ['ref:note_0123456789abcdef'] }))
      .rejects.toThrow(/evidence reference may not name a note/)
  })

  it('re-verifies a note that cites only evidence and keeps its citation', async () => {
    const { w, map, groupId, revision } = await grouped()
    const filed = await map.addNote(w.owner, { expectedRevision: revision, groupId, text: 'Tests ran green.', cites: ['ref:tool result of pnpm test'] })
    const noteId = filed.groups[0]!.notes[0]!.id
    const verified = await map.verifyNote(w.owner, { expectedRevision: filed.revision, noteId })
    expect(verified.groups[0]!.notes[0]!.cites).toEqual([{ kind: 'evidence', ref: 'tool result of pnpm test' }])
  })
})
