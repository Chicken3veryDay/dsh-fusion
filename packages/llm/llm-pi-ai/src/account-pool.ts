/**
 * In-process selection state for an `anthropic` route that chooses between
 * several Claude subscription accounts per request.
 *
 * Every account keeps its grant in its own credentials document, and that
 * document's credentials service owns the refresh lock and the refresh write;
 * this module never reads a grant to copy it, only to detect that it changed.
 * A request claims one account at prepare time, authenticates with that
 * account's store, and carries the claim to its stream, so concurrent requests
 * cannot see each other's account.
 *
 * Selection prefers the account that served the previous request while it is
 * idle, which keeps a conversation on one account (and its prompt cache), and
 * spreads concurrent requests by the number of calls each account carries. An
 * account a provider limit put on cooldown, or whose grant the provider
 * rejected, is skipped until the cooldown ends or its stored grant changes.
 * Rejections of different grants can settle in any order, so the account
 * remembers each rejected grant until a read shows it is no longer stored, and
 * a call never proceeds with a grant the provider already rejected.
 * The state lives in this process only: another DSH process learns about a
 * limited account by hitting the limit itself, and a restart forgets cooldowns.
 *
 * @module dsh-llm-pi-ai/account-pool
 */

import { createHash } from 'node:crypto'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResolvedAccountPool } from './config.ts'

/** The pi-ai provider id every pooled account stores its grant under. */
const PROVIDER = 'anthropic'

/** Injectable time and randomness; production uses the clock and `Math.random`. */
export interface AccountPoolHooks {
  /** Current time in epoch milliseconds. */
  now?: () => number
  /** Random sample in `[0, 1)` that breaks a tie between equally loaded accounts. */
  random?: () => number
}

/**
 * One call's claim on an account. A claim whose stream never starts stops
 * counting as load when `expiresAt` passes; a started one counts until released.
 */
export interface AccountLease {
  /** The claimed account's id. */
  readonly account: string
  /** The time after which an unstarted claim stops counting as load. */
  readonly expiresAt: number
  /** Whether the call's stream began; a started claim never expires. */
  started: boolean
}

/** The failure facts that decide how an account's availability changes. */
export interface AccountFailure {
  /** Provider-neutral failure code. */
  readonly code: string
  /** Delay the provider asked for, when it named one. */
  readonly providerRetryAfterMs?: number
}

interface AccountState {
  readonly store: CredentialStore
  readonly leases: Set<AccountLease>
  /** Set while a provider limit keeps the account out of selection. */
  cooling?: { until: number; code: string }
  /** Whether a rejection keeps the account out until a read shows a grant outside {@link rejected}. */
  signedOut: boolean
  /**
   * Fingerprints of the grants the provider rejected that may still be stored.
   * Replaced, never mutated, on each rejection; {@link AccountPool.readmit}
   * narrows it to the stored grant, so it holds at most the rejections that
   * settled since the last successful read.
   */
  rejected: ReadonlySet<string>
}

/** Whether a failure code is a provider limit on the account rather than on the request. */
function isLimit(code: string): boolean {
  return code === 'RATE_LIMIT' || code === QUOTA_EXCEEDED_CODE || code === ACCOUNT_QUOTA_EXCEEDED_CODE
}

/**
 * The identity of one stored grant: a digest that changes exactly when the grant does.
 * @param stored - the credential a store returned, or undefined when it held none.
 * @returns a hex digest, or `absent` for no credential.
 */
export function grantFingerprint(stored: Credential | undefined): string {
  return stored === undefined ? 'absent' : createHash('sha256').update(JSON.stringify(stored)).digest('hex')
}

/** A credential store that reports which grant the authentication using it last relied on. */
export interface GrantObserver {
  /** The store to authenticate through; it behaves exactly like the one it wraps. */
  readonly store: CredentialStore
  /**
   * The identity of the grant the authentication ended on, or undefined before
   * any grant was read. It is the last grant a read returned or a refresh
   * lock saw, so it is the grant a resolved bearer came from, or the grant a
   * refresh was refused for, even when the stored grant is replaced afterwards.
   * `unreadable` stands for a read that failed.
   */
  observed(): string | undefined
}

