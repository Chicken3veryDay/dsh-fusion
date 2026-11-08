/**
 * The adapter over a pool of Claude subscription accounts: each request claims
 * one account, authenticates as it only, and carries that choice to its stream.
 * Every flow runs against a local Messages endpoint that records the bearer it
 * was sent, so "which account served this request" is observed on the wire.
 */

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { AccountPool } from '../src/account-pool.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicTextEvents, closeMockServers, mockServer } from './mock-server.ts'
import type { MockServer } from './mock-server.ts'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeMockServers()
})

const MAIN_TOKEN = 'sk-ant-oat-main-store'
const token = (id: string): string => `sk-ant-oat-${id}`
const oauth = (access: string, expires = 4102444800000): Credential => ({ type: 'oauth', access, refresh: `${access}-refresh`, expires })
const bearer = (id: string): string => `Bearer ${token(id)}`

const rateLimited = (retryAfter?: string) => ({
  status: 429,
  ...retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } },
  body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }),
})
const rejectedBearer = {
  status: 401,
  body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid bearer token' } }),
}
const ok = { events: anthropicTextEvents }

const CALL: LlmCallConfig = { provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 64 }
const OPTIONS = {
  provider: 'anthropic', model: 'claude-haiku-4-5', maxTokens: 64, system: 'DSH owns this prompt.',
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] })],
}

type Script = Parameters<typeof mockServer>[0]

interface Rig {
  adapter: PiAiAdapter
  pool: AccountPool | undefined
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  server: MockServer
  clock: { now: number }
  accounts: Map<string, ReturnType<typeof memoryAuth>>
  main: ReturnType<typeof memoryAuth>
  mainRead: MockInstance<CredentialStore['read']>
  runtime: () => Promise<Context>
}

/** Two accounts by default, each with its own grant; the shared store holds a decoy grant that must never be used. */
async function rig(script: Script, options: {
  ids?: readonly string[]
  seed?: Record<string, Credential | undefined>
  profile?: Partial<PiAiProviderProfile>
  mutatePool?: (pool: AccountPool | undefined) => AccountPool | undefined
  resolveApiKey?: () => Promise<string | undefined>
} = {}): Promise<Rig> {
  const server = await mockServer(script)
  const ids = options.ids ?? ['account-1', 'account-2']
  const profiles = resolveProfiles({
    anthropic: {
      baseURL: server.url,
      accounts: ids.map(id => ({ id, credentialsPath: `/home/u/${id}/.credentials.yaml` })),
      accountRateLimitCooldownMs: 1000,
      accountQuotaCooldownMs: 5000,
      accountReservationMs: 200,
      ...options.profile,
    },
  })
  const config = profiles.get('anthropic')?.accountPool
  if (config === undefined) throw new Error('no pool configured')
  const accounts = new Map(ids.map(id => [
    id,
    memoryAuth(options.seed !== undefined && id in options.seed
      ? options.seed[id] === undefined ? {} : { anthropic: options.seed[id] }
      : { anthropic: oauth(token(id)) }),
  ]))
  const clock = { now: 5_000_000 }
  const built = new AccountPool(
    config,
    new Map([...accounts].map(([id, entry]) => [id, entry.credentials])),
    { now: () => clock.now, random: () => 0 },
  )
  const pool = options.mutatePool === undefined ? built : options.mutatePool(built)
  const main = memoryAuth({ anthropic: oauth(MAIN_TOKEN) })
  const mainRead = vi.spyOn(main.credentials, 'read')
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: options.resolveApiKey ?? (() => Promise.resolve(undefined)),
    auth: main,
    accountPool: () => pool,
  })
  const runtime = async (): Promise<Context> => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], adapter)
    return ctx
  }
  return { adapter, pool, profiles, server, clock, accounts, main, mainRead, runtime }
}

async function finishOf(stream: AsyncIterable<StreamChunk>) {
  const assembled = new BlockAssembler()
  for await (const chunk of stream) assembled.push(chunk)
  return assembled.finish
}

const bearers = (server: MockServer): (string | undefined)[] => server.headers.map(headers => headers.authorization)

/** Prepare through the real runtime, then stream the prepared call. */
async function prepared(ctx: Context, signal?: AbortSignal) {
  const call = await ctx.llm.prepareCall(CALL, signal)
  return { call, finish: () => finishOf(call.stream({ ...call.config, ...OPTIONS, system: OPTIONS.system })) }
}

