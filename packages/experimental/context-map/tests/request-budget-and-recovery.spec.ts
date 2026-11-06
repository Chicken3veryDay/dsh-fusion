/** Eager core budget across request preparation, and curator recovery of pending work when the index is already acknowledged. */
import { afterEach, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ContextMapService, { DefaultContextCurator } from '../src/index.ts'
import { disposeWorlds, preStep, world } from './fixture.ts'

afterEach(async () => {
  await disposeWorlds()
  vi.restoreAllMocks()
})

it('R6 core selection changing during request preparation stays inside the default eager budget', async () => {
  const w = await world({ script: [textResponse('done')] })
  w.write('AGENTS.md', `# Before\n\n${'a'.repeat(3000)}\n\n# After\n\n${'b'.repeat(3000)}\n`)
  const sections = await w.projectSections()
  expect(sections).toHaveLength(2)
  const map = w.ctx.contextMap
  await map.claim(w.owner)
  await map.setCore(w.owner, { expectedRevision: map.snapshotOf(w.owner).revision, sections: [sections[0]!] })
  let changed = false
  let reconstructed = false
  w.ctx.on('llm/stream', (request, next) => {
    expect(request.messages).toEqual(Session.create(w.owner.id, w.owner.session.snapshotEvents()).deriveMessages())
    reconstructed = true
    return next()
  })
  w.ctx.on('system-prompt/request-context', async (_context, pending, next) => {
    if (!changed) {
      expect(pending.filter(message => message.source.kind === 'context-grant')).toHaveLength(1)
      changed = true
      await map.setCore(w.owner, { expectedRevision: map.snapshotOf(w.owner).revision, sections: [sections[1]!] })
    }
    return next()
  })
  w.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
  await w.owner.whenIdle()
  expect(changed).toBe(true)
  expect(w.adapter.requests).toHaveLength(1)
  expect(reconstructed).toBe(true)
  const grants = w.owner.session.snapshotEvents().flatMap(event => event.type === 'user/message'
    && event.data.source.kind === 'context-grant' ? [event.data.source] : [])
  expect(grants.length).toBeGreaterThan(0)
  expect(grants.reduce((sum, grant) => sum + (grant.coreBytes ?? 0), 0),
    'pre-step and request-context eager grants share one 4096-byte budget').toBeLessThanOrEqual(4096)
})

it('R6 recovered pending notes wake the default curator even when the source index is already acknowledged', async () => {
  const w = await world({ curator: {}, script: ['hang', textResponse('done')] })
  const map = w.ctx.contextMap
  const claim = await map.claim(w.owner)
  await map.acknowledgeIndex(w.owner, { indexDigest: claim.observedIndexDigest })
  await map.release(w.owner)
  const pending = await map.note(w.owner, { text: 'Recover this durable fact.', cites: ['ref:package.json'] })
  // Positive control: the original notification reaches a healthy provider before shutdown.
  await vi.waitFor(() => { expect(w.adapter.requests).toHaveLength(1) }, { timeout: 2000 })
  await w.curatorFiber!.dispose()
  expect(map.snapshotOf(w.owner).curatorId).toBeNull()
  await w.ctx.sessions.flush(w.owner.session)
  // Reload the owning service so its projection, role index, and notification state are rebuilt.
  const fiber = [...w.ctx.registry.get(ContextMapService)!.fibers][0]!
  await fiber.dispose()
  await w.ctx.plugin(ContextMapService)
  const view = await w.ctx.contextMap.view(w.owner)
  expect({ indexChanged: view.indexChanged, holder: view.curatorId, pending: view.pending.map(note => note.id) })
    .toEqual({ indexChanged: false, holder: null, pending: [pending.id] })
  await w.ctx.plugin(DefaultContextCurator)
  for (let step = 0; step < 3; step++) await preStep(w.ctx, w.owner, step + 1)
  await vi.waitFor(() => {
    expect(w.adapter.requests.length, 'a durable pending note must be picked up after recovery').toBeGreaterThan(1)
  }, { timeout: 2000 })
  await w.ctx.contextCurator.idle(w.owner.id)
})
