/** Retry fingerprints and counts survive replay, compaction, and service recovery. */
import { afterEach, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ContextMapService, { DefaultContextCurator } from '../src/index.ts'
import { contextMapProjectionDefinition, type ContextMapProjectionState } from '../src/projection.ts'
import { disposeWorlds, preStep, requestsOf, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

it('R7 retry exhaustion survives a real compaction and replay, while a new pending note remains eligible', async () => {
  const fail = (): never => { throw new Error('curator unavailable') }
  const w = await world({ curator: {}, script: [fail, fail, textResponse('owner answer'), textResponse('summary'), textResponse('new work')] })
  const request = requestsOf(w)
  const initial = await w.ctx.contextMap.curationWork(w.owner)
  expect(initial?.attempts).toBe(0)
  let checkpoint: ContextMapProjectionState | undefined
  let checkpointLength = 0
  for (const count of [1, 2]) {
    await preStep(w.ctx, w.owner, 1, count + 1)
    await request(count)
    await w.ctx.contextCurator.idle(w.owner.id)
    if (count === 1) {
      const events = w.owner.session.snapshotEvents()
      checkpointLength = events.length
      const state = events.reduce<ContextMapProjectionState>(contextMapProjectionDefinition.apply,
        contextMapProjectionDefinition.init(w.owner.session.header))
      checkpoint = contextMapProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
    }
  }
  const exhausted = await w.ctx.contextMap.curationWork(w.owner)
  expect(exhausted).toMatchObject({ signature: initial?.signature, attempts: 2 })
  w.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'Conversation to compact.' }], source: { kind: 'user' } }))
  await w.owner.whenIdle()
  expect(w.adapter.requests).toHaveLength(3)
  const nodes = w.owner.session.surface.nodes
  const start = nodes.at(1)
  const end = nodes.at(-1)
  if (start === undefined || end === undefined || checkpoint === undefined) throw new Error('Missing compaction or replay input')
  w.owner.session.append('turn/start', { turn: 2 })
  await w.ctx.compaction.compactRegion(start, end, w.owner, new AbortController().signal)
  w.owner.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  expect(w.owner.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
  expect(await w.ctx.contextMap.curationWork(w.owner)).toEqual(exhausted)
  const events = w.owner.session.snapshotEvents()
  const full = events.reduce<ContextMapProjectionState>(contextMapProjectionDefinition.apply,
    contextMapProjectionDefinition.init(w.owner.session.header))
  expect(events.slice(checkpointLength).reduce<ContextMapProjectionState>(contextMapProjectionDefinition.apply, checkpoint)).toEqual(full)
  const legacy = events.map((event) => {
    if (event.type !== 'context-map/state') return event
    const { work: _work, ...op } = event.data.op
    return { ...event, data: { ...event.data, op } }
  })
  expect(legacy.reduce<ContextMapProjectionState>(contextMapProjectionDefinition.apply,
    contextMapProjectionDefinition.init(w.owner.session.header)).attempts).toBeNull()
  await w.curatorFiber!.dispose()
  await [...w.ctx.registry.get(ContextMapService)!.fibers][0]!.dispose()
  await w.ctx.plugin(ContextMapService)
  await w.ctx.plugin(DefaultContextCurator)
  expect(await w.ctx.contextMap.curationWork(w.owner)).toEqual(exhausted)
  await preStep(w.ctx, w.owner)
  await w.ctx.contextMap.note(w.owner, { text: 'Genuinely new work.', cites: ['ref:package.json'] })
  await request(5)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.adapter.requests).toHaveLength(5)
})
