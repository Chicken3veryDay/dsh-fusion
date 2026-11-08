/**
 * The Claude account pool through the real Loader: one credential document per
 * account mounted from settings, refresh written to the selected document only,
 * hot replacement, mount failure, disposal, and the failover listener.
 */

import { execFileSync } from 'node:child_process'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { assemble } from './assemble.ts'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import { disposeComposition, loadComposition, root } from './composition.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'

// Count the watchers credentials-local holds open, to prove teardown releases them.
// chokidar is credentials-local's own dependency, so the mock names it by that package's path.
const openWatchers = new Set<object>()
/** Called synchronously as each account document's watcher is created, to interleave a teardown with a mount. */
let onAccountWatcher: ((path: string) => void) | undefined
vi.mock('../../../credentials/credentials-local/node_modules/chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../credentials/credentials-local/node_modules/chokidar')>()
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args)
      openWatchers.add(watcher)
      const watched = String(args[0])
      if (/account-\d\.credentials\.yaml$/.test(watched)) onAccountWatcher?.(watched)
      const close = watcher.close.bind(watcher)
      watcher.close = () => { openWatchers.delete(watcher); return close() }
      return watcher
    },
  }
})

afterEach(async () => {
  onAccountWatcher = undefined
  await disposeComposition()
  await closeMockServers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const MAIN_ACCESS = 'at'
const token = (id: string): string => `sk-ant-oat-${id}`
const ok = { events: anthropicTextEvents }
const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] })
const request = (ctx: Context) => assemble(ctx, { provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 32, messages: [message] })

/** A 0600 credential document holding one OAuth grant for the Anthropic route. */
async function document(id: string, options: { expires?: number; mode?: number } = {}): Promise<string> {
  const path = join(root!, `${id}.credentials.yaml`)
  await writeFile(path, [
    'version: 1', 'records:', '  llm-pi-ai/anthropic:', '    kind: grant',
    `    payload: { type: oauth, access: ${token(id)}, refresh: ${token(id)}-refresh, expires: ${options.expires ?? 4102444800000} }`, '',
  ].join('\n'))
  await chmod(path, options.mode ?? 0o600)
  return path
}

/** The profile patch the Models page would leave for a pooled Anthropic route. */
const settings = (baseURL: string, paths: Record<string, string>, extra: string[] = []): string => [
  '- id: llm-pi-ai', '  config:', '    providers:', '      anthropic:', `        baseURL: ${baseURL}`,
  '        accountRateLimitCooldownMs: 60000', '        accountReservationMs: 5000',
  ...extra, '        accounts:',
  ...Object.entries(paths).flatMap(([id, credentialsPath]) => [`          - id: ${id}`, `            credentialsPath: ${credentialsPath}`]),
  '',
].join('\n')

/** Boot the composition with an empty shared store, and mount the given accounts from settings. */
async function boot(baseURL: string, documents: (home: string) => Promise<Record<string, string>>, extra: string[] = []) {
  const loaded = await loadComposition()
  const paths = await documents(root!)
  // The settings and shared-store watchers are not the pool's; account watchers are counted above this.
  const baseline = openWatchers.size
  await writeFile(loaded.settingsPath, settings(baseURL, paths, extra))
  await vi.waitFor(() => { expect(loaded.ctx.llm.listProviders().map(provider => provider.id)).toContain('anthropic') }, { timeout: 5000 })
  return { ...loaded, paths, baseline, mounted: () => openWatchers.size - baseline }
}

/** Wait until the pool is published: model offers read each account document and never the network. */
async function ready(ctx: Context): Promise<void> {
  await vi.waitFor(async () => { expect((await ctx.llm.listModels('anthropic')).length).toBeGreaterThan(0) }, { timeout: 5000 })
}

/** Two signed-in accounts. */
const pair = async (): Promise<Record<string, string>> => ({ 'account-1': await document('account-1'), 'account-2': await document('account-2') })

/**
 * Put a grant in the shared store once the route is pooled. It must never be used: the pooled route
 * has no other source of credentials than its accounts. Seeding it earlier would activate an ordinary
 * signed-in route that could reach the network.
 */
async function decoy(ctx: Context): Promise<void> {
  await ctx.credentials.modifyRecord(recordKeyFor('anthropic'), () => Promise.resolve({
    kind: 'grant',
    payload: { type: 'oauth', access: MAIN_ACCESS, refresh: 'rt', expires: 4102444800000 },
  }))
}

/** Wait until the mounted pool serves, by observing a request that reaches the server. */
async function serving(ctx: Context, served: () => number): Promise<void> {
  const before = served()
  await vi.waitFor(async () => {
    await request(ctx).catch(() => undefined)
    expect(served()).toBeGreaterThan(before)
  }, { timeout: 5000 })
}