/**
 * Wrap one account's store for the duration of one authentication, so the
 * grant that authentication used is known without reading the store again: a
 * later read describes the store as it is then, not the grant this call holds.
 * @param store - the account's own credential store.
 * @returns the observing store and its observation; use one per authentication.
 */
export function observeGrant(store: CredentialStore): GrantObserver {
  let observed: string | undefined
  return {
    store: {
      async read(providerId, options) {
        let stored: Credential | undefined
        try { stored = await store.read(providerId, options) }
        catch (unreadable) {
          // The caller's own read reports the failure; the observation records that no grant was seen.
          observed = 'unreadable'
          throw unreadable
        }
        observed = grantFingerprint(stored)
        return stored
      },
      list: options => store.list(options),
      async modify(providerId, mutate, options) {
        const result = await store.modify(providerId, (current) => {
          // The refresh runs against this grant under the store's lock; a refusal is about it.
          observed = grantFingerprint(current)
          return mutate(current)
        }, options)
        observed = grantFingerprint(result)
        return result
      },
      delete: (providerId, options) => store.delete(providerId, options),
    },
    observed: () => observed,
  }
}

/** The in-process availability and load of the accounts of one pooled route. */
export class AccountPool {
  /** Identity of the configuration this pool was built from. */
  readonly facts: string
  private readonly states = new Map<string, AccountState>()
  private readonly now: () => number
  private readonly random: () => number
  private last: string | undefined

  /**
   * @param config - the validated pool configuration.
   * @param stores - each account's credential store, over that account's own document.
   * @param hooks - clock and randomness overrides for deterministic tests.
   */
  constructor(
    private readonly config: ResolvedAccountPool,
    stores: ReadonlyMap<string, CredentialStore>,
    hooks: AccountPoolHooks = {},
  ) {
    this.facts = config.facts
    this.now = hooks.now ?? Date.now
    this.random = hooks.random ?? Math.random
    for (const { id } of config.accounts) {
      const store = stores.get(id)
      if (store === undefined) throw new Error(`llm-pi-ai: no credential store for account "${id}"`)
      this.states.set(id, { store, leases: new Set(), signedOut: false, rejected: new Set() })
    }
  }

  /** The account ids in configuration order. */
  get accounts(): readonly string[] {
    return this.config.accounts.map(account => account.id)
  }

  /**
   * The credential store of one account.
   * @param account - an id from {@link accounts}.
   * @returns the store over that account's own credentials document.
   */
  store(account: string): CredentialStore {
    return this.state(account).store
  }

  private state(account: string): AccountState {
    const state = this.states.get(account)
    if (state === undefined) throw new Error(`llm-pi-ai: unknown account "${account}"`)
    return state
  }

  /**
   * A digest that changes exactly when the account's stored grant changes.
   * @param account - an id from {@link accounts}.
   * @param signal - cancellation of the credential read.
   * @returns a hex digest, `absent` while no grant is stored, or `unreadable`
   *   when the store could not be read; callers that need the failure learn it
   *   from their own read, and the next fingerprint then differs from `unreadable`.
   */
  async fingerprint(account: string, signal?: AbortSignal): Promise<string> {
    let stored: Awaited<ReturnType<CredentialStore['read']>>
    try { stored = await this.state(account).store.read(PROVIDER, signal === undefined ? undefined : { signal }) }
    catch (unreadable) {
      // An unreadable store has no grant to compare; the caller's own read reports the failure.
      void unreadable
      return 'unreadable'
    }
    return grantFingerprint(stored)
  }

  /**
   * Whether any account holds an OAuth grant. Reads each account's own store
   * and never refreshes or selects one.
   * @param signal - cancellation of the credential reads.
   * @returns true when at least one account is signed in.
   */
  async hasGrant(signal?: AbortSignal): Promise<boolean> {
    const options = signal === undefined ? undefined : { signal }
    const stored = await Promise.all(this.accounts.map(account => this.state(account).store.read(PROVIDER, options)))
    return stored.some(credential => credential?.type === 'oauth')
  }

