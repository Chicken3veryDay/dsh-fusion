/** Review sweep (Fable): idle-step cost, wake-up after a release, and the curator beside several live roots. */
import { afterEach, expect, it, vi } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import DefaultContextCurator from '../src/curator.ts'
import { disposeWorlds, preStep, requestsOf, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

function claims(w: Awaited<ReturnType<typeof world>>, ownerId = w.owner.id): number {
  const owner = w.ctx.agents.get(ownerId)!
  return owner.session.snapshotEvents().filter(event => event.type === 'context-map/state' && event.data.op.kind === 'claim').length
}

it('one idle owner step costs a bounded number of index refreshes once the attempts for waiting work are used up', async () => {
  const w = await world({ curator: { maxAttempts: 1 }, script: [() => { throw new Error('curator model failed') }] })
  const request = requestsOf(w)
  await preStep(w.ctx, w.owner)
  await request(1)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(claims(w)).toBe(1)
  const work = await w.ctx.contextMap.curationWork(w.owner)
  expect(work?.attempts).toBe(1)

  const snapshot = vi.spyOn(w.ctx.contextIndex, 'snapshot')
  const view = vi.spyOn(w.ctx.contextMap, 'view')
  await preStep(w.ctx, w.owner)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(claims(w), 'no new run after the attempts are used up').toBe(1)
  const cost = { indexRefreshes: snapshot.mock.calls.length, mapViews: view.mock.calls.length }
  // Map observation, the tree's catalog, and the curator's evaluation (a full view plus a second
  // work read) each refresh the index for the same step.
  expect(cost, 'an idle owner step with exhausted work should cost at most one index refresh').toEqual({ indexRefreshes: 1, mapViews: 0 })
})

it('a holder that releases the role without being disposed hands waiting work back to the default curator', async () => {
  const w = await world({ curator: {}, script: [textResponse('curated')] })
  const assistant = await w.spawnRoot('assistant')
  await w.ctx.contextMap.claim(w.owner, { holderId: assistant.id })
  await w.ctx.contextMap.note(w.owner, { text: 'A fact for the curator.', cites: ['ref:package.json'] })
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(claims(w), 'the default curator never starts beside a live holder').toBe(1)
  await w.ctx.contextMap.release(assistant, { rootSessionId: w.owner.id })
  expect(w.ctx.contextMap.curatorOf(w.owner)).toBeNull()
  await vi.waitFor(() => {
    expect(claims(w), 'README: the default curator resumes once the holder is gone').toBe(2)
  }, { timeout: 1500 })
})

it('a curator that loads beside several live roots starts a run for each root with waiting work, which a shared route fault then observes', async () => {
  const w = await world({ curator: {}, script: ['hang', 'hang', 'hang'] })
  const assistant = await w.spawnRoot('assistant')
  // The assistant is a root conversation of its own: its map has unprocessed index work.
  await w.curatorFiber!.dispose()
  const entered: string[] = []
  const listModels = w.ctx.llm.listModels.bind(w.ctx.llm)
  vi.spyOn(w.ctx.llm, 'listModels').mockImplementation((provider) => {
    entered.push(provider)
    return listModels(provider)
  })
  await w.ctx.plugin(DefaultContextCurator)
  await vi.waitFor(() => {
    expect(w.ctx.contextCurator.isRunning(assistant.id), 'the assistant root gets its own curator run at load').toBe(true)
  }, { timeout: 2000 })
  await vi.waitFor(() => { expect(entered.length).toBeGreaterThanOrEqual(1) }, { timeout: 2000 })
  // A fault keyed on the provider alone cannot tell this run from a temporary owner's run.
  expect(w.owner.model.current()?.provider).toBe(assistant.model.current()?.provider)
})

it('a curator run that records a context_note of its own does not start an unbounded chain of runs', async () => {
  // The curator child sees `context_note` as a base tool. Each note it files is news for its own map,
  // so every run creates the work the next run is started for.
  const rounds = 6
  const w = await world({ curator: { maxAttempts: 2 }, script: Array.from({ length: rounds }, (_, index) => [
    toolCallResponse(`n${String(index)}`, 'context_note', { text: `Curator observation ${String(index)}.`, cites: ['ref:docs'] }),
    textResponse('done'),
  ]).flat() })
  await w.ctx.contextMap.note(w.owner, { text: 'Seed fact.', cites: ['ref:package.json'] })
  await vi.waitFor(() => { expect(claims(w)).toBeGreaterThanOrEqual(1) }, { timeout: 2000 })
  // Give the chain time to run as far as the script allows.
  await new Promise(resolve => setTimeout(resolve, 1500))
  await w.ctx.contextCurator.idle(w.owner.id)
  const runs = claims(w)
  const pending = w.ctx.contextMap.snapshotOf(w.owner).pending.length
  expect({ runs, pending }, 'each run files a note that starts the next run; only the script length ended it')
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- asymmetric matchers are typed any.
    .toEqual({ runs: expect.toSatisfy((count: number) => count <= 2), pending: expect.any(Number) })
})

it('a note filed by the curator cites the hash of the text it read, not whatever the file holds at filing time', async () => {
  const w = await world()
  const assistant = await w.spawnRoot('assistant')
  await w.ctx.contextMap.claim(w.owner, { holderId: assistant.id })
  const testing = (await w.sections()).find(section => section.headingPath.includes('Testing'))!
  const read = await w.ctx.contextIndex.read({ workingDirectory: w.project }, [testing.id])
  const readHash = read.sections[0]!.hash
  // The source changes after the curator read it and before it files the note.
  w.write('AGENTS.md', '# Project rules\n\nUse pnpm.\n\n## Testing\n\nRun vitest with coverage.\n')
  const revision = w.ctx.contextMap.snapshotOf(w.owner).revision
  const grouped = await w.ctx.contextMap.setGroup(assistant, {
    rootSessionId: w.owner.id, expectedRevision: revision,
    group: { path: 'Instructions/Project/testing', title: 'Testing', summary: 'Use when running tests.', sections: [testing.id] },
  })
  const noted = await w.ctx.contextMap.addNote(assistant, {
    rootSessionId: w.owner.id, expectedRevision: grouped.revision, groupId: grouped.groups[0]!.id,
    text: 'Tests run with vitest.', cites: [testing.id],
  })
  const cite = noted.groups[0]!.notes[0]!.cites[0]!
  const view = await w.ctx.contextMap.view(assistant, { rootSessionId: w.owner.id })
  expect({ hash: cite.kind === 'section' ? cite.hash : null, staleNotes: view.staleNotes },
    'a citation must carry the hash of the text the curator read, so the later edit shows as stale')
    .toEqual({ hash: readHash, staleNotes: 1 })
})
