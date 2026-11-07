/**
 * A curator start the subagent activation pool refuses for capacity: its claim is returned and does
 * not count toward `maxAttempts`, owner steps do not retry it while the pool stays full, and the
 * work starts once a subagent ends.
 */
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { contextMapProjectionDefinition, type ContextMapProjectionState } from '../src/projection.ts'
import { disposeWorlds, preStep, requestsOf, SIGNAL, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

function mapOps(owner: Agent): { readonly kind: string; readonly work?: string }[] {
  return owner.session.snapshotEvents().flatMap(event => event.type === 'context-map/state' ? [event.data.op] : [])
}

function replay(owner: Agent): ContextMapProjectionState {
  let state: ContextMapProjectionState = contextMapProjectionDefinition.init(owner.session.header)
  for (const event of owner.session.snapshotEvents()) state = contextMapProjectionDefinition.apply(state, event)
  return state
}

it('a start refused for capacity is not an attempt and starts again once a subagent ends', async () => {
  const w = await world({
    curator: { maxAttempts: 1 },
    maxActiveSubagents: 1,
    script: ['hang', toolCallResponse('v1', 'map_view', {}), textResponse('curated')],
  })
  const request = requestsOf(w)
  // Another child of the owner holds the only activation slot.
  const occupier = await w.ctx.subagents.startActivation({
    provider: 'spawn', label: 'Occupier', delivery: 'caller', signal: SIGNAL,
    request: { parent: w.owner, prompt: [{ type: 'text', text: 'Hold the slot.' }], agentOptions: { provider: 'mock', model: 'big' } },
  })
  await request(1)

  await w.ctx.contextMap.note(w.owner, { text: 'Tests run with vitest.', cites: ['ref:package.json'] })
  await w.ctx.contextCurator.idle(w.owner.id)
  const work = await w.ctx.contextMap.curationWork(w.owner)
  expect(work?.reasons).toContain('pending')
  expect(mapOps(w.owner).filter(op => op.kind === 'claim' || op.kind === 'release'), 'the refused claim is returned')
    .toEqual([expect.objectContaining({ kind: 'claim', work: work?.signature }), expect.objectContaining({ kind: 'release', work: work?.signature })])
  expect(work?.attempts, 'a refusal is not an attempt').toBe(0)
  expect(replay(w.owner).attempts, 'replay agrees').toBeNull()

  // Owner steps while the pool stays full do not claim again.
  for (let step = 0; step < 3; step++) {
    await preStep(w.ctx, w.owner)
    await w.ctx.contextCurator.idle(w.owner.id)
  }
  expect(mapOps(w.owner).filter(op => op.kind === 'claim'), 'no retry until a subagent ends').toHaveLength(1)
  expect(w.adapter.requests).toHaveLength(1)

  // The occupier ends; the work starts within the same single attempt.
  await occupier.dispose()
  await request(3)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(mapOps(w.owner).filter(op => op.kind === 'claim'), 'the freed slot starts the run').toHaveLength(2)
  expect(w.adapter.requests[1]?.messages.map(message => JSON.stringify(message)).join('')).toContain('project map curator')
  expect(replay(w.owner).attempts, 'the run that started counts once').toEqual({ work: work?.signature, count: 1 })
})

it('a refusal followed by a subagent ending before the run settles retries without waiting for another end', async () => {
  const w = await world({
    curator: { maxAttempts: 1 },
    maxActiveSubagents: 1,
    script: ['hang', toolCallResponse('v1', 'map_view', {}), textResponse('curated')],
  })
  const request = requestsOf(w)
  const occupier = await w.ctx.subagents.startActivation({
    provider: 'spawn', label: 'Occupier', delivery: 'caller', signal: SIGNAL,
    request: { parent: w.owner, prompt: [{ type: 'text', text: 'Hold the slot.' }], agentOptions: { provider: 'mock', model: 'big' } },
  })
  await request(1)
  // Free the slot while the refused run is releasing its claim.
  const release = w.ctx.contextMap.release.bind(w.ctx.contextMap)
  vi.spyOn(w.ctx.contextMap, 'release').mockImplementationOnce(async (caller, target) => {
    await occupier.dispose()
    return release(caller, target)
  })
  await w.ctx.contextMap.note(w.owner, { text: 'Tests run with vitest.', cites: ['ref:package.json'] })
  const work = await w.ctx.contextMap.curationWork(w.owner)
  await request(3)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(mapOps(w.owner).filter(op => op.kind === 'claim')).toHaveLength(2)
  expect(replay(w.owner).attempts).toEqual({ work: work?.signature, count: 1 })
})
