/**
 * Review r2 m1: the r1 m2 fix aligned the OpenAI listing with its client's API root, but Anthropic still strips a
 * trailing `/v1` before appending `/v1/models`. pi-ai passes `baseURL` unchanged to the Anthropic client, which
 * appends `/v1/messages`, so a `…/v1` Anthropic route lists `…/v1/models` while inference posts `…/v1/v1/messages`.
 * Preflight then reports the binding `configured` from a listing that dispatch never uses.
 */
import { afterEach, expect, it } from 'vitest'
import { configuration, harness, server } from './harness.ts'
import { metadataEndpoint, shippingCatalog } from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// Astra is the openai-responses control (passes); Sonnet is the anthropic-messages defect case.
it.each([['Astra', 'openai-responses', /\/responses$/u], ['Sonnet', 'anthropic-messages', /\/messages$/u]] as const)(
  'lists %s models under the same API root that Fusion route dispatch posts to', async (presetId, transport, endpoint) => {
    const listing = { data: shippingCatalog('KEY').slice(0, 8).map(row => ({ id: row.wireModelId })), has_more: false }
    const http = await server((request, response) => {
      if (request.method === 'GET') { response.end(JSON.stringify(listing)); return }
      response.writeHead(404)
      response.end()
    })
    cleanups.push(() => http.close())
    // configuration() gives Anthropic exactly this baseURL: an explicit `/v1` suffix, as in the Anthropic API docs root.
    const app = await harness(configuration(`${http.baseURL}/v1`))
    cleanups.push(() => app.dispose())

    const report = await app.ctx.fusionConfig.preflight('test-pair')
    const row = report.bindings.find(binding => binding.binding.presetId === presetId)!
    expect(row.binding.transport).toBe(transport)
    expect(row.code).toBe('configured')
    const listed = metadataEndpoint(row.binding).pathname
    expect(http.requests.map(request => request.url.split('?')[0])).toContain(listed)

    const prepared = await app.ctx.llm.prepareCall({ provider: row.binding.providerId, model: row.binding.wireModelId })
    try {
      for await (const _chunk of prepared.stream({ ...prepared.config, messages: [] })) { /* drain */ }
    } catch (_error) { /* The fake upstream rejects inference; only the request path is evidence. */ }
    const posted = http.requests.filter(request => request.method === 'POST').map(request => request.url.split('?')[0]!)
    expect(posted).toHaveLength(1)
    expect({ listing: listed, dispatchRoot: posted[0]!.replace(endpoint, '/models') })
      .toEqual({ listing: listed, dispatchRoot: listed })
  }, 30_000)