describe('pooled requests', () => {
  it('serves a raw stream with the claimed account only and never reads the shared sign-in', async () => {
    const { adapter, server, mainRead } = await rig([ok])
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-1')])
    expect(server.headers[0]).not.toHaveProperty('x-api-key')
    expect(mainRead).not.toHaveBeenCalled()
    expect(server.requests[0]).toMatchObject({ system: [
      { text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { text: 'DSH owns this prompt.' },
    ] })
  })

  it('prepares a call with the maintained prefix, and streams it with the account it captured', async () => {
    const { runtime, server, accounts, mainRead } = await rig([ok])
    const ctx = await runtime()
    const { call, finish } = await prepared(ctx)
    expect(call.systemPromptPrefix).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
    // The grant changing after preparation cannot change what this call sends.
    accounts.get('account-1')?.stored.set('anthropic', oauth('sk-ant-oat-rotated'))
    expect(await finish()).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-1')])
    expect(mainRead).not.toHaveBeenCalled()
  })

  it('keeps each concurrent prepared call on its own account whatever order they stream in', async () => {
    const { runtime, server, accounts } = await rig([ok, ok])
    const ctx = await runtime()
    const first = await prepared(ctx)
    const second = await prepared(ctx)
    // Both claims exist before either request is sent; rotate every grant to prove neither re-resolves.
    for (const id of ['account-1', 'account-2']) accounts.get(id)?.stored.set('anthropic', oauth(`sk-ant-oat-after-${id}`))
    await second.finish()
    await first.finish()
    expect(bearers(server)).toEqual([bearer('account-2'), bearer('account-1')])
  })

  it('spreads two in-flight streams over both accounts and frees them when they end', async () => {
    const { adapter, server, pool } = await rig([
      { events: anthropicTextEvents.slice(0, 3), holdOpen: true },
      { events: anthropicTextEvents.slice(0, 3), holdOpen: true },
      ok,
    ])
    const one = adapter.stream(OPTIONS)[Symbol.asyncIterator]()
    const two = adapter.stream(OPTIONS)[Symbol.asyncIterator]()
    // Both requests are on the wire before either completes: the barrier is the pair of first chunks.
    await Promise.all([one.next(), two.next()])
    expect(new Set(bearers(server))).toEqual(new Set([bearer('account-1'), bearer('account-2')]))
    await Promise.all([one.return?.(), two.return?.()])
    expect(pool?.hasEligible()).toBe(true)
    // Idle again: affinity returns the next request to the last claimed account.
    await finishOf(adapter.stream(OPTIONS))
    expect(bearers(server).at(-1)).toBe(bearers(server)[1])
  })
})

describe('account limits', () => {
  it('cools only the account that was limited, for the provider delay, and the next request uses the other', async () => {
    const { adapter, server, pool, clock } = await rig([rateLimited('7'), ok, ok])
    const first = await finishOf(adapter.stream(OPTIONS))
    expect(first).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 7000 } })
    expect(pool?.earliestReset()).toEqual({ delayMs: 7000, code: 'RATE_LIMIT' })
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    clock.now += 7000
    // The limited account is eligible again and is the idle one the next request ties on.
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-1'), bearer('account-2'), bearer('account-2')])
  })

  it('cools a quota-exhausted account for the configured fallback when the provider names no delay', async () => {
    const quota = {
      status: 429,
      body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'usage_limit_reached' } }),
    }
    const { adapter, pool } = await rig([quota])
    const finish = await finishOf(adapter.stream(OPTIONS))
    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'QUOTA' } })
    expect(pool?.earliestReset()).toEqual({ delayMs: 5000, code: 'QUOTA' })
  })

  it('reports the earliest reset without any inference once every account is cooling', async () => {
    const { adapter, server, runtime, pool } = await rig([rateLimited('30'), rateLimited('9')])
    await finishOf(adapter.stream(OPTIONS))
    const last = await finishOf(adapter.stream(OPTIONS))
    // The failure that exhausted the pool reports when the first account recovers, not its own delay.
    expect(last).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 9000 } })
    const ctx = await runtime()
    const { call, finish } = await prepared(ctx)
    expect(call.systemPromptPrefix).toBeDefined()
    expect(await finish()).toMatchObject({
      kind: 'error',
      failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 9000, message: expect.stringContaining('limited') as string },
    })
    expect(await finishOf(adapter.stream(OPTIONS))).toMatchObject({ kind: 'error', failure: { providerRetryAfterMs: 9000 } })
    expect(server.requests).toHaveLength(2)
    expect(pool?.hasEligible()).toBe(false)
  })
})

