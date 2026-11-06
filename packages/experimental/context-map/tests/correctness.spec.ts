import { afterEach, expect, it, vi } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ContextMapService from '../src/index.ts'
import { call, declared, disposeWorlds, world, SIGNAL } from './fixture.ts'

afterEach(disposeWorlds)

it('R4 map_view rechecks curator authority after handoff', async () => {
  const w = await world()
  await w.ctx.contextMap.claim(w.owner)
  const set = await w.ctx.tools.resolve({ agent: w.owner, modelSelection: { provider: 'mock', model: 'big' }, signal: SIGNAL })
  const assistant = await w.spawnRoot('assistant')
  await w.ctx.contextMap.claim(w.owner, { holderId: assistant.id })
  const result = await call(w, w.owner, 'map_view', {}, set)
  expect(result.isError, 'A former holder must not run a curator-only tool').toBe(true)
})

it('R5 role authority survives context-map plugin reload', async () => {
  const w = await world()
  const assistant = await w.spawnRoot('assistant')
  await w.ctx.contextMap.claim(w.owner, { holderId: assistant.id })
  expect(w.ctx.contextMap.isCurator(assistant, w.owner.id)).toBe(true)
  expect(await declared(w, assistant)).toContain('map_core')
  const fiber = [...w.ctx.registry.get(ContextMapService)!.fibers][0]!
  await fiber.dispose()
  await w.ctx.plugin(ContextMapService)
  expect(w.ctx.contextMap.snapshotOf(w.owner).curatorId).toBe(assistant.id)
  expect(w.ctx.contextMap.isCurator(assistant, w.owner.id), 'The durable role must recover its owner association').toBe(true)
  expect(await declared(w, assistant)).toContain('map_core')
  expect((await w.ctx.contextMap.view(assistant, { rootSessionId: w.owner.id })).ownerSessionId).toBe(w.owner.id)
  const gone = Promise.withResolvers<undefined>()
  const unwatch = w.ctx.contextMap.watch((change) => { if (change.kind === 'committed') gone.resolve(undefined) })
  try {
    await w.disposeRoot(assistant)
    await gone.promise
    expect(w.ctx.contextMap.curatorOf(w.owner)).toBeNull()
  } finally { unwatch() }
})

it('R6 map_view stays bounded when pending notes alone exceed the view budget', async () => {
  const w = await world()
  for (let i = 0; i < 16; i++) {
    await w.ctx.contextMap.note(w.owner, { text: '界'.repeat(133), cites: ['ref:' + '界'.repeat(66)] })
  }
  const view = await w.ctx.contextMap.view(w.owner)
  expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBeLessThanOrEqual(8192)
  expect(view.omittedPending).toBeGreaterThan(0)
  expect(view.nextPendingAfter).toBe(view.pending.at(-1)!.id)
  const next = await w.ctx.contextMap.view(w.owner, { pendingAfter: view.nextPendingAfter! })
  expect(Buffer.byteLength(JSON.stringify(next), 'utf8')).toBeLessThanOrEqual(8192)
  expect(next.nextPendingAfter).toBeNull()
  expect([...view.pending, ...next.pending].map(note => note.id))
    .toEqual(w.ctx.contextMap.snapshotOf(w.owner).pending.map(note => note.id).toSorted())
})

it('R7 grouping one section cannot hide another section at the same file path', async () => {
  const w = await world()
  const sections = await w.projectSections()
  expect(sections).toHaveLength(2)
  await w.ctx.contextMap.claim(w.owner)
  await w.ctx.contextMap.setGroup(w.owner, {
    expectedRevision: 1,
    group: { path: 'Instructions/Project/AGENTS.md', title: 'Rules', summary: 'Use for rules.', sections: [sections[0]!] },
  })
  const result = await w.ctx.contextTree.load(w.owner, { paths: ['Instructions/Project/AGENTS.md/' + sections[1]!] })
  expect(result.result.missing, 'An ungrouped section must remain reachable at its listed path').toEqual([])
  expect(result.result.granted).toHaveLength(1)
})

