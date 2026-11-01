import { afterEach, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import { configuration, FakeCredentials, harness, SENTINEL, server } from './harness.ts'
import type { Binding } from '../src/index.ts'
import { selectionSchema } from '../src/selection.ts'
import { exactMembership, shippingCatalog, shippingSelections, bind } from '../src/index.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fakeServer(handler: Parameters<typeof server>[0]) {
  const value = await server(handler)
  cleanups.push(() => value.close())
  return value
}
async function setup(document?: unknown) { const value = await harness(document); cleanups.push(() => value.dispose()); return value }
const listing = { data: shippingCatalog('KEY').slice(0, 8).map(row => ({ id: row.wireModelId })) }
const limits = { responseBytes: 32768, totalBytes: 65536, pages: 10, timeoutMs: 5000 }
const selectedAt = (baseURL: string): Binding => ({ ...bind(shippingCatalog('KEY'), { catalogRevision: 'v1', presetId: 'Astra' }, 'lead'), baseURL: `${baseURL}/v1` })

it('loads real services through YAML, captures roles without I/O and runs the human command with zero inference', async () => {
  const http = await fakeServer((_request, response) => response.end(JSON.stringify(listing)))
  const { ctx, agent } = await setup(configuration(http.baseURL))
  expect(ctx.fusionConfig.selection('test-pair').roles.decider?.presetId).toBe('Sol')
  expect(http.requests).toHaveLength(0)
  const report = await ctx.fusionConfig.preflight('test-pair')
  expect(report.structural).toBe('ready')
  expect(report.defaultEligible).toBe(false)
  expect(report.coverage).toBe('live-unverified')
  expect(report.bindings.every(row => row.membership?.kind === 'present')).toBe(true)
  const executed = await ctx.commands.execute(agent, '/fusion_preflight test-pair', [], new AbortController().signal)
  expect(executed?.result).toEqual({ kind: 'success', text: 'Fusion test-pair@fixture-v1: ready.\nAgent preset: ready.\nCoverage: live-unverified. Default eligible: false. Runtime safety gates are pending. No model was invoked.' })
  await ctx.commands.execute(agent, `/fusion_preflight ${SENTINEL}`, [], new AbortController().signal)
  const log = JSON.stringify(agent.session.snapshotEvents())
  expect(log).toContain('command/done')
  expect(log).not.toContain(SENTINEL)
  expect(JSON.stringify(report)).not.toContain(SENTINEL)
  expect(http.inference).toBe(0)
  expect(http.requests.every(row => row.method === 'GET' && row.url === '/v1/models')).toBe(true)
  expect(agent.session.snapshotEvents().some(event => event.type === 'request/header')).toBe(false)
})

it.each(['unknown', 'unsupported', 'effort', 'alias-effort', 'missing-credential', 'credential-error', 'route', 'missing-provider', 'missing-preset'] as const)('blocks %s evidence without leaking credentials or probing inference', async (kind) => {
  const http = await fakeServer((_request, response) => response.end(JSON.stringify(listing)))
  const config = configuration(http.baseURL)
  if (kind === 'unknown') config.declarations = []
  if (kind === 'unsupported') config.declarations.forEach((row) => { row.tools = false })
  if (kind === 'effort') config.declarations.forEach((row) => { row.efforts = ['low'] })
  if (kind === 'alias-effort') config.providers['omniroute-anthropic']!.models.forEach((row) => { delete row.compat })
  if (kind === 'route') config.providers['omniroute-openai']!.baseURL += '/different'
  if (kind === 'missing-provider') delete config.providers['omniroute-openai']
  if (kind === 'missing-preset') config.selections[0]!.agentPreset = 'missing'
  const { ctx } = await setup(config)
  const credentials = ctx.credentials
  expect(credentials).toBeInstanceOf(FakeCredentials)
  if (credentials instanceof FakeCredentials) {
    credentials.present = kind !== 'missing-credential'
    credentials.failure = kind === 'credential-error'
  }
  const report = await ctx.fusionConfig.preflight('test-pair')
  expect(report.structural).toBe('blocked')
  expect(JSON.stringify(report)).not.toContain(SENTINEL)
  expect(http.inference).toBe(0)
  if (kind === 'alias-effort') expect(report.bindings.filter(row => row.binding.family === 'Anthropic').every(row => row.code === 'unsupported-effort')).toBe(true)
  if (kind === 'missing-credential') expect(report.bindings.every(row => row.code === 'missing-credential')).toBe(true)
})

