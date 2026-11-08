/** Account pool configuration and in-process selection state, with a manual clock and fixed randomness. */

import { describe, expect, it } from 'vitest'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { AccountPool, observeAccountStream } from '../src/account-pool.ts'
import type { AccountLease } from '../src/account-pool.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const grant = (access: string): Credential => ({ type: 'oauth', access, refresh: `${access}-refresh`, expires: 4102444800000 })

function resolveAccounts(profile: PiAiProviderProfile, provider = 'anthropic') {
  return resolveProfiles({ [provider]: profile }).get(provider)
}

describe('account pool configuration', () => {
  const accounts = [
    { id: 'account-1', credentialsPath: '/home/u/.dsh-1/.credentials.yaml' },
    { id: 'account-2', credentialsPath: '/home/u/.dsh-2/.credentials.yaml' },
  ]

  it('leaves a route without accounts untouched, including an empty list the schema materializes', () => {
    expect(resolveAccounts({})?.accountPool).toBeUndefined()
    expect(resolveAccounts({ accounts: [] })?.accountPool).toBeUndefined()
    expect(resolveAccounts({ signInOnly: true })?.requiresStoredCredential).toBe(true)
    expect(resolveAccounts({})?.requiresStoredCredential).not.toBe(true)
  })

  it('resolves accounts with defaulted cooldowns, requires a stored credential, and normalizes paths', () => {
    const profile = resolveAccounts({ accounts: [accounts[0]!, { id: 'account-2', credentialsPath: '/home/u/x/../.dsh-2/.credentials.yaml' }] })
    expect(profile?.requiresStoredCredential).toBe(true)
    expect(profile?.accountPool).toMatchObject({
      accounts: [accounts[0], accounts[1]],
      rateLimitCooldownMs: 300_000,
      quotaCooldownMs: 3_600_000,
      reservationMs: 30_000,
    })
    expect(profile).not.toHaveProperty('accounts')
    expect(profile).not.toHaveProperty('accountRateLimitCooldownMs')
  })

  it('carries configured cooldowns and gives different configurations different facts', () => {
    const tuned = resolveAccounts({ accounts, accountRateLimitCooldownMs: 1000, accountQuotaCooldownMs: 2000, accountReservationMs: 3000 })
    expect(tuned?.accountPool).toMatchObject({ rateLimitCooldownMs: 1000, quotaCooldownMs: 2000, reservationMs: 3000 })
    expect(tuned?.accountPool?.facts).not.toBe(resolveAccounts({ accounts })?.accountPool?.facts)
    expect(resolveAccounts({ accounts })?.accountPool?.facts).toBe(resolveAccounts({ accounts })?.accountPool?.facts)
  })

  it.each([
    ['a tunable without accounts', { accountReservationMs: 5 }, 'anthropic', /accountReservationMs without accounts/],
    ['accounts on another route', { accounts }, 'openai', /only the "anthropic" route/],
    ['accounts beside an API key reference', { accounts, apiKeyEnv: 'ANTHROPIC_API_KEY' }, 'anthropic', /never falls back to an API key/],
    ['an id outside the grammar', { accounts: [{ id: 'Account_1', credentialsPath: '/a' }] }, 'anthropic', /lowercase words/],
    ['a relative path', { accounts: [{ id: 'one', credentialsPath: 'creds.yaml' }] }, 'anthropic', /must be an absolute path/],
    ['a repeated id', { accounts: [{ id: 'one', credentialsPath: '/a' }, { id: 'one', credentialsPath: '/b' }] }, 'anthropic', /repeats account id "one"/],
    [
      'a repeated document',
      { accounts: [{ id: 'one', credentialsPath: '/a/c.yaml' }, { id: 'two', credentialsPath: '/a/../a/c.yaml' }] },
      'anthropic', /repeats a credentials document/,
    ],
    ['a non-finite cooldown', { accounts, accountRateLimitCooldownMs: Number.POSITIVE_INFINITY }, 'anthropic', /accountRateLimitCooldownMs must be a positive finite/],
    ['a zero reservation', { accounts, accountReservationMs: 0 }, 'anthropic', /accountReservationMs must be a positive finite/],
  ] as const)('rejects %s', (_name, profile, provider, message) => {
    expect(() => resolveAccounts(profile as PiAiProviderProfile, provider)).toThrow(message)
  })
})