/** Intercept only the token endpoint; everything else goes to the real fetch. */
function interceptRefresh(respond: (refresh: string) => Response | Promise<Response>) {
  const real = globalThis.fetch
  const refreshes: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init)
    if (call.url !== TOKEN_URL) {
      if (new URL(call.url).hostname !== '127.0.0.1') throw new Error(`unexpected network request to ${call.url}`)
      return real(call)
    }
    const body = await call.json() as { refresh_token: string }
    refreshes.push(body.refresh_token)
    return respond(body.refresh_token)
  })
  return refreshes
}

/** Offer a failed request to the loop's recovery listeners, as the agent loop does. */
const agent = {} as Agent
const failure = (code: string) => ({ message: code, code })
const offer = (ctx: Context, code: string, overrides: { signal?: AbortSignal; provider?: string; turn?: number; step?: number } = {}) =>
  ctx.waterfall('agent/request-error', {
    agent, turn: overrides.turn ?? 1, step: overrides.step ?? 1, provider: overrides.provider ?? 'anthropic',
    failure: failure(code), retryPolicy: undefined, signal: overrides.signal ?? new AbortController().signal,
  }, () => Promise.resolve(undefined))

describe('mounting the account documents', () => {
  it('serves from the account documents and never from the shared sign-in', async () => {
    const server = await mockServer([ok, ok, ok, ok, ok, ok, ok, ok])
    const { ctx, mounted } = await boot(server.url, pair)
    await serving(ctx, () => server.requests.length)
    await decoy(ctx)
    const result = await request(ctx)
    expect(result.finish).toEqual({ kind: 'stop' })
    const sent = server.headers.map(headers => headers.authorization)
    expect(sent.length).toBeGreaterThan(0)
    for (const bearer of sent) expect([`Bearer ${token('account-1')}`, `Bearer ${token('account-2')}`]).toContain(bearer)
    expect(sent).not.toContain(`Bearer ${MAIN_ACCESS}`)
    // One watcher per account document.
    expect(mounted()).toBe(2)
  })

  it('refreshes the selected account into its own document and leaves every other document untouched', async () => {
    const server = await mockServer([ok, ok])
    const refreshes = interceptRefresh(() => Response.json({ access_token: 'sk-ant-oat-refreshed', refresh_token: 'rotated-refresh', expires_in: 3600 }))
    // Both grants are expired, so whichever account the (random) first selection picks must refresh.
    const { ctx, paths } = await boot(server.url, async () => ({
      'account-1': await document('account-1', { expires: 0 }),
      'account-2': await document('account-2', { expires: 0 }),
    }))
    await ready(ctx)
    await decoy(ctx)
    const before = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([id, path]): Promise<[string, string]> => [id, await readFile(path, 'utf8')])))
    const main = await readFile(join(root!, '.credentials.yaml'), 'utf8')

    expect((await request(ctx)).finish).toEqual({ kind: 'stop' })
    expect(refreshes).toHaveLength(1)
    const selected = refreshes[0] === `${token('account-1')}-refresh` ? 'account-1' : 'account-2'
    const other = selected === 'account-1' ? 'account-2' : 'account-1'
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer sk-ant-oat-refreshed'])
    const refreshed = await readFile(paths[selected] as string, 'utf8')
    expect(refreshed).toContain('sk-ant-oat-refreshed')
    expect(refreshed).toContain('rotated-refresh')
    expect(await readFile(paths[other] as string, 'utf8')).toBe(before[other])
    expect(await readFile(join(root!, '.credentials.yaml'), 'utf8')).toBe(main)
  })

  it('refreshes once when two requests compete for the same expired grant', async () => {
    const server = await mockServer([ok, ok, ok, ok])
    const refreshes = interceptRefresh(async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
      return Response.json({ access_token: 'sk-ant-oat-shared-refresh', refresh_token: 'rotated-refresh', expires_in: 3600 })
    })
    const { ctx } = await boot(server.url, async () => ({ 'account-1': await document('account-1', { expires: 0 }) }))
    await ready(ctx)
    const [first, second] = await Promise.all([request(ctx), request(ctx)])
    expect(first.finish).toEqual({ kind: 'stop' })
    expect(second.finish).toEqual({ kind: 'stop' })
    expect(refreshes).toHaveLength(1)
    expect(server.headers.map(headers => headers.authorization)).toEqual(['Bearer sk-ant-oat-shared-refresh', 'Bearer sk-ant-oat-shared-refresh'])
  })

  it('moves to the new account list on a settings change and releases the old watchers', async () => {
    const server = await mockServer([ok, ok, ok, ok, ok, ok, ok, ok])
    const { ctx, settingsPath, mounted } = await boot(server.url, pair)
    await serving(ctx, () => server.requests.length)
    expect(mounted()).toBe(2)
    server.headers.length = 0

    await writeFile(settingsPath, settings(server.url, { 'account-3': await document('account-3') }))
    await vi.waitFor(async () => {
      await request(ctx).catch(() => undefined)
      expect(server.headers.at(-1)?.authorization).toBe(`Bearer ${token('account-3')}`)
    }, { timeout: 5000 })
    // The retired accounts' watchers are closed; only the one new account's remains.
    expect(mounted()).toBe(1)
    expect(server.headers.map(headers => headers.authorization)).not.toContain(`Bearer ${MAIN_ACCESS}`)
  })

  it('leaves the route unavailable, with no watcher left behind, when a document cannot be mounted', async () => {
    const server = await mockServer([ok])
    const { ctx, mounted } = await boot(server.url, async () => ({
      'account-1': await document('account-1'),
      'account-2': await document('account-2', { mode: 0o644 }),
    }))
    // The first account mounted before the second failed; its watcher was released with the failed attempt.
    await vi.waitFor(() => { expect(mounted()).toBe(0) }, { timeout: 5000 })
    expect((await request(ctx)).finish).toMatchObject({ kind: 'error', failure: { code: 'ACCOUNT_POOL_UNAVAILABLE' } })
    expect(server.requests).toEqual([])
    // With no pool published, failover has nothing to offer.
    expect(await offer(ctx, 'RATE_LIMIT')).toBeUndefined()
  })

  it('mounts nothing for an update queued behind a mount that an unload is waiting on', async () => {
    const server = await mockServer([ok])
    const { ctx, settingsPath } = await loadComposition()
    const first = await document('account-1')
    // A named pipe holds the second mount open until the test writes the document: the mount is stuck mid-way.
    const second = join(root!, 'account-2.credentials.yaml')
    execFileSync('mkfifo', ['-m', '600', second])
    let firstMounted: (() => void) | undefined
    const mountedFirst = new Promise<void>((resolve) => { firstMounted = resolve })
    onAccountWatcher = (path) => { if (path.endsWith('account-1.credentials.yaml')) firstMounted?.() }
    await writeFile(settingsPath, settings(server.url, { 'account-1': first, 'account-2': second }))
    await mountedFirst

    // A settings update queues a second application behind the stuck mount, then the unload begins and waits for it.
    ctx.emit('loader/volatile-update', [])
    const disposing = disposeComposition()
    await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    await writeFile(second, [
      'version: 1', 'records:', '  llm-pi-ai/anthropic:', '    kind: grant',
      `    payload: { type: oauth, access: ${token('account-2')}, refresh: r, expires: 4102444800000 }`, '',
    ].join('\n'))
    await disposing
    expect(openWatchers.size).toBe(0)
  })

  it('withdraws the pool and releases its watchers when settings drop the accounts', async () => {
    vi.stubEnv('PI_POOL_KEY', 'sk-ant-api-explicit-setting')
    const server = await mockServer([ok, ok])
    const { ctx, settingsPath, mounted } = await boot(server.url, pair)
    await ready(ctx)
    expect(mounted()).toBe(2)
    await writeFile(settingsPath, [
      '- id: llm-pi-ai', '  config:', '    providers:', '      anthropic:', `        baseURL: ${server.url}`, '        apiKeyEnv: PI_POOL_KEY', '',
    ].join('\n'))
    await vi.waitFor(() => { expect(mounted()).toBe(0) }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect((await request(ctx)).finish).toEqual({ kind: 'stop' })
      expect(server.headers.at(-1)?.['x-api-key']).toBe('sk-ant-api-explicit-setting')
    }, { timeout: 5000 })
  })

  it('re-admits a signed-out account when its document is replaced, with no restart', async () => {
    const rejected = {
      status: 401,
      body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid bearer token' } }),
    }
    const limited = {
      status: 429,
      headers: { 'retry-after': '600' },
      body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
    }
    const server = await mockServer([rejected, ok, limited, ok])
    const { ctx, paths } = await boot(server.url, pair)
    await ready(ctx)

    expect((await request(ctx)).finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    const signedOut = server.headers[0]?.authorization === `Bearer ${token('account-1')}` ? 'account-1' : 'account-2'
    const other = signedOut === 'account-1' ? 'account-2' : 'account-1'
    expect((await request(ctx)).finish).toEqual({ kind: 'stop' })
    expect(server.headers[1]?.authorization).toBe(`Bearer ${token(other)}`)

    // A new sign-in for the rejected account arrives as an edit of its own document.
    await writeFile(paths[signedOut] as string, [
      'version: 1', 'records:', '  llm-pi-ai/anthropic:', '    kind: grant',
      '    payload: { type: oauth, access: sk-ant-oat-signed-in-again, refresh: r2, expires: 4102444800000 }', '',
    ].join('\n'))
    // The serving account is limited; the re-admitted account then serves.
    expect((await request(ctx)).finish).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })
    await vi.waitFor(async () => {
      expect((await request(ctx)).finish).toEqual({ kind: 'stop' })
      expect(server.headers.at(-1)?.authorization).toBe('Bearer sk-ant-oat-signed-in-again')
    }, { timeout: 5000 })
  })

  it('retires the watchers of a pool whose composition is disposed while its documents are still mounting', async () => {
    const server = await mockServer([ok])
    const { ctx, settingsPath } = await loadComposition()
    const paths = { 'account-1': await document('account-1'), 'account-2': await document('account-2') }
    const baseline = openWatchers.size
    let disposing: Promise<void> | undefined
    // Dispose as the second document's watcher appears: the mount is mid-way through the account list.
    // A settings update queued behind it finds the adapter unloaded and mounts nothing.
    onAccountWatcher = (path) => {
      if (!path.endsWith('account-2.credentials.yaml')) return
      ctx.emit('loader/volatile-update', [])
      disposing = disposeComposition()
    }
    await writeFile(settingsPath, settings(server.url, paths))
    await vi.waitFor(() => { expect(disposing).toBeDefined() }, { timeout: 5000 })
    await disposing
    expect(openWatchers.size).toBe(0)
    expect(baseline).toBeGreaterThan(0)
  })

  it('releases every watcher when the composition is disposed', async () => {
    const server = await mockServer([ok])
    const { ctx, mounted } = await boot(server.url, pair)
    await serving(ctx, () => server.requests.length)
    expect(mounted()).toBe(2)
    await disposeComposition()
    expect(openWatchers.size).toBe(0)
  })
})