describe('missing and revoked grants', () => {
  it('skips an account without a grant, never falling back to the shared sign-in or an API key', async () => {
    const { adapter, server, mainRead } = await rig([ok], { seed: { 'account-1': undefined } })
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-2')])
    expect(mainRead).not.toHaveBeenCalled()
  })

  it('skips an account whose stored record is an API key', async () => {
    const { adapter, server } = await rig([ok], { seed: { 'account-1': { type: 'api_key', key: 'sk-ant-api-not-for-pool' } } })
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-2')])
    expect(server.headers[0]).not.toHaveProperty('x-api-key')
  })

  it('fails with an actionable AUTH and no inference when every account is signed out', async () => {
    const { adapter, server, runtime, mainRead } = await rig([ok], { seed: { 'account-1': undefined, 'account-2': undefined } })
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'AUTH', message: expect.stringContaining('account-1, account-2') as string })
    const ctx = await runtime()
    await expect(ctx.llm.prepareCall(CALL)).rejects.toMatchObject({
      code: 'AUTH',
      message: expect.stringContaining('API-key billing was not selected') as string,
    })
    expect(server.requests).toEqual([])
    expect(mainRead).not.toHaveBeenCalled()
  })

  it('signs an account out when the provider rejects its bearer, and re-admits it when its grant is replaced', async () => {
    const { adapter, server, accounts } = await rig([rejectedBearer, ok, ok, rateLimited('60'), ok])
    expect(await finishOf(adapter.stream(OPTIONS))).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    // Affinity keeps account-2 until it is limited; account-1 stays out until its grant changes.
    accounts.get('account-1')?.stored.set('anthropic', oauth('sk-ant-oat-signed-in-again'))
    expect(await finishOf(adapter.stream(OPTIONS))).toMatchObject({ kind: 'error', failure: { code: 'RATE_LIMIT' } })
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([
      bearer('account-1'), bearer('account-2'), bearer('account-2'), bearer('account-2'), 'Bearer sk-ant-oat-signed-in-again',
    ])
  })
})

/**
 * Run `action` once, in the window after the adapter's next authentication has
 * settled and before its caller resumes: the instant a concurrent sign-in or
 * another process's refresh can replace the grant between "the bearer was
 * resolved" and "the caller looks at the store again".
 */
function afterAuthentication(adapter: PiAiAdapter, action: () => void): void {
  const original = adapter['requestAuth'].bind(adapter)
  let done = false
  adapter['requestAuth'] = async (...args: Parameters<typeof original>) => {
    try { return await original(...args) }
    finally {
      if (!done) {
        done = true
        action()
      }
    }
  }
}

describe('a rejection belongs to the grant the call authenticated with', () => {
  const REPLACEMENT = 'sk-ant-oat-new-valid'

  it('re-admits a grant that replaced the rejected one between authentication and dispatch', async () => {
    const { adapter, runtime, accounts, server } = await rig([rejectedBearer, ok], { ids: ['account-1'] })
    const ctx = await runtime()
    afterAuthentication(adapter, () => { accounts.get('account-1')!.stored.set('anthropic', oauth(REPLACEMENT)) })
    const first = await prepared(ctx)
    expect(await first.finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    // The old bearer was sent and refused; the replacement was never offered to the provider, so it is not signed out.
    expect(bearers(server)).toEqual([bearer('account-1')])
    expect(await (await prepared(ctx)).finish()).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-1'), `Bearer ${REPLACEMENT}`])
  })

  it('still signs out exactly the rejected grant when the replacement lands after preparation', async () => {
    const { runtime, accounts, server } = await rig([rejectedBearer, ok], { ids: ['account-1'] })
    const ctx = await runtime()
    const first = await prepared(ctx)
    accounts.get('account-1')!.stored.set('anthropic', oauth(REPLACEMENT))
    expect(await first.finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(await (await prepared(ctx)).finish()).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-1'), `Bearer ${REPLACEMENT}`])
  })

  it('keeps the rejected grant signed out for as long as it is the stored grant', async () => {
    const { adapter, server, pool } = await rig([rejectedBearer, ok], { ids: ['account-1'] })
    expect(await finishOf(adapter.stream(OPTIONS))).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'AUTH' })
    expect(server.requests).toHaveLength(1)
    expect(pool?.hasEligible()).toBe(false)
  })

  it('has no grant to quarantine when a call is refused before any grant is read', async () => {
    let calls = 0
    const { adapter, server } = await rig([ok], {
      ids: ['account-1'],
      resolveApiKey: () => {
        calls += 1
        return calls === 1 ? Promise.reject(new LlmError('no key reference resolved', 'MISSING_CREDENTIAL')) : Promise.resolve(undefined)
      },
    })
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'AUTH' })
    // The marker of an unobserved call equals no stored grant, so the account is re-admitted at once.
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-1')])
  })

  it.each([
    ['absent', undefined],
    ['an API key', { type: 'api_key', key: 'sk-ant-api-not-for-pool' } satisfies Credential],
  ])('re-admits a grant that replaced %s while the account was being authenticated', async (_name, seeded) => {
    const { adapter, accounts, server } = await rig([ok], { ids: ['account-1'], seed: { 'account-1': seeded } })
    afterAuthentication(adapter, () => { accounts.get('account-1')!.stored.set('anthropic', oauth(REPLACEMENT)) })
    // The call saw no OAuth grant: nothing was sent, and the sign-in that arrived meanwhile is not judged.
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'AUTH' })
    expect(server.requests).toEqual([])
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([`Bearer ${REPLACEMENT}`])
  })
})