/** A two-or-more account pool over in-memory stores and a manual clock. */
function makePool(options: {
  ids?: readonly string[]
  seed?: Record<string, Credential | undefined>
  random?: () => number
  profile?: Partial<PiAiProviderProfile>
} = {}) {
  const ids = options.ids ?? ['account-1', 'account-2']
  const config = resolveAccounts({
    accounts: ids.map(id => ({ id, credentialsPath: `/home/u/${id}/.credentials.yaml` })),
    accountRateLimitCooldownMs: 1000,
    accountQuotaCooldownMs: 5000,
    accountReservationMs: 200,
    ...options.profile,
  })?.accountPool
  if (config === undefined) throw new Error('no pool')
  const auth = new Map(ids.map(id => [id, memoryAuth(options.seed?.[id] === undefined && options.seed !== undefined && id in options.seed
    ? {}
    : { anthropic: options.seed?.[id] ?? grant(id) })]))
  const clock = { now: 1_000_000 }
  const pool = new AccountPool(
    config,
    new Map([...auth].map(([id, entry]) => [id, entry.credentials])),
    { now: () => clock.now, random: options.random ?? (() => 0) },
  )
  return { pool, clock, auth }
}

function claim(pool: AccountPool): AccountLease {
  const lease = pool.acquire()
  if (lease === undefined) throw new Error('no eligible account')
  return lease
}

describe('account selection', () => {
  it('breaks the first tie with the injected randomness and then sticks to that account while it is idle', () => {
    const low = makePool({ random: () => 0 })
    expect(claim(low.pool).account).toBe('account-1')
    const high = makePool({ random: () => 0.99 })
    const first = claim(high.pool)
    expect(first.account).toBe('account-2')
    high.pool.release(first)
    // Idle again: affinity keeps the conversation on the account whose prompt cache is warm.
    expect(claim(high.pool).account).toBe('account-2')
  })

  it('sends a concurrent request to the other account and prefers the least loaded', () => {
    const { pool } = makePool()
    const first = claim(pool)
    const second = claim(pool)
    expect(new Set([first.account, second.account])).toEqual(new Set(['account-1', 'account-2']))
    // Both carry one call; the third ties and returns to the last-used account.
    expect(claim(pool).account).toBe(second.account)
  })

  it('stops counting an unstarted claim when its reservation expires, but never a running stream', () => {
    const { pool, clock } = makePool()
    const unstarted = claim(pool)
    const running = claim(pool)
    expect([unstarted.account, running.account]).toEqual(['account-1', 'account-2'])
    pool.start(running)
    // Still reserved: both accounts carry one call, so the tie returns to the last-used account.
    clock.now += 199
    const tie = claim(pool)
    expect(tie.account).toBe('account-2')
    pool.release(tie)
    // The unstarted claim lapsed; the running stream still counts, so the idle account is chosen.
    clock.now += 2
    expect(claim(pool).account).toBe('account-1')
    pool.release(running)
    pool.release(running)
  })

  it('does not treat a released claim as load', () => {
    const { pool } = makePool()
    const first = claim(pool)
    pool.release(first)
    expect(claim(pool).account).toBe(first.account)
  })

  it('rejects an account that was never configured and a store that is missing', () => {
    const { pool } = makePool()
    expect(() => pool.store('account-9')).toThrow('unknown account "account-9"')
    const config = resolveAccounts({ accounts: [{ id: 'only', credentialsPath: '/o.yaml' }] })?.accountPool
    expect(() => new AccountPool(config!, new Map())).toThrow('no credential store for account "only"')
    expect(pool.accounts).toEqual(['account-1', 'account-2'])
    expect(pool.facts).toContain('account-1')
  })
})