  /**
   * Re-admit every signed-out account whose stored grant is none of the grants
   * the provider rejected, which is how a new sign-in or an external edit takes
   * effect without a restart. A stored grant that was rejected keeps the
   * account out whichever rejection settled last. A rejection that settles
   * during the read leaves the account out until the next readmission. An
   * unreadable store re-admits the account so that its authentication reports
   * the failure; {@link isRejected} still refuses a rejected grant that
   * authentication then reads.
   * @param signal - cancellation of the credential reads.
   */
  async readmit(signal?: AbortSignal): Promise<void> {
    await Promise.all(this.accounts.map(async (account) => {
      const state = this.state(account)
      if (!state.signedOut) return
      const { rejected } = state
      const stored = await this.fingerprint(account, signal)
      if (state.rejected !== rejected) return
      if (stored === 'unreadable') state.signedOut = false
      else if (rejected.has(stored)) state.rejected = new Set([stored])
      else {
        state.signedOut = false
        state.rejected = new Set()
      }
    }))
  }

  /**
   * Whether the provider rejected this grant of the account, and the grant may still be stored.
   * @param account - an id from {@link accounts}.
   * @param fingerprint - the identity of the grant a call authenticated with.
   * @returns true when a call must not use that grant.
   */
  isRejected(account: string, fingerprint: string): boolean {
    return this.state(account).rejected.has(fingerprint)
  }

  private eligible(state: AccountState, at: number): boolean {
    return !state.signedOut && (state.cooling === undefined || state.cooling.until <= at)
  }

  /** Calls the account carries now: started streams plus unexpired claims. */
  private load(state: AccountState, at: number): number {
    for (const lease of state.leases) {
      if (!lease.started && lease.expiresAt <= at) state.leases.delete(lease)
    }
    return state.leases.size
  }

  /**
   * Claim the best eligible account: the least loaded, preferring the account
   * that served the previous claim, then a random one among equals. Synchronous,
   * so two callers can never claim the same idle account.
   * @returns the claim, or undefined when no account is eligible.
   */
  acquire(): AccountLease | undefined {
    const at = this.now()
    const candidates = this.accounts.filter(account => this.eligible(this.state(account), at))
    if (candidates.length === 0) return undefined
    const loads = new Map(candidates.map(account => [account, this.load(this.state(account), at)]))
    const least = Math.min(...loads.values())
    const tied = candidates.filter(account => loads.get(account) === least)
    const account = this.last !== undefined && tied.includes(this.last)
      ? this.last
      : tied[Math.floor(this.random() * tied.length)] as string
    this.last = account
    const lease: AccountLease = { account, expiresAt: at + this.config.reservationMs, started: false }
    this.state(account).leases.add(lease)
    return lease
  }

  /**
   * Mark a claim's stream as running, so it counts until released.
   * @param lease - a claim from {@link acquire}.
   */
  start(lease: AccountLease): void {
    lease.started = true
    this.state(lease.account).leases.add(lease)
  }

  /**
   * Drop a claim. Releasing twice, or after expiry, is harmless.
   * @param lease - a claim from {@link acquire}.
   */
  release(lease: AccountLease): void {
    this.state(lease.account).leases.delete(lease)
  }

  /**
   * Record that the provider rejected the grant an account served with.
   * @param account - the rejected account.
   * @param fingerprint - the identity of the grant the request used, from {@link GrantObserver.observed}.
   */
  markSignedOut(account: string, fingerprint: string): void {
    const state = this.state(account)
    state.rejected = new Set([...state.rejected, fingerprint])
    state.signedOut = true
  }

  /**
   * Whether some account can be claimed right now.
   * @returns true when at least one account is neither cooling nor signed out.
   */
  hasEligible(): boolean {
    const at = this.now()
    return this.accounts.some(account => this.eligible(this.state(account), at))
  }

