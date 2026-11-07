/** Capacity release that precedes observation of the rejected start must still wake curation. */
import { afterEach, expect, it, vi } from 'vitest'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { disposeWorlds, preStep, requestsOf, SIGNAL, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

it('R9 the last subagent end before the curator catches a capacity refusal is not lost', async () => {
  const w = await world({ curator: { maxAttempts: 1 }, maxActiveSubagents: 1, script: ['hang', textResponse('curated')] })
  const request = requestsOf(w)
  const occupier = await w.ctx.subagents.startActivation({
    provider: 'spawn', label: 'Occupier', delivery: 'caller', signal: SIGNAL,
    request: { parent: w.owner, prompt: [{ type: 'text', text: 'Hold the only slot.' }], agentOptions: { provider: 'mock', model: 'big' } },
  })
  await request(1)
  const start = w.ctx.subagents.startActivation.bind(w.ctx.subagents)
  let refused = false
  let ended = false
  w.ctx.on('subagent/end', () => { ended = true })
  vi.spyOn(w.ctx.subagents, 'startActivation').mockImplementationOnce(async (spec) => {
    try { return await start(spec) } catch (error: unknown) {
      expect(error).toBeInstanceOf(SubagentError)
      expect(error instanceof SubagentError && error.code).toBe('ACTIVATION_LIMIT_REACHED')
      refused = true
      // Deliver the real terminal event before the awaiting curator observes the rejected promise.
      await occupier.dispose()
      expect(ended).toBe(true)
      throw error
    }
  })
  await w.ctx.contextMap.note(w.owner, { text: 'Use vitest for tests.', cites: ['ref:package.json'] })
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(refused).toBe(true)
  expect(ended).toBe(true)
  expect((await w.ctx.contextMap.curationWork(w.owner))?.attempts).toBe(0)
  // The end that preceded the caught refusal retries at once: the refused work runs without an owner step.
  expect(w.adapter.requests.length, 'the freed slot must be used without requiring a second subagent to end').toBe(2)
  const claims = (): (string | undefined)[] => w.owner.session.snapshotEvents()
    .flatMap(event => event.type === 'context-map/state' && event.data.op.kind === 'claim' ? [event.data.op.work] : [])
  const refusedWork = claims()[0]
  expect(claims(), 'the refused work is claimed again and started').toEqual([refusedWork, refusedWork])
  // A subsequent owner step starts only changed work; the refused work is not latched or claimed again.
  await preStep(w.ctx, w.owner)
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(claims().slice(2)).not.toContain(refusedWork)
})