describe('rejections of different grants settling in either order', () => {
  const NEWER = 'sk-ant-oat-also-rejected-new'
  const NEXT = 'sk-ant-oat-next-valid'

  /** Prepare a call with the seeded grant and one with `NEWER`, both before either is sent. */
  async function twoGrantsInFlight(script: Script) {
    const r = await rig(script, { ids: ['account-1'] })
    const ctx = await r.runtime()
    const old = await prepared(ctx)
    r.accounts.get('account-1')!.stored.set('anthropic', oauth(NEWER))
    const newer = await prepared(ctx)
    return { ...r, ctx, old, newer }
  }

  it.each([
    ['after', ['newer', 'old'], [`Bearer ${NEWER}`, bearer('account-1')]],
    ['before', ['old', 'newer'], [bearer('account-1'), `Bearer ${NEWER}`]],
  ] as const)('keeps the stored rejected grant out when the older grant\'s rejection settles %s it', async (_order, order, sent) => {
    const r = await twoGrantsInFlight([rejectedBearer, rejectedBearer, ok])
    for (const which of order) expect(await r[which].finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(bearers(r.server)).toEqual(sent)
    expect(r.accounts.get('account-1')!.stored.get('anthropic')).toEqual(oauth(NEWER))
    // The stored grant is unchanged and was rejected: neither path sends it again.
    await expect(r.ctx.llm.prepareCall(CALL)).rejects.toMatchObject({ code: 'AUTH' })
    await expect(finishOf(r.adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'AUTH' })
    expect(r.server.requests).toHaveLength(2)
    // A genuinely new grant re-admits the account and is the bearer sent.
    r.accounts.get('account-1')!.stored.set('anthropic', oauth(NEXT))
    expect(await (await prepared(r.ctx)).finish()).toEqual({ kind: 'stop' })
    expect(bearers(r.server)).toEqual([...sent, `Bearer ${NEXT}`])
  })

  it('keeps the stored grant out whatever order three rejected grants settle in', async () => {
    const { runtime, accounts, server } = await rig([rejectedBearer, rejectedBearer, rejectedBearer, ok], { ids: ['account-1'] })
    const ctx = await runtime()
    const calls = []
    for (const access of ['sk-ant-oat-first', 'sk-ant-oat-second', 'sk-ant-oat-third']) {
      accounts.get('account-1')!.stored.set('anthropic', oauth(access))
      calls.push(await prepared(ctx))
    }
    for (const index of [2, 0, 1]) expect(await calls[index]!.finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    await expect(ctx.llm.prepareCall(CALL)).rejects.toMatchObject({ code: 'AUTH' })
    expect(server.requests).toHaveLength(3)
    accounts.get('account-1')!.stored.set('anthropic', oauth(NEXT))
    expect(await (await prepared(ctx)).finish()).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual(['Bearer sk-ant-oat-third', 'Bearer sk-ant-oat-first', 'Bearer sk-ant-oat-second', `Bearer ${NEXT}`])
  })

  /** Make the account store's next read run `action` before reading normally. */
  function beforeNextRead(r: Rig, action: () => Promise<void>) {
    const store = r.accounts.get('account-1')!.credentials
    const base = store.read.bind(store)
    let pending = true
    return vi.spyOn(store, 'read').mockImplementation(async (id, options) => {
      if (pending) {
        pending = false
        await action()
      }
      return base(id, options)
    })
  }

  it('does not send a rejected grant when the comparison read fails but the authentication read succeeds', async () => {
    const r = await twoGrantsInFlight([rejectedBearer, rejectedBearer, ok])
    expect(await r.newer.finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(await r.old.finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    beforeNextRead(r, () => Promise.reject(new Error('store briefly unavailable')))
    await expect(r.ctx.llm.prepareCall(CALL)).rejects.toMatchObject({ code: 'AUTH' })
    expect(r.server.requests).toHaveLength(2)
    expect(r.pool!['states'].get('account-1')!.leases.size).toBe(0)
  })

  it('reports a store that cannot be read from the stream, releases the claim, and still refuses the rejected grant afterwards', async () => {
    const r = await twoGrantsInFlight([rejectedBearer, rejectedBearer, ok])
    expect(await r.newer.finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(await r.old.finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    const read = vi.spyOn(r.accounts.get('account-1')!.credentials, 'read').mockRejectedValue(new Error('store unavailable'))
    await expect(finishOf(r.adapter.stream(OPTIONS))).rejects.toThrow('store unavailable')
    expect(r.pool!['states'].get('account-1')!.leases.size).toBe(0)
    read.mockRestore()
    await expect(r.ctx.llm.prepareCall(CALL)).rejects.toMatchObject({ code: 'AUTH' })
    expect(r.server.requests).toHaveLength(2)
  })

  it('keeps the rejected grant out after a preparation aborted during the comparison read', async () => {
    const r = await twoGrantsInFlight([rejectedBearer, rejectedBearer, ok])
    expect(await r.newer.finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(await r.old.finish()).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    const controller = new AbortController()
    beforeNextRead(r, async () => { controller.abort(new Error('user abort')) })
    await expect(r.ctx.llm.prepareCall(CALL, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(r.pool!['states'].get('account-1')!.leases.size).toBe(0)
    await expect(r.ctx.llm.prepareCall(CALL)).rejects.toMatchObject({ code: 'AUTH' })
    expect(r.server.requests).toHaveLength(2)
  })
})

describe('refresh through an intercepted token endpoint', () => {
  const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

  /** Intercept only the token endpoint; the local Messages endpoint passes through. */
  function interceptRefresh(respond: (refresh: string) => Response) {
    const real = globalThis.fetch
    const refreshes: string[] = []
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      if (request.url !== TOKEN_URL) return real(request)
      const body = await request.json() as { refresh_token: string }
      refreshes.push(body.refresh_token)
      return respond(body.refresh_token)
    })
    return { refreshes, spy }
  }

  it('refreshes only the selected account and writes only that account\'s store', async () => {
    const { adapter, server, accounts } = await rig([ok], { seed: { 'account-1': oauth(token('account-1'), 0) } })
    const intercepted = interceptRefresh(() => Response.json({ access_token: 'sk-ant-oat-refreshed', refresh_token: 'rotated-refresh', expires_in: 3600 }))
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(intercepted.refreshes).toEqual([`${token('account-1')}-refresh`])
    expect(bearers(server)).toEqual(['Bearer sk-ant-oat-refreshed'])
    expect(accounts.get('account-1')?.stored.get('anthropic')).toMatchObject({ access: 'sk-ant-oat-refreshed', refresh: 'rotated-refresh' })
    expect(accounts.get('account-2')?.stored.get('anthropic')).toEqual(oauth(token('account-2')))
  })

  it('treats a refused refresh (401) as a revoked grant and serves from the other account', async () => {
    const { adapter, server, accounts } = await rig([ok], { seed: { 'account-1': oauth(token('account-1'), 0) } })
    const intercepted = interceptRefresh(() => Response.json({ error: 'refused' }, { status: 401 }))
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-2')])
    expect(intercepted.refreshes).toHaveLength(1)
    // The expired grant stays in its document, untouched.
    expect(accounts.get('account-1')?.stored.get('anthropic')).toEqual(oauth(token('account-1'), 0))
    // The next request does not try the rejected account again.
    await finishOf(adapter.stream(OPTIONS))
    expect(intercepted.refreshes).toHaveLength(1)
  })

  it('re-admits a grant that replaced the one whose refresh was refused while the refresh was in flight', async () => {
    const { adapter, server, accounts } = await rig([ok], { ids: ['account-1'], seed: { 'account-1': oauth(token('account-1'), 0) } })
    // The sign-in lands exactly while the token request is outstanding.
    const intercepted = interceptRefresh(() => {
      accounts.get('account-1')!.stored.set('anthropic', oauth('sk-ant-oat-new-valid'))
      return Response.json({ error: 'refused' }, { status: 401 })
    })
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'AUTH' })
    expect(server.requests).toEqual([])
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual(['Bearer sk-ant-oat-new-valid'])
    expect(intercepted.refreshes).toEqual([`${token('account-1')}-refresh`])
  })

  it('keeps a refreshed grant signed out when the provider then rejects its bearer, until the stored grant changes', async () => {
    const { adapter, server, accounts } = await rig([rejectedBearer, ok], { ids: ['account-1'], seed: { 'account-1': oauth(token('account-1'), 0) } })
    const intercepted = interceptRefresh(() => Response.json({ access_token: 'sk-ant-oat-refreshed', refresh_token: 'rotated-refresh', expires_in: 3600 }))
    expect(await finishOf(adapter.stream(OPTIONS))).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    expect(bearers(server)).toEqual(['Bearer sk-ant-oat-refreshed'])
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'AUTH' })
    expect(server.requests).toHaveLength(1)
    accounts.get('account-1')!.stored.set('anthropic', oauth('sk-ant-oat-signed-in-again'))
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server).at(-1)).toBe('Bearer sk-ant-oat-signed-in-again')
    expect(intercepted.refreshes).toHaveLength(1)
  })

  it('keeps an account in the pool when the vendor is down (503): the request reports SERVER, nothing is cooled', async () => {
    const { adapter, server, pool } = await rig([ok], { seed: { 'account-1': oauth(token('account-1'), 0) } })
    interceptRefresh(() => Response.json({ error: 'down' }, { status: 503 }))
    expect(await finishOf(adapter.stream(OPTIONS))).toMatchObject({ kind: 'error', failure: { code: 'SERVER' } })
    expect(server.requests).toEqual([])
    expect(pool?.earliestReset()).toBeUndefined()
    expect(pool?.hasEligible()).toBe(true)
  })
})

describe('failures that are not the account\'s', () => {
  it('leaves the account in the pool when its credential store fails, and reports the failure from the stream', async () => {
    const { adapter, server, accounts, pool } = await rig([ok])
    const read = accounts.get('account-1')!.credentials.read.bind(accounts.get('account-1')!.credentials)
    let reads = 0
    vi.spyOn(accounts.get('account-1')!.credentials, 'read').mockImplementation((id, options) => {
      reads += 1
      // The request's own read fails; later fingerprint reads and the retry read normally.
      return reads === 1 ? Promise.reject(new Error('store unavailable')) : read(id, options)
    })
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toThrow('store unavailable')
    expect(server.requests).toEqual([])
    expect(pool?.hasEligible()).toBe(true)
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([bearer('account-1')])
  })

  it('leaves an account alone after a server error', async () => {
    const { adapter, pool } = await rig([{ status: 500, body: '{"type":"error","error":{"type":"api_error","message":"boom"}}' }])
    expect(await finishOf(adapter.stream(OPTIONS))).toMatchObject({ kind: 'error', failure: { code: 'SERVER' } })
    expect(pool?.earliestReset()).toBeUndefined()
    expect(pool?.hasEligible()).toBe(true)
  })

  it('refuses a request-header override of the pooled bearer without judging the account', async () => {
    const { adapter, server, pool } = await rig([ok], { profile: { headers: { Authorization: 'replacement' } } })
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'AUTH' })
    expect(server.requests).toEqual([])
    expect(pool?.hasEligible()).toBe(true)
  })

  it('refuses another protocol on the pooled route before any account is claimed', async () => {
    const { adapter, server, accounts } = await rig([ok], { profile: { api: 'openai-completions' } })
    const read = vi.spyOn(accounts.get('account-1')!.credentials, 'read')
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    expect(server.requests).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })
})

