import { afterEach, expect, it, vi } from 'vitest'
import { DefaultContextCurator } from '../src/curator.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { resolveConfig } from '../src/config.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { call, disposeWorlds, SIGNAL, textOf, world } from './fixture.ts'

afterEach(disposeWorlds)

it.each(['file', 'drop'] as const)('pending pages stay complete when the curator files or drops notes between pages with %s', async (action) => {
  const w = await world()
  for (let i = 0; i < 16; i++) {
    await w.ctx.contextMap.note(w.owner, { text: `${i} ` + '界'.repeat(130), cites: ['ref:' + '界'.repeat(66)] })
  }
  await w.ctx.contextMap.claim(w.owner)
  const group = await w.ctx.contextMap.setGroup(w.owner, { expectedRevision: 17, group: { path: 'Tools/Global/facts', title: 'Facts', summary: 'Use for facts.', tools: ['facts_tool'] } })
  const first = await w.ctx.contextMap.view(w.owner)
  expect(first.nextPendingAfter).toEqual(expect.any(String))
  let revision = first.revision
  for (const note of first.pending) {
    revision = (action === 'drop' || revision - first.revision >= 8
      ? await w.ctx.contextMap.dropPending(w.owner, { expectedRevision: revision, pendingId: note.id })
      : await w.ctx.contextMap.filePending(w.owner, {
        expectedRevision: revision, pendingId: note.id, groupId: group.groups[0]!.id,
      })).revision
  }
  const remaining = w.ctx.contextMap.snapshotOf(w.owner).pending.map(note => note.id).toSorted()
  expect(remaining.length).toBeGreaterThan(0)
  const next = await w.ctx.contextMap.view(w.owner, { pendingAfter: first.nextPendingAfter! })
  expect(next.pending.map(note => note.id), 'The continuation page must list the notes not yet shown').toEqual(remaining)
})

it('R2-M2 every group of a map within maxSnapshotBytes is reachable through map_view', async () => {
  const w = await world()
  await w.ctx.contextMap.claim(w.owner)
  let revision = 1
  for (const name of ['alpha', 'beta', 'gamma']) {
    const set = await w.ctx.contextMap.setGroup(w.owner, {
      expectedRevision: revision,
      group: { path: `Tools/Global/${name}`, title: name, summary: `Use for ${name}.`, tools: [`${name}_tool`] },
    })
    revision = set.revision
    const groupId = set.groups.at(-1)!.id
    for (let i = 0; i < 8; i++) {
      revision = (await w.ctx.contextMap.addNote(w.owner, {
        expectedRevision: revision, groupId, text: `${name} ${i} ` + 'n'.repeat(380), cites: Array.from({ length: 4 }, (_, n) => `ref:${name}-${i}-${n}-` + 'e'.repeat(180)),
      })).revision
    }
  }
  for (let i = 0; i < 16; i++) await w.ctx.contextMap.note(w.owner, { text: '界'.repeat(130), cites: ['ref:' + '界'.repeat(66)] })
  const snapshot = w.ctx.contextMap.snapshotOf(w.owner)
  expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(65_536)
  let view = await w.ctx.contextMap.view(w.owner)
  expect(view).toHaveProperty('nextGroupAfter')
  const reached = [...view.groups]
  while (view.nextGroupAfter !== null) {
    view = await w.ctx.contextMap.view(w.owner, { groupAfter: view.nextGroupAfter })
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(8192)
    reached.push(...view.groups)
  }
  expect(reached.map(group => group.id).toSorted()).toEqual(snapshot.groups.map(group => group.id).toSorted())
  for (const group of reached) {
    const notes = [...group.notes]
    let after = group.nextNoteAfter
    while (after !== null) {
      const page = await w.ctx.contextMap.view(w.owner, { groupId: group.id, noteAfter: after })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192)
      notes.push(...page.groups[0]!.notes)
      after = page.groups[0]!.nextNoteAfter
    }
    expect(notes.map(note => note.id).toSorted())
      .toEqual(snapshot.groups.find(entry => entry.id === group.id)!.notes.map(note => note.id).toSorted())
  }
})

it('R2-M3 a grant path the harness logged still loads after the curator regroups the section', async () => {
  const w = await world()
  const [first, second] = await w.projectSections()
  const path = `Instructions/Project/AGENTS.md/${first!}`
  const loaded = await w.ctx.contextTree.load(w.owner, { paths: [path] })
  expect(loaded.result.granted).toHaveLength(1)
  const source = loaded.contexts[0]!.source
  expect(source.kind === 'context-grant' ? source.path : undefined).toBe(path)
  await w.ctx.contextMap.claim(w.owner)
  await w.ctx.contextMap.setGroup(w.owner, {
    expectedRevision: 1,
    group: { path: 'Instructions/Project/rules', title: 'Rules', summary: 'Use for project rules.', sections: [first!, second!] },
  })
  const reload = await w.ctx.contextTree.load(w.owner, { paths: [path] })
  expect(reload.result.missing, 'The logged reload path must still name the section').toEqual([])
  expect(reload.result.granted).toHaveLength(1)
})

it('R2-M3b a tool node the harness logged still loads after the curator regroups its tools', async () => {
  const w = await world()
  for (const name of ['deploy_run', 'deploy_status']) {
    w.ctx.tools.register(defineTool({
      name, description: `The ${name} tool.`, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('ok'),
    }), { origin: 'global' })
  }
  const loaded = await w.ctx.contextTree.load(w.owner, { paths: ['Tools/Global/deploy'] })
  expect(loaded.result.activated).toEqual([{ path: 'Tools/Global/deploy', tools: ['deploy_run', 'deploy_status'] }])
  await w.ctx.contextMap.claim(w.owner)
  await w.ctx.contextMap.setGroup(w.owner, {
    expectedRevision: 1,
    group: { path: 'Tools/Global/release', title: 'Release', summary: 'Use to ship.', tools: ['deploy_run', 'deploy_status'] },
  })
  for (const message of loaded.contexts) w.owner.session.append('user/message', message, { surfaceOp: 'append' })
  const reload = await w.ctx.contextTree.load(w.owner, { paths: ['Tools/Global/deploy'] })
  expect(reload.result.missing, 'The logged activation node must still resolve').toEqual([])
})