describe('the failover listener', () => {
  it('retries at once for a limited or rejected account while another can serve, and only up to the account count', async () => {
    const server = await mockServer([ok])
    const { ctx } = await boot(server.url, pair)
    await serving(ctx, () => server.requests.length)
    for (const code of ['RATE_LIMIT', 'AUTH', 'QUOTA', 'ACCOUNT_QUOTA']) {
      expect(await offer(ctx, code, { turn: code.length })).toEqual({ kind: 'retry' })
    }
    // The cap: two accounts allow two failovers for one step.
    expect(await offer(ctx, 'RATE_LIMIT', { turn: 9 })).toEqual({ kind: 'retry' })
    expect(await offer(ctx, 'RATE_LIMIT', { turn: 9 })).toEqual({ kind: 'retry' })
    expect(await offer(ctx, 'RATE_LIMIT', { turn: 9 })).toBeUndefined()
    // A new step starts a new count.
    expect(await offer(ctx, 'RATE_LIMIT', { turn: 9, step: 2 })).toEqual({ kind: 'retry' })
  })

  it('declines failures that belong to the stream-owned retry, an aborted turn, and other providers', async () => {
    const server = await mockServer([ok])
    const { ctx } = await boot(server.url, pair)
    await serving(ctx, () => server.requests.length)
    for (const code of ['SERVER', 'TIMEOUT', 'TRANSPORT', 'INVALID_REQUEST']) expect(await offer(ctx, code)).toBeUndefined()
    const aborted = new AbortController()
    aborted.abort(new Error('stop'))
    expect(await offer(ctx, 'RATE_LIMIT', { signal: aborted.signal })).toBeUndefined()
    expect(await offer(ctx, 'RATE_LIMIT', { provider: 'deepseek' })).toBeUndefined()
  })

  it('declines when the pool is unavailable or no account is left', async () => {
    const server = await mockServer([ok])
    const { ctx, settingsPath } = await boot(server.url, async () => ({ 'account-1': await document('account-1') }))
    await serving(ctx, () => server.requests.length)
    // The only account is cooling after a limit: nothing is left to fail over to.
    const limited = { status: 429, headers: { 'retry-after': '600' }, body: '{"type":"error","error":{"type":"rate_limit_error","message":"x"}}' }
    const limitedServer = await mockServer([limited])
    await writeFile(settingsPath, settings(limitedServer.url, { 'account-1': await document('account-1') }, ['        accountQuotaCooldownMs: 120000']))
    await vi.waitFor(async () => {
      expect((await request(ctx).catch(() => undefined))?.finish).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })
    }, { timeout: 5000 })
    expect(await offer(ctx, 'RATE_LIMIT')).toBeUndefined()
  })
})