describe('account availability', () => {
  it('cools only the failed account for the provider delay and re-admits it when the delay passes', () => {
    const { pool, clock } = makePool()
    const failed = claim(pool)
    pool.settle(failed.account, 'fp', { code: 'RATE_LIMIT', providerRetryAfterMs: 400 })
    pool.release(failed)
    for (let index = 0; index < 3; index++) {
      const lease = claim(pool)
      expect(lease.account).not.toBe(failed.account)
      pool.release(lease)
    }
    expect(pool.earliestReset()).toEqual({ delayMs: 400, code: 'RATE_LIMIT' })
    clock.now += 400
    expect(pool.earliestReset()).toBeUndefined()
    expect(pool.hasEligible()).toBe(true)
  })

  it('uses the configured fallback cooldown per limit kind and never shortens a longer cooldown', () => {
    const { pool } = makePool()
    pool.settle('account-1', 'fp', { code: 'RATE_LIMIT' })
    expect(pool.earliestReset()).toEqual({ delayMs: 1000, code: 'RATE_LIMIT' })
    pool.settle('account-1', 'fp', { code: 'QUOTA' })
    expect(pool.earliestReset()).toEqual({ delayMs: 5000, code: 'QUOTA' })
    pool.settle('account-1', 'fp', { code: 'RATE_LIMIT', providerRetryAfterMs: 10 })
    expect(pool.earliestReset()).toEqual({ delayMs: 5000, code: 'QUOTA' })
    pool.settle('account-2', 'fp', { code: 'ACCOUNT_QUOTA', providerRetryAfterMs: 4000 })
    expect(pool.earliestReset()).toEqual({ delayMs: 4000, code: 'ACCOUNT_QUOTA' })
  })

  it.each(['SERVER', 'TIMEOUT', 'TRANSPORT', 'INVALID_REQUEST', 'ABORTED'])('leaves an account alone after a %s failure', (code) => {
    const { pool } = makePool()
    pool.settle('account-1', 'fp', { code })
    expect(pool.earliestReset()).toBeUndefined()
    expect(pool.hasEligible()).toBe(true)
    expect(new Set([claim(pool).account, claim(pool).account])).toEqual(new Set(['account-1', 'account-2']))
  })

  it('reports the earliest reset across accounts and ignores a signed-out account', () => {
    const { pool } = makePool({ ids: ['account-1', 'account-2', 'account-3'] })
    pool.settle('account-1', 'fp', { code: 'RATE_LIMIT', providerRetryAfterMs: 900 })
    pool.settle('account-2', 'fp', { code: 'RATE_LIMIT', providerRetryAfterMs: 300 })
    pool.markSignedOut('account-2', 'fp')
    pool.settle('account-3', 'fp', { code: 'QUOTA', providerRetryAfterMs: 700 })
    expect(pool.earliestReset()).toEqual({ delayMs: 700, code: 'QUOTA' })
    expect(pool.coolingFailure({ delayMs: 700, code: 'QUOTA' })).toMatchObject({ code: 'QUOTA', providerRetryAfterMs: 700 })
    expect(pool.acquire()).toBeUndefined()
  })

  it('keeps the sooner reset when a later account resets later', () => {
    const { pool } = makePool()
    pool.settle('account-1', 'fp', { code: 'RATE_LIMIT', providerRetryAfterMs: 300 })
    pool.settle('account-2', 'fp', { code: 'QUOTA', providerRetryAfterMs: 900 })
    expect(pool.earliestReset()).toEqual({ delayMs: 300, code: 'RATE_LIMIT' })
  })

  it('signs an account out on AUTH and re-admits it only when its stored grant changes', async () => {
    const { pool, auth } = makePool()
    const original = await pool.fingerprint('account-1')
    pool.settle('account-1', original, { code: 'AUTH' })
    await pool.readmit()
    expect(claim(pool).account).toBe('account-2')
    expect(claim(pool).account).toBe('account-2')
    auth.get('account-1')?.stored.set('anthropic', grant('replacement'))
    await pool.readmit()
    const seen = new Set([claim(pool).account, claim(pool).account, claim(pool).account])
    expect(seen).toContain('account-1')
  })

  it('keeps an account signed out while a concurrent sign-out replaces the observed marker', async () => {
    const { pool, auth } = makePool()
    pool.markSignedOut('account-1', 'stale-fingerprint')
    const readmitting = pool.readmit()
    pool.markSignedOut('account-1', 'newer-fingerprint')
    auth.get('account-1')?.stored.set('anthropic', grant('replacement'))
    await readmitting
    expect(pool.hasEligible()).toBe(true)
    expect([claim(pool).account]).toEqual(['account-2'])
  })

  it('fingerprints a missing grant as absent and an unreadable store as unreadable', async () => {
    const { pool, auth } = makePool({ seed: { 'account-1': undefined } })
    expect(await pool.fingerprint('account-1')).toBe('absent')
    expect(await pool.fingerprint('account-2')).toMatch(/^[0-9a-f]{64}$/)
    const broken: CredentialStore = { ...auth.get('account-1')!.credentials, read: () => Promise.reject(new Error('denied')) }
    const config = resolveAccounts({ accounts: [{ id: 'one', credentialsPath: '/o.yaml' }] })?.accountPool
    expect(await new AccountPool(config!, new Map([['one', broken]])).fingerprint('one')).toBe('unreadable')
  })

  it('reports a grant only when some account holds an OAuth grant, reading each store without selecting one', async () => {
    const empty = makePool({ seed: { 'account-1': undefined, 'account-2': { type: 'api_key', key: 'k' } } })
    expect(await empty.pool.hasGrant()).toBe(false)
    expect(await empty.pool.hasGrant(new AbortController().signal)).toBe(false)
    const one = makePool({ seed: { 'account-1': undefined } })
    expect(await one.pool.hasGrant()).toBe(true)
    expect(one.pool.acquire()).toBeDefined()
  })

  it('describes an all-signed-out pool without naming a credential', () => {
    const { pool } = makePool()
    const error = pool.signedOutError()
    expect(error).toMatchObject({ code: 'AUTH' })
    expect(error.message).toContain('account-1, account-2')
    expect(error.message).toContain('API-key billing was not selected')
  })
})

