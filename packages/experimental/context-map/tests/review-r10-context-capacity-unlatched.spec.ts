/** After the early-end retry, the once-refused work stays eligible at owner steps while attempts remain. */
import { afterEach, expect, it, vi } from 'vitest'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { disposeWorlds, preStep, requestsOf, SIGNAL, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

it('R10 refused work retried after an early end is not latched for the next owner step', async () => {
  const w = await world({
    curator: { maxAttempts: 2 }, maxActiveSubagents: 1,
    script: ['hang', maxTokensResponse('partial'), textResponse('curated')],
  })
  const request = requestsOf(w)
  const occupier = await w.ctx.subagents.startActivation({
    provider: 'spawn', label: 'Occupier', delivery: 'caller', signal: SIGNAL,
    request: { parent: w.owner, prompt: [{ type: 'text', text: 'Hold the only slot.' }], agentOptions: { provider: 'mock', model: 'big' } },
  })
  await request(1)
  const start = w.ctx.subagents.startActivation.bind(w.ctx.subagents)
  vi.spyOn(w.ctx.subagents, 'startActivation').mockImplementationOnce(async (spec) => {
    try { return await start(spec) } catch (error: unknown) {
      expect(error instanceof SubagentError && error.code).toBe('ACTIVATION_LIMIT_REACHED')
      await occupier.dispose()
      throw error
    }
  })
  const claims = (): (string | undefined)[] => w.owner.session.snapshotEvents()
    .flatMap(event => event.type === 'context-map/state' && event.data.op.kind === 'claim' ? [event.data.op.work] : [])
  await w.ctx.contextMap.note(w.owner, { text: 'Use vitest for tests.', cites: ['ref:package.json'] })
  await w.ctx.contextCurator.idle(w.owner.id)
  const refused = claims()[0]
  // The retry stopped at max tokens: no index acknowledgement, so the work keeps its signature.
  expect(w.adapter.requests).toHaveLength(2)
  expect(claims()).toEqual([refused, refused])
  const work = await w.ctx.contextMap.curationWork(w.owner)
  expect(work).toMatchObject({ signature: refused, attempts: 1 })
  await preStep(w.ctx, w.owner)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(claims(), 'an owner step must start the same work again while attempts remain').toEqual([refused, refused, refused])
  expect(w.adapter.requests).toHaveLength(3)
})