it('R2-m1 an agent holding two maps can be released from both when it is disposed', async () => {
  const w = await world()
  const other = await w.spawnRoot('other-owner')
  const assistant = await w.spawnRoot('assistant')
  await w.ctx.contextMap.claim(w.owner, { holderId: assistant.id })
  await w.ctx.contextMap.claim(other, { holderId: assistant.id })
  expect((await call(w, assistant, 'map_core', { root_session_id: other.id, expected_revision: 1, sections: [] })).isError).toBe(false)
  expect(w.ctx.contextMap.snapshotOf(other).revision).toBe(2)
  const target = { root_session_id: other.id }
  expect((await call(w, assistant, 'map_group', {
    ...target, action: 'set', expected_revision: 2, path: 'Tools/Global/other', title: 'Other', summary: 'Use for other work.', tools: ['other_tool'],
  })).isError).toBe(false)
  const groupId = w.ctx.contextMap.snapshotOf(other).groups[0]!.id
  expect((await call(w, assistant, 'map_note', {
    ...target, action: 'add', expected_revision: 3, group_id: groupId, text: 'A checked fact.', cites: ['ref:checked'],
  })).isError).toBe(false)
  const view = await call(w, assistant, 'map_view', target)
  expect(view.isError).toBe(false)
  expect(JSON.parse(textOf(view))).toMatchObject({ ownerSessionId: other.id, revision: 4, groups: [{ notes: [{ text: 'A checked fact.' }] }] })
  expect(w.ctx.contextMap.snapshotOf(w.owner).revision).toBe(1)
  const gone: string[] = []
  const unwatch = w.ctx.contextMap.watch((change) => { if (change.kind === 'holder-gone') gone.push(change.ownerSessionId) })
  try {
    await w.disposeRoot(assistant)
    expect([w.ctx.contextMap.curatorOf(w.owner), w.ctx.contextMap.curatorOf(other)]).toEqual([null, null])
    expect(gone.toSorted()).toEqual([w.owner.id, other.id].toSorted())
  } finally { unwatch() }
})

it('R2-m2 resolving one agent\'s tools does not scan other live agents', async () => {
  const w = await world()
  for (let i = 0; i < 10; i++) await w.spawnRoot(`bystander-${i}`)
  await w.ctx.tools.resolve({ agent: w.owner, modelSelection: { provider: 'mock', model: 'big' }, signal: SIGNAL })
  const list = vi.spyOn(w.ctx.agents, 'list')
  try {
    await w.ctx.tools.resolve({ agent: w.owner, modelSelection: { provider: 'mock', model: 'big' }, signal: SIGNAL })
    expect(list.mock.calls.length, 'Holder lookups per tool resolution for a non-curator agent').toBe(0)
  } finally { list.mockRestore() }
})


it('rejects a view budget that cannot hold map metadata at load', () => {
  expect(() => resolveConfig({ maxViewBytes: 256 })).toThrow(/maxViewBytes/)
})


it('restarts the default curator when a full pending queue rejects another note', async () => {
  const w = await world({ map: { maxPendingNotes: 1 }, script: [textResponse('Done.')] })
  await w.ctx.contextMap.note(w.owner, { text: 'A fact to check.' })
  await w.ctx.plugin(DefaultContextCurator)
  const started = Promise.withResolvers<undefined>()
  const unwatch = w.ctx.contextMap.watch(() => {
    if (w.ctx.contextMap.curatorOf(w.owner) !== null) started.resolve(undefined)
  })
  try {
    await expect(w.ctx.contextMap.note(w.owner, { text: 'Another fact.' })).rejects.toMatchObject({ code: 'CONTEXT_MAP_LIMIT' })
    await started.promise
    await w.ctx.contextCurator.idle(w.owner.id)
    expect(w.adapter.requests).toHaveLength(1)
    expect(w.ctx.contextMap.curatorOf(w.owner)).toBeNull()
  } finally { unwatch() }
})


it('accepts a small-note view budget with UUID holders and eight core ids and rejects insufficient core metadata budgets', async () => {
  expect(() => resolveConfig({ maxViewBytes: 1024, maxCoreSections: 100 })).toThrow(/maxViewBytes/)
  const w = await world({ map: { maxViewBytes: 1049, maxNoteBytes: 16, maxCitesPerNote: 1, maxEvidenceBytes: 8 } })
  w.write('AGENTS.md', Array.from({ length: 8 }, (_, i) => `${i === 0 ? '#' : '##'} Rule ${i}\n\nRule text.\n`).join('\n'))
  const owner = await w.spawnRoot('11111111-1111-4111-8111-111111111111')
  const holder = await w.spawnRoot('22222222-2222-4222-8222-222222222222')
  await w.ctx.contextMap.claim(owner, { holderId: holder.id })
  const sections = await w.projectSections()
  expect(sections).toHaveLength(8)
  await w.ctx.contextMap.setCore(holder, { rootSessionId: owner.id, expectedRevision: 1, sections })
  const view = await w.ctx.contextMap.view(holder, { rootSessionId: owner.id })
  expect(view.core).toHaveLength(8)
  expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(1024)
})
