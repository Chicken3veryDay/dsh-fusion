/** External Fetch bodies and continuation evidence are bounded before membership is accepted. */
import { afterEach, expect, it, vi } from 'vitest'
import { bind, exactMembership, shippingCatalog } from '../src/index.ts'

const binding = bind(shippingCatalog('KEY'), { catalogRevision: 'v1', presetId: 'Astra' }, 'lead')
const limits = { responseBytes: 32768, totalBytes: 65536, pages: 10, timeoutMs: 5000 }
afterEach(() => { vi.unstubAllGlobals() })
function respond(response: Response) { vi.stubGlobal('fetch', vi.fn(async () => response)) }

it.each([200, 503])('rejects an empty Fetch body at status %s', async (status) => {
  respond(new Response(null, { status }))
  expect(await exactMembership(binding, 'fixture', limits)).toEqual({ kind: 'unknown', code: status === 200 ? 'invalid-page' : 'metadata-failed' })
})

it('rejects unsupported Link headers even when the response has no body', async () => {
  respond(new Response(null, { headers: { link: '</models?page=2>' } }))
  expect(await exactMembership(binding, 'fixture', limits)).toEqual({ kind: 'unknown', code: 'invalid-continuation' })
})

it.each([new Error('body interrupted'), 'non-Error stream failure'])('contains stream read and cancellation failures (%s)', async (error) => {
  respond(new Response(new ReadableStream({ pull() { throw error } })))
  expect(await exactMembership(binding, 'fixture', limits)).toEqual({ kind: 'unknown', code: 'invalid-page' })
})

it('rejects contradictory next and next_page URLs', async () => {
  respond(Response.json({ data: [], next: '/models?page=2', next_page: '/models?page=3' }))
  expect(await exactMembership(binding, 'fixture', limits)).toEqual({ kind: 'unknown', code: 'invalid-continuation' })
})

it.each([
  { capabilities: { structured_decisions: false } },
  { capabilities: { tools: false } },
  { capabilities: { efforts: ['low'] } },
  { canonical_model_id: 'another-model' },
])('rejects conflicting selected-model evidence (%j)', async (evidence) => {
  respond(Response.json({ data: [{ id: binding.wireModelId, ...evidence }] }))
  expect(await exactMembership(binding, 'fixture', limits)).toEqual({ kind: 'unknown', code: 'conflicting-evidence' })
})

it('retains consistent provider evidence without retaining the raw listing', async () => {
  respond(Response.json({ data: [{ id: binding.wireModelId, family: binding.family, canonical_model_id: binding.canonicalModelId,
    capabilities: { tools: true, structured_decisions: true, efforts: [binding.effort] } }] }))
  expect(await exactMembership(binding, 'fixture', limits)).toMatchObject({ kind: 'present', receipt: { providerEvidence: 'consistent' } })
})