it('finds a page-two exact ID and retains sanitized complete-listing evidence', async () => {
  const http = await fakeServer((request, response) => response.end(JSON.stringify(request.url?.includes('page=2')
    ? { data: [{ id: 'cx/gpt-6-astra' }] }
    : { data: [{ id: 'unrelated' }], next: '/v1/models?page=2' })))
  const result = await exactMembership(selectedAt(http.baseURL), SENTINEL, limits)
  expect(result).toMatchObject({ kind: 'present', receipt: { pages: 2, selectedId: 'cx/gpt-6-astra', providerEvidence: 'absent' } })
  expect(JSON.stringify(result)).not.toContain(SENTINEL)
  expect(http.requests.map(row => row.url)).toEqual(['/v1/models', '/v1/models?page=2'])
})

it('follows Anthropic after_id pagination on the pinned origin', async () => {
  const http = await fakeServer((request, response) => response.end(JSON.stringify(request.url?.includes('after_id=first')
    ? { data: [{ id: 'cc/claude-fable-5-1' }], has_more: false }
    : { data: [{ id: 'first' }], has_more: true, last_id: 'first' })))
  const binding = { ...bind(shippingCatalog('KEY'), { catalogRevision: 'v1', presetId: 'Fable' }, 'lead'), baseURL: http.baseURL }
  expect(await exactMembership(binding, SENTINEL, limits)).toMatchObject({ kind: 'present' })
  expect(http.requests.every(row => row.credential === SENTINEL)).toBe(true)
})

it.each(['failed', 'repeat', 'off-origin', 'malformed', 'truncated', 'limit', 'total', 'pages', 'redirect', 'conflict', 'false-end', 'unknown-cursor'] as const)('leaves %s traversal unknown, never false absence', async (kind) => {
  const other = await fakeServer((_request, response) => response.end(JSON.stringify(listing)))
  const http = await fakeServer((request, response) => {
    if (kind === 'failed' && request.url?.includes('page=2')) { response.writeHead(503); response.end(SENTINEL); return }
    if (kind === 'redirect') { response.writeHead(302, { location: `${other.baseURL}/v1/models` }); response.end(); return }
    if (kind === 'truncated') { response.end('{'); return }
    if (kind === 'conflict') { response.end(JSON.stringify({ data: [{ id: 'cx/gpt-6-astra', family: 'Anthropic' }] })); return }
    const next = kind === 'off-origin' ? `${other.baseURL}/v1/models` : kind === 'malformed' ? 'http://[' : kind === 'repeat' ? '/v1/models' : '/v1/models?page=2'
    response.end(JSON.stringify({ data: [{ id: 'unrelated' }], ...kind === 'unknown-cursor'
      ? { has_more: true }
      : { next, ...kind === 'false-end' ? { has_more: false } : {} } }))
  })
  const result = await exactMembership(selectedAt(http.baseURL), SENTINEL, {
    ...limits, ...kind === 'limit' ? { responseBytes: 1 } : {}, ...kind === 'total' ? { totalBytes: 1 } : {}, ...kind === 'pages' ? { pages: 1 } : {},
  })
  expect(result.kind).toBe('unknown')
  expect(other.requests).toHaveLength(0)
  expect(JSON.stringify(result)).not.toContain(SENTINEL)
})

it('complete absence differs from incomplete membership even after a selected-ID hit', async () => {
  const http = await fakeServer((request, response) => {
    if (request.url?.includes('page=2')) { response.writeHead(500); response.end(); return }
    response.end(JSON.stringify({ data: [{ id: 'cx/gpt-6-astra' }], next: '/v1/models?page=2' }))
  })
  expect(await exactMembership(selectedAt(http.baseURL), SENTINEL, limits)).toMatchObject({ kind: 'unknown' })
  const empty = await fakeServer((_request, response) => response.end(JSON.stringify({ data: [] })))
  expect(await exactMembership(selectedAt(empty.baseURL), SENTINEL, limits)).toMatchObject({ kind: 'absent' })
})