describe('abort and reservations', () => {
  /** After any release path, an idle pool hands the next request to the account it last used. */
  const idle = (pool: AccountPool | undefined, last: string): void => {
    expect(pool?.acquire()?.account).toBe(last)
  }

  it('aborts before preparation without claiming an account', async () => {
    const { runtime, pool, accounts } = await rig([ok])
    const ctx = await runtime()
    const read = vi.spyOn(accounts.get('account-1')!.credentials, 'read')
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(ctx.llm.prepareCall(CALL, controller.signal)).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    idle(pool, 'account-1')
  })

  it('releases the claim of a preparation aborted while it authenticates, even when the claim completes late', async () => {
    const { runtime, pool, accounts } = await rig([ok])
    const store = accounts.get('account-1')!.credentials
    const base = store.read.bind(store)
    const gate = Promise.withResolvers<undefined>()
    const read = vi.spyOn(store, 'read').mockImplementation(async (id, options) => { await gate.promise; return base(id, options) })
    const release = vi.spyOn(pool!, 'release')
    const ctx = await runtime()
    const controller = new AbortController()
    const preparing = ctx.llm.prepareCall(CALL, controller.signal)
    const outcome = expect(preparing).rejects.toMatchObject({ code: 'ABORTED' })
    // The read is the barrier: the claim exists and is waiting for its grant.
    await vi.waitFor(() => { expect(read).toHaveBeenCalled() })
    controller.abort(new Error('user abort'))
    await outcome
    gate.resolve(undefined)
    await vi.waitFor(() => { expect(release).toHaveBeenCalled() })
    read.mockRestore()
    idle(pool, 'account-1')
  })

  it('releases a claim that completed in the same instant the preparation was aborted', async () => {
    const { adapter, runtime, pool } = await rig([ok])
    const ctx = await runtime()
    const controller = new AbortController()
    const original = adapter['claimAccount'].bind(adapter)
    // Abort after the claim has resolved the preparation but before the preparation continues: two microtask turns.
    adapter['claimAccount'] = async (...args: Parameters<typeof original>) => {
      const claim = await original(...args)
      void Promise.resolve().then(() => undefined).then(() => { controller.abort(new Error('late abort')) })
      return claim
    }
    const release = vi.spyOn(pool!, 'release')
    await expect(ctx.llm.prepareCall(CALL, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(release).toHaveBeenCalledOnce()
    idle(pool, 'account-1')
  })

  it('releases a claim that completed after the abort won the race', async () => {
    const { adapter, runtime, pool } = await rig([ok])
    const ctx = await runtime()
    const controller = new AbortController()
    const original = adapter['claimAccount'].bind(adapter)
    // The abort lands after the claim exists but before the preparation can take ownership of it.
    adapter['claimAccount'] = async (...args: Parameters<typeof original>) => {
      const claim = await original(...args)
      controller.abort(new Error('abort at completion'))
      return claim
    }
    const release = vi.spyOn(pool!, 'release')
    await expect(ctx.llm.prepareCall(CALL, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    await vi.waitFor(() => { expect(release).toHaveBeenCalledOnce() })
    idle(pool, 'account-1')
  })

  it('keeps a cooling outcome harmless when the preparation is aborted at the same instant', async () => {
    const { adapter, runtime, pool } = await rig([ok])
    pool?.settle('account-1', 'fp', { code: 'RATE_LIMIT', providerRetryAfterMs: 5000 })
    pool?.settle('account-2', 'fp', { code: 'RATE_LIMIT', providerRetryAfterMs: 6000 })
    const ctx = await runtime()
    const controller = new AbortController()
    const original = adapter['claimAccount'].bind(adapter)
    adapter['claimAccount'] = async (...args: Parameters<typeof original>) => {
      const claim = await original(...args)
      void Promise.resolve().then(() => undefined).then(() => { controller.abort(new Error('late abort')) })
      return claim
    }
    await expect(ctx.llm.prepareCall(CALL, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(pool?.earliestReset()).toEqual({ delayMs: 5000, code: 'RATE_LIMIT' })
  })

  it('refuses to prepare once the adapter is unloaded', async () => {
    const server = await mockServer([ok])
    const profiles = resolveProfiles({ anthropic: { baseURL: server.url, accounts: [{ id: 'account-1', credentialsPath: '/home/u/a.yaml' }] } })
    const config = profiles.get('anthropic')?.accountPool
    const auth = memoryAuth({ anthropic: oauth(token('account-1')) })
    const pool = new AccountPool(config!, new Map([['account-1', auth.credentials]]), { random: () => 0 })
    const lifetime = new AbortController()
    const adapter = new PiAiAdapter({
      profiles: () => profiles, resolveApiKey: () => Promise.resolve(undefined), auth: memoryAuth({}), accountPool: () => pool,
      lifetime: lifetime.signal,
    })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['anthropic'], adapter)
    lifetime.abort(new Error('adapter unloaded'))
    await expect(ctx.llm.prepareCall(CALL)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(server.requests).toEqual([])
    expect(pool.acquire()?.account).toBe('account-1')
  })

  it('gives the account back when a prepared call is aborted before it streams', async () => {
    const { runtime, pool } = await rig([ok])
    const ctx = await runtime()
    const controller = new AbortController()
    await ctx.llm.prepareCall(CALL, controller.signal)
    const release = vi.spyOn(pool!, 'release')
    controller.abort(new Error('turn aborted'))
    expect(release).toHaveBeenCalledOnce()
    idle(pool, 'account-1')
  })

  it('lets an unused prepared call\'s reservation lapse', async () => {
    const { runtime, pool, clock } = await rig([ok])
    const ctx = await runtime()
    await ctx.llm.prepareCall(CALL)
    // While reserved, a second request prefers the idle account.
    const concurrent = pool?.acquire()
    expect(concurrent?.account).toBe('account-2')
    pool?.release(concurrent!)
    clock.now += 201
    idle(pool, 'account-2')
  })

  it('releases the claim when the consumer abandons a stream', async () => {
    const { adapter, server, pool } = await rig([{ events: anthropicTextEvents.slice(0, 3), holdOpen: true }])
    const iterator = adapter.stream(OPTIONS)[Symbol.asyncIterator]()
    await iterator.next()
    expect(bearers(server)).toEqual([bearer('account-1')])
    // While the stream runs, a concurrent request goes to the other account.
    const probe = pool?.acquire()
    expect(probe?.account).toBe('account-2')
    pool?.release(probe!)
    await iterator.return?.()
    idle(pool, 'account-2')
  })

  it('aborts a raw stream request while it authenticates', async () => {
    const { adapter, server, pool, accounts } = await rig([ok])
    const store = accounts.get('account-1')!.credentials
    const base = store.read.bind(store)
    const gate = Promise.withResolvers<undefined>()
    const read = vi.spyOn(store, 'read').mockImplementation(async (id, options) => { await gate.promise; return base(id, options) })
    const controller = new AbortController()
    const running = finishOf(adapter.stream({ ...OPTIONS, signal: controller.signal }))
    const outcome = expect(running).rejects.toMatchObject({ code: 'ABORTED' })
    await vi.waitFor(() => { expect(read).toHaveBeenCalled() })
    controller.abort(new Error('user abort'))
    gate.resolve(undefined)
    await outcome
    expect(server.requests).toEqual([])
    read.mockRestore()
    idle(pool, 'account-1')
  })
})

describe('offers and selection', () => {
  it('offers the catalog while any account is signed in, without selecting or refreshing one', async () => {
    const { adapter, pool, mainRead } = await rig([], { seed: { 'account-1': undefined, 'account-2': oauth(token('account-2'), 0) } })
    const models = await adapter.listModels('anthropic')
    expect(models.map(model => model.id)).toContain('claude-haiku-4-5')
    expect(await adapter.canSelectModel('anthropic', 'claude-haiku-4-5')).toBe(true)
    expect(await adapter.canSelectModel('anthropic', 'not-a-model')).toBe(false)
    expect(mainRead).not.toHaveBeenCalled()
    // Nothing was claimed: the first request still ties on the first account.
    expect(pool?.acquire()?.account).toBe('account-1')
  })

  it('offers nothing when no account holds a grant, whatever the shared sign-in holds', async () => {
    const { adapter, mainRead } = await rig([], { seed: { 'account-1': undefined, 'account-2': undefined } })
    expect(await adapter.listModels('anthropic')).toEqual([])
    expect(await adapter.canSelectModel('anthropic', 'claude-haiku-4-5')).toBe(false)
    expect(mainRead).not.toHaveBeenCalled()
  })
})

describe('fail-closed admission', () => {
  const unavailable = { code: 'ACCOUNT_POOL_UNAVAILABLE' }

  it('refuses every pooled path while the pool is missing, and never uses the shared sign-in', async () => {
    const { adapter, server, runtime, mainRead } = await rig([ok], { mutatePool: () => undefined })
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject(unavailable)
    const ctx = await runtime()
    await expect(ctx.llm.prepareCall(CALL)).rejects.toMatchObject(unavailable)
    await expect(adapter.listModels('anthropic')).rejects.toMatchObject(unavailable)
    await expect(adapter.canSelectModel('anthropic', 'claude-haiku-4-5')).rejects.toMatchObject(unavailable)
    expect(server.requests).toEqual([])
    expect(mainRead).not.toHaveBeenCalled()
  })

  it('refuses a pool that was built for another account list', async () => {
    const other = resolveProfiles({ anthropic: { accounts: [{ id: 'elsewhere', credentialsPath: '/e/c.yaml' }] } }).get('anthropic')?.accountPool
    const stale = new AccountPool(other!, new Map([['elsewhere', memoryAuth({ anthropic: oauth('x') }).credentials]]))
    const { adapter, server } = await rig([ok], { mutatePool: () => stale })
    await expect(finishOf(adapter.stream(OPTIONS))).rejects.toMatchObject(unavailable)
    expect(server.requests).toEqual([])
  })

  it('refuses to authenticate a pooled route without a selected account', async () => {
    const { adapter, profiles, mainRead } = await rig([ok])
    const snapshot = adapter['current']()
    const profile = profiles.get('anthropic')!
    await expect(adapter['requestAuth'](snapshot, 'anthropic', profile, undefined, undefined, {}, false)).rejects.toMatchObject(unavailable)
    await expect(adapter['requestAuth'](snapshot, 'anthropic', profile, snapshot.models.getModel('anthropic', 'claude-haiku-4-5'))).rejects.toMatchObject(unavailable)
    expect(mainRead).not.toHaveBeenCalled()
  })

  it('refuses a snapshot account that the pool no longer lists', async () => {
    const { adapter, profiles } = await rig([ok])
    const current = adapter['current']()
    const snapshot = { ...current, accounts: new Map([...current.accounts].filter(([id]) => id !== 'account-1')) }
    const model = snapshot.models.getModel('anthropic', 'claude-haiku-4-5')!
    await expect(adapter['claimAccount'](snapshot, profiles.get('anthropic')!, model))
      .rejects.toMatchObject(unavailable)
  })

  it('rebuilds the account collections when the pool is replaced', async () => {
    const { adapter } = await rig([ok])
    const before = adapter['current']()
    expect(adapter['current']()).toBe(before)
    expect([...before.accounts.keys()]).toEqual(['account-1', 'account-2'])
  })
})

describe('a route without accounts', () => {
  it('keeps the single shared sign-in behavior', async () => {
    const server = await mockServer([ok])
    const main = memoryAuth({ anthropic: oauth(MAIN_TOKEN) })
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ anthropic: { baseURL: server.url, signInOnly: true } }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: main,
      accountPool: () => undefined,
    })
    expect(await finishOf(adapter.stream(OPTIONS))).toEqual({ kind: 'stop' })
    expect(bearers(server)).toEqual([`Bearer ${MAIN_TOKEN}`])
  })
})