async function* chunks(...items: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const item of items) yield item
}
const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const failure = (code: string, providerRetryAfterMs?: number): StreamChunk => ({
  type: 'finish',
  reason: { kind: 'error', failure: { message: code, code, ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs } } },
})

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = []
  for await (const chunk of stream) seen.push(chunk)
  return seen
}

describe('account stream observation', () => {
  it('counts a stream as load from its first pull and releases it when it ends', async () => {
    const { pool } = makePool()
    const lease = claim(pool)
    const other = claim(pool)
    const stream = observeAccountStream(pool, lease, 'fp', chunks({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }, stop))
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    expect(lease.started).toBe(true)
    await drain({ [Symbol.asyncIterator]: () => iterator })
    expect(pool.hasEligible()).toBe(true)
    pool.release(other)
    // Both are idle again and the last claim wins the tie.
    expect(claim(pool).account).toBe(other.account)
  })

  it('cools the serving account on a limit, passes the provider delay on while another account is eligible', async () => {
    const { pool } = makePool()
    const lease = claim(pool)
    const seen = await drain(observeAccountStream(pool, lease, 'fp', chunks(failure('RATE_LIMIT', 250))))
    expect(seen).toEqual([failure('RATE_LIMIT', 250)])
    expect(pool.earliestReset()).toEqual({ delayMs: 250, code: 'RATE_LIMIT' })
    expect(pool.hasEligible()).toBe(true)
  })

  it('rewrites the delay to the earliest reset when the failure leaves no eligible account', async () => {
    const { pool } = makePool()
    pool.settle('account-2', 'fp', { code: 'QUOTA', providerRetryAfterMs: 600 })
    const lease = claim(pool)
    expect(lease.account).toBe('account-1')
    const seen = await drain(observeAccountStream(pool, lease, 'fp', chunks(failure('RATE_LIMIT', 4000))))
    expect(seen).toEqual([failure('RATE_LIMIT', 600)])
  })

  it('signs the account out on AUTH without touching the failure', async () => {
    const { pool } = makePool()
    const lease = claim(pool)
    expect(await drain(observeAccountStream(pool, lease, 'fp', chunks(failure('AUTH'))))).toEqual([failure('AUTH')])
    expect(claim(pool).account).toBe('account-2')
    expect(pool.acquire()?.account).toBe('account-2')
  })

  it('leaves the account alone after a transient or aborted terminal chunk', async () => {
    const { pool } = makePool()
    const lease = claim(pool)
    const aborted: StreamChunk = { type: 'finish', reason: { kind: 'aborted', failure: { message: 'a', code: 'ABORTED' } } }
    expect(await drain(observeAccountStream(pool, lease, 'fp', chunks(failure('SERVER'), aborted)))).toHaveLength(2)
    expect(pool.earliestReset()).toBeUndefined()
    expect(pool.hasEligible()).toBe(true)
  })

  it('releases the claim when the consumer stops early or the stream throws, without judging the account', async () => {
    const { pool } = makePool()
    const early = claim(pool)
    for await (const chunk of observeAccountStream(pool, early, 'fp', chunks(stop, stop))) {
      expect(chunk).toBe(stop)
      break
    }
    const thrown = claim(pool)
    await expect(drain(observeAccountStream(pool, thrown, 'fp', (async function* () { throw new Error('boom') })()))).rejects.toThrow('boom')
    expect(pool.earliestReset()).toBeUndefined()
    // Neither claim still counts: the next claim ties and takes the last-used account.
    expect(claim(pool).account).toBe(thrown.account)
    expect(claim(pool).account).not.toBe(thrown.account)
  })
})