it('cancels an outstanding body and awaits plugin disposal before withdrawing registrations', async () => {
  const started = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>()
  let response: ServerResponse | undefined
  const http = await fakeServer((_request, res) => {
    response = res
    res.on('close', () => { closed.resolve(undefined) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"data":[')
    started.resolve(undefined)
  })
  const config = configuration(http.baseURL)
  config.metadataLimits.timeoutMs = 500
  const { ctx, agent } = await setup(config)
  const operation = ctx.fusionConfig.preflight('test-pair')
  await started.promise
  const entry = ctx.loader.resolve('fusion')
  await entry.fiber!.dispose()
  const report = await operation
  await closed.promise
  expect(report.bindings.some(row => row.membership?.kind === 'unknown' && row.membership.code === 'cancelled')).toBe(true)
  expect(response?.destroyed).toBe(true)
  expect(report.structural).toBe('blocked')
  expect(ctx.commands.find(agent, 'fusion_preflight')).toBeUndefined()
  expect(ctx.get('fusionConfig')).toBeUndefined()
  expect(ctx.llm.listProviders()).toEqual([])
})

it('honors caller cancellation before requests and a traversal timeout while awaiting headers', async () => {
  const http = await fakeServer(() => {})
  const signal = AbortSignal.abort('secret cancellation detail')
  expect(await exactMembership(selectedAt(http.baseURL), SENTINEL, limits, signal)).toEqual({ kind: 'unknown', code: 'cancelled' })
  expect(http.requests).toHaveLength(0)
  expect(await exactMembership(selectedAt(http.baseURL), SENTINEL, { ...limits, timeoutMs: 20 })).toEqual({ kind: 'unknown', code: 'timeout' })
})

it('leaves the no-plugin composition without Fusion services, commands, records or providers', async () => {
  const { ctx, agent } = await setup()
  expect(ctx.get('fusionConfig')).toBeUndefined()
  expect(ctx.commands.find(agent, 'fusion_preflight')).toBeUndefined()
  expect(ctx.llm.listProviders()).toEqual([])
  const before = agent.session.snapshotEvents()
  expect(await ctx.commands.execute(agent, '/fusion_preflight top', [], new AbortController().signal)).toBeUndefined()
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(JSON.stringify(before)).not.toContain('fusion')
})

it.each(['links', 'next_page_url', 'cursor', 'link-header'] as const)('blocks unsupported %s pagination instead of claiming absence', async (kind) => {
  const http = await fakeServer((_request, response) => {
    if (kind === 'link-header') response.setHeader('Link', '</v1/models?page=2>; rel="next"')
    response.end(JSON.stringify({ data: [], ...kind === 'link-header' ? {} : { [kind]: 'continuation' } }))
  })
  expect(await exactMembership(selectedAt(http.baseURL), SENTINEL, limits)).toMatchObject({ kind: 'unknown' })
})

it.each(['missing-role', 'unknown-family', 'unknown-effort', 'inline-secret', 'wrong-alias', 'effort-substitution'] as const)('rejects %s at the Loader configuration parser before publishing a consumer', async (kind) => {
  const config = configuration('http://127.0.0.1:1')
  const document: Record<string, unknown> = structuredClone(config)
  const bindings = document.bindings as Record<string, unknown>[]
  const providers = document.providers as Record<string, Record<string, unknown>>
  const selections = document.selections as { topology: Record<string, unknown> }[]
  if (kind === 'missing-role') delete selections[0]!.topology.executor
  if (kind === 'unknown-family') bindings[0]!.family = 'unknown'
  if (kind === 'unknown-effort') bindings[0]!.leadEffort = 'maximum'
  if (kind === 'inline-secret') providers['omniroute-openai']!.apiKey = SENTINEL
  if (kind === 'effort-substitution') providers['omniroute-openai']!.models = [{ id: 'cx/gpt-6-astra', reasoningEfforts: { high: 'low' } }]
  if (kind === 'wrong-alias') bindings[0]!.alias = { kind: 'exact', canonicalModelId: 'another-model' }
  const { ctx, agent } = await setup(document)
  expect(ctx.get('fusionConfig')).toBeUndefined()
  expect(ctx.commands.find(agent, 'fusion_preflight')).toBeUndefined()
  expect(ctx.llm.listProviders()).toEqual([])
  expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain(SENTINEL)
})

it.each(shippingSelections('standard'))('preflights the complete $id pairing and upgrade chain using fake routes', async (selected) => {
  const http = await fakeServer((_request, response) => response.end(JSON.stringify(listing)))
  const config = configuration(http.baseURL)
  const fixture = selectionSchema.parse(JSON.parse(JSON.stringify(selected).replaceAll('"catalogRevision":"v1"', '"catalogRevision":"fixture-v1"')))
  fixture.id = `fixture-${fixture.id}`
  config.selections = [fixture]
  const { ctx } = await setup(config)
  const report = await ctx.fusionConfig.preflight(fixture.id)
  expect(report.structural).toBe('ready')
  expect(report.bindings.every(row => row.membership?.kind === 'present')).toBe(true)
  expect(http.inference).toBe(0)
})

it('accepts a complete empty Anthropic listing with null terminal cursors', async () => {
  const http = await fakeServer((_request, response) => {
    response.end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }))
  })
  const binding = { ...bind(shippingCatalog('KEY'), { catalogRevision: 'v1', presetId: 'Fable' }, 'lead'), baseURL: http.baseURL }
  expect(await exactMembership(binding, SENTINEL, limits)).toMatchObject({ kind: 'absent' })
})