  /**
   * The soonest moment a cooling, still signed-in account becomes eligible.
   * @returns the delay and the limit code that cooled that account, or undefined when none is cooling.
   */
  earliestReset(): { readonly delayMs: number; readonly code: string } | undefined {
    const at = this.now()
    let earliest: { readonly delayMs: number; readonly code: string } | undefined
    for (const account of this.accounts) {
      const { cooling, signedOut } = this.state(account)
      if (signedOut || cooling === undefined || cooling.until <= at) continue
      const delayMs = Math.ceil(cooling.until - at)
      if (earliest === undefined || delayMs < earliest.delayMs) earliest = { delayMs, code: cooling.code }
    }
    return earliest
  }

  /**
   * The terminal failure for a request that finds every account signed out.
   * @returns an `AUTH` error naming the accounts, never a credential.
   */
  signedOutError(): LlmError {
    return new LlmError(
      `No Claude subscription account of the pool is signed in (${this.accounts.join(', ')});`
      + ' sign in to each account again. API-key billing was not selected.',
      'AUTH',
    )
  }

  /**
   * The failure a request reports when every signed-in account is cooling.
   * @param reset - the earliest reset from {@link earliestReset}.
   * @returns a failure whose delay is that reset, so the retry owner waits instead of requesting.
   */
  coolingFailure(reset: { readonly delayMs: number; readonly code: string }): LlmFailure {
    return {
      message: `Every signed-in Claude subscription account is limited; the earliest is available again in ${Math.ceil(reset.delayMs / 1000)}s.`,
      code: reset.code,
      providerRetryAfterMs: reset.delayMs,
    }
  }

  /**
   * Apply one failed call's effect to the account that served it. Provider
   * limits cool the account for the delay the provider named (or the
   * configured fallback); a rejected grant signs the account out; every other
   * failure leaves the account alone, so a transient outage never flaps it.
   * @param account - the account that served the call.
   * @param fingerprint - the digest of the grant the call used.
   * @param failure - the call's failure facts.
   */
  settle(account: string, fingerprint: string, failure: AccountFailure): void {
    const state = this.state(account)
    if (failure.code === 'AUTH') {
      this.markSignedOut(account, fingerprint)
      return
    }
    if (!isLimit(failure.code)) return
    const fallback = failure.code === 'RATE_LIMIT' ? this.config.rateLimitCooldownMs : this.config.quotaCooldownMs
    const until = this.now() + (failure.providerRetryAfterMs ?? fallback)
    if (state.cooling === undefined || state.cooling.until < until) state.cooling = { until, code: failure.code }
  }
}

/**
 * Carry a claim through one account's stream: mark it running on the first
 * pull, apply its terminal failure to the account, and release the claim when
 * the stream ends, fails or is abandoned. When a provider limit leaves no
 * eligible account, the failure's delay becomes the earliest reset among all
 * accounts, so the retry owner waits for the first one to recover.
 * @param pool - the pool that issued the claim.
 * @param lease - the claim of this call.
 * @param fingerprint - the digest of the grant this call authenticated with.
 * @param inner - the call's chunks.
 * @yields the chunks, with a terminal failure's delay adjusted as described.
 * @returns the generator over the adjusted chunks.
 */
export async function* observeAccountStream(
  pool: AccountPool,
  lease: AccountLease,
  fingerprint: string,
  inner: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  pool.start(lease)
  try {
    for await (const chunk of inner) {
      if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') {
        yield chunk
        continue
      }
      const { failure } = chunk.reason
      pool.settle(lease.account, fingerprint, failure)
      const reset = isLimit(failure.code) && !pool.hasEligible() ? pool.earliestReset() : undefined
      yield reset === undefined
        ? chunk
        : { ...chunk, reason: { kind: 'error', failure: { ...failure, providerRetryAfterMs: reset.delayMs } } }
    }
  } finally {
    // A thrown error never reaches here as a provider verdict: provider
    // rejections arrive as error finish chunks, so a throw says nothing about
    // the account's grant or limits and leaves its availability alone.
    pool.release(lease)
  }
}
