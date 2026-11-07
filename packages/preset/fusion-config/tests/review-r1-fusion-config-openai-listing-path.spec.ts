/**
 * Review r1 m2: an `openai-responses` route dispatches to `${baseURL}/responses` and its client lists
 * `${baseURL}/models`. The metadata reader inserts `/v1` when the base URL has no `/v1` suffix, so it
 * reads a different API root from the one inference uses.
 */
import { afterEach, expect, it } from 'vitest'
import { bind, exactMembership, shippingCatalog } from '../src/index.ts'
import { SENTINEL, server } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it('reads the OpenAI listing under the same API root that dispatch uses', async () => {
  const http = await server((request, response) => {
    if (request.url === '/v1beta/openai/models') { response.end(JSON.stringify({ data: [{ id: 'cx/gpt-6-astra' }] })); return }
    response.writeHead(404)
    response.end()
  })
  cleanups.push(() => http.close())
  // OpenAI-compatible roots without a trailing /v1 segment, e.g. a versioned compatibility path.
  const binding = { ...bind(shippingCatalog('KEY'), { catalogRevision: 'v1', presetId: 'Astra' }, 'lead'), baseURL: `${http.baseURL}/v1beta/openai` }
  const result = await exactMembership(binding, SENTINEL, { responseBytes: 32768, totalBytes: 65536, pages: 4, timeoutMs: 5000 })
  expect(http.requests.map(row => row.url)).toEqual(['/v1beta/openai/models'])
  expect(result.kind).toBe('present')
})