it('R8 a full-length group summary still exposes its stale marker', async () => {
  const w = await world()
  const sections = await w.projectSections()
  await w.ctx.contextMap.claim(w.owner)
  const grouped = await w.ctx.contextMap.setGroup(w.owner, {
    expectedRevision: 1,
    group: { path: 'Instructions/Project/rules', title: 'Rules', summary: 's'.repeat(160), sections },
  })
  await w.ctx.contextMap.addNote(w.owner, {
    expectedRevision: grouped.revision, groupId: grouped.groups[0]!.id,
    text: 'Use pnpm.', cites: [sections[0]!],
  })
  w.write('AGENTS.md', '# Project rules\n\nUse npm instead of pnpm.\n\n## Testing\n\nRun vitest.\n')
  const view = await w.ctx.contextMap.view(w.owner)
  expect(view.staleNotes).toBe(1)
  const listing = await w.ctx.contextTree.browse(w.owner, { path: 'Instructions/Project' })
  const summary = listing.nodes.find(node => node.path.endsWith('/rules'))!.summary
  expect(summary).toContain('stale')
  await expect(summary + '\n').toMatchFileSnapshot('./expected/stale-group-summary.txt')
})

it('R9 a curated group cannot overwrite a recorded project tool origin', async () => {
  const w = await world()
  w.ctx.tools.register(defineTool({
    name: 'project_only', description: 'A project-contributed tool.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve('ok'),
  }), { origin: 'project' })
  await w.ctx.contextMap.claim(w.owner)
  await w.ctx.contextMap.setGroup(w.owner, {
    expectedRevision: 1,
    group: { path: 'Tools/Global/moved', title: 'Moved', summary: 'Use for project work.', tools: ['project_only'] },
  })
  expect(w.ctx.tools.originOf('project_only', w.owner)).toBe('project')
  const result = await w.ctx.contextTree.browse(w.owner, { path: 'Tools/Project', depth: 2 })
  expect(result.nodes.map(node => node.title)).toContain('project_only')
})

it.each(['resolve', 'reject'] as const)('R12 curator shutdown cancels a pending catalog read with late %s', async (late) => {
  const w = await world({ curator: {} })
  const catalog = await w.adapter.listModels('mock')
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<typeof catalog>()
  vi.spyOn(w.adapter, 'listModels').mockImplementation(() => { entered.resolve(undefined); return gate.promise })
  await w.ctx.contextMap.note(w.owner, { text: 'Check this fact.' })
  await entered.promise
  const curator = w.ctx.contextCurator
  const disposal = w.curatorFiber!.dispose()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      disposal.then(() => 'disposed'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => { resolve('blocked on catalog') }, 1000)
      }),
    ])
    expect(outcome, 'Cancellation must settle without the blocked catalog provider completing').toBe('disposed')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (late === 'resolve') gate.resolve(catalog)
    else gate.reject(new Error('late catalog failure'))
    await disposal
    expect(w.ctx.contextMap.curatorOf(w.owner)).toBeNull()
    expect(curator.isRunning(w.owner.id)).toBe(false)
    vi.restoreAllMocks()
  }
})

it('refuses a map_view whose curator role is handed off during the read', async () => {
  const w = await world()
  await w.ctx.contextMap.claim(w.owner)
  const assistant = await w.spawnRoot('assistant')
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  const original = w.ctx.contextMap.view.bind(w.ctx.contextMap)
  const view = vi.spyOn(w.ctx.contextMap, 'view').mockImplementation(async (...args) => {
    const result = await original(...args)
    entered.resolve(undefined)
    await gate.promise
    return result
  })
  const reading = call(w, w.owner, 'map_view')
  try {
    await entered.promise
    await w.ctx.contextMap.claim(w.owner, { holderId: assistant.id })
    gate.resolve(undefined)
    expect((await reading).isError).toBe(true)
  } finally {
    gate.resolve(undefined)
    await reading
    view.mockRestore()
  }
})

it('keeps new source sections reachable when their file later shares a curated folder path', async () => {
  const w = await world()
  const sections = (await w.sections()).filter(section => section.kind === 'project-instructions')
  await w.ctx.contextMap.claim(w.owner)
  await w.ctx.contextMap.setGroup(w.owner, {
    expectedRevision: 1,
    group: { path: 'Instructions/Project/CLAUDE.md', title: 'References', summary: 'Use for architecture.', sections: sections.map(section => section.id) },
  })
  w.write('CLAUDE.md', '# New reference\n\nNew information.\n')
  const listing = await w.ctx.contextTree.browse(w.owner, { path: 'Instructions/Project/CLAUDE.md' })
  expect(listing.nodes).toHaveLength(sections.length + 1)
  const loaded = await w.ctx.contextTree.load(w.owner, { paths: listing.nodes.map(node => node.path) })
  expect(loaded.result.missing).toEqual([])
  expect(loaded.result.granted).toHaveLength(sections.length + 1)
})
