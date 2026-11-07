/** A route's reasoning effort participates in whether the curator can undercut it. */
import { afterEach, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { resolveCuratorConfig } from '../src/config.ts'
import { selectCuratorRoute } from '../src/route.ts'
import { disposeWorlds, MODELS, preStep, world } from './fixture.ts'

afterEach(disposeWorlds)

it('R9 changing the owner reasoning effort invalidates a no-cheap-route decision', async () => {
  const w = await world({ curator: {}, models: { big: MODELS.big! }, script: [textResponse('curated')] })
  w.owner.model.select({ provider: 'mock', model: 'big', reasoningEffort: ReasoningEffortId('low') })
  await preStep(w.ctx, w.owner)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.ctx.contextCurator.failureOf(w.owner.id)).toMatchObject({ code: 'CONTEXT_MAP_NO_CHEAP_ROUTE' })
  expect(w.adapter.requests).toHaveLength(0)
  const work = await w.ctx.contextMap.curationWork(w.owner)

  w.owner.model.select({ provider: 'mock', model: 'big', reasoningEffort: ReasoningEffortId('high') })
  // The real selector now admits a cheaper low-effort route with the same model and provider.
  expect((await selectCuratorRoute(w.ctx.llm, w.owner, resolveCuratorConfig({}))).route)
    .toEqual({ provider: 'mock', model: 'big', reasoningEffort: 'low' })
  expect((await w.ctx.contextMap.curationWork(w.owner))?.signature).toBe(work?.signature)
  await preStep(w.ctx, w.owner)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.adapter.requests, 'an effort-only owner route change must re-evaluate the previously refused route').toHaveLength(1)
})
