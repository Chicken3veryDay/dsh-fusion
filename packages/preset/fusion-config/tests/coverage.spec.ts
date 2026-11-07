/** Configuration refusal and preflight failures remain observable without live inference. */
import { afterEach, expect, it, vi } from 'vitest'
import { configuration, FakeCredentials, harness, server } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup(document: unknown) {
  const app = await harness(document)
  cleanups.push(() => app.dispose())
  return app
}

it.each(['duplicate-model', 'duplicate-declaration', 'duplicate-selection'] as const)('rejects %s before publishing the service', async (kind) => {
  const config = configuration('http://127.0.0.1:1')
  if (kind === 'duplicate-model') config.providers['omniroute-openai']!.models.push(config.providers['omniroute-openai']!.models[0]!)
  if (kind === 'duplicate-declaration') config.declarations.push(config.declarations[0]!)
  if (kind === 'duplicate-selection') config.selections.push(config.selections[0]!)
  const app = await setup(config)
  expect(app.ctx.get('fusionConfig')).toBeUndefined()
  expect(app.ctx.llm.listProviders()).toEqual([])
})

it('keeps provider-free configurations inspectable and rejects unknown selection names', async () => {
  const app = await setup({ ...configuration('http://127.0.0.1:1'), providers: {} })
  expect(app.ctx.llm.listProviders()).toEqual([])
  expect(() => app.ctx.fusionConfig.selection('missing')).toThrow('not-found')
  const report = await app.ctx.fusionConfig.preflight('test-pair')
  expect(report.bindings.every(row => row.code === 'missing-provider')).toBe(true)
  const result = await app.ctx.commands.execute(app.agent, '/fusion_preflight test-pair', [], new AbortController().signal)
  expect(result?.result.kind).toBe('error')
  expect(result?.result.text).toContain('missing-provider')
})

it('cancels before auditing the preset or fetching any metadata', async () => {
  const app = await setup(configuration('http://127.0.0.1:1'))
  const report = await app.ctx.fusionConfig.preflight('test-pair', AbortSignal.abort())
  expect(report.agentPreset).toBe('blocked')
  expect(report.bindings.every(row => row.code === 'cancelled')).toBe(true)
})

it('blocks an adapter that cannot resolve the configured reasoning effort', async () => {
  const config = configuration('http://127.0.0.1:1')
  const provider = config.providers['omniroute-openai']!
  const app = await setup({ ...config, providers: { ...config.providers,
    'omniroute-openai': { ...provider, models: provider.models.map(model => ({ id: model.id, reasoningEfforts: { low: 'low' } })) },
  } })
  const report = await app.ctx.fusionConfig.preflight('test-pair')
  expect(report.bindings.filter(row => row.binding.family === 'OpenAI').every(row => row.code === 'adapter-failed')).toBe(true)
})

it.each([true, false])('resolves operation-local adapter credentials (present=%s)', async (present) => {
  const http = await server((_request, response) => { response.writeHead(401); response.end('{}') })
  cleanups.push(() => http.close())
  const app = await setup(configuration(http.baseURL))
  const credentials = app.ctx.credentials
  expect(credentials).toBeInstanceOf(FakeCredentials)
  if (credentials instanceof FakeCredentials) credentials.present = present
  const chunks = []
  for await (const chunk of app.ctx.llm.stream({ provider: 'omniroute-openai', model: 'cx/gpt-6-astra', messages: [] })) chunks.push(chunk)
  expect(chunks.filter(chunk => chunk.type === 'finish').map(chunk => chunk.reason.kind)).toContain('error')
  expect(http.requests.length > 0).toBe(present)
})

it('settles cancellation while a preset audit is still pending', async () => {
  const app = await setup(configuration('http://127.0.0.1:1'))
  const controller = new AbortController()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof app.ctx.agentPresets.resolve>>>()
  vi.spyOn(app.ctx.agentPresets, 'resolve').mockImplementation(() => pending.promise)
  const operation = app.ctx.fusionConfig.preflight('test-pair', controller.signal)
  controller.abort()
  const report = await operation
  expect(report.agentPreset).toBe('blocked')
  expect(report.bindings.every(row => row.code === 'cancelled')).toBe(true)
  pending.resolve({ id: 'standard' })
})

it('reports complete metadata absence in the preflight', async () => {
  const http = await server((_request, response) => response.end(JSON.stringify({ data: [] })))
  cleanups.push(() => http.close())
  const app = await setup(configuration(http.baseURL))
  const report = await app.ctx.fusionConfig.preflight('test-pair')
  expect(report.structural).toBe('blocked')
  expect(report.bindings.every(row => row.code === 'absent-model' && row.membership?.kind === 'absent')).toBe(true)
})

it.each([undefined, { high: 'high' as const }])('accepts optional reasoning-effort entries (%j)', async (reasoningEfforts) => {
  const config = configuration('http://127.0.0.1:1')
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
    ...provider, models: provider.models.map(model => ({
      id: model.id,
      ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
      ...model.compat === undefined ? {} : { compat: model.compat },
    })),
  }]))
  const app = await setup({ ...config, providers })
  expect(app.ctx.get('fusionConfig')).toBeDefined()
  expect((await app.ctx.fusionConfig.preflight('test-pair')).structural).toBe('blocked')
})
