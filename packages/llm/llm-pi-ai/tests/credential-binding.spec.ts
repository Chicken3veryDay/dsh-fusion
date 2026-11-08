/** Stored sign-in routes follow the lifecycle of the credential store they were read from. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '../src/index.ts'

type Listing = readonly { key: CredentialKey; kind: 'grant' }[]

const grant = (provider: string): Listing[number] => ({ key: PiAi.recordKeyFor(provider), kind: 'grant' })

/** A credentials service whose listings the test releases one at a time. */
function gatedStore(initial: Listing | 'deferred'): {
  service: { listRecords: () => Promise<Listing> }
  /** Settles when the next not-yet-awaited listing starts. */
  entered: () => Promise<undefined>
  /** Settle the oldest unsettled deferred listing. */
  release: (listing: Listing) => void
  /** How many listings have started. */
  calls: () => number
  /** Settle every pending and future listing empty, so a failing test never leaves teardown joined. */
  drain: () => void
} {
  const deferred: Array<PromiseWithResolvers<Listing>> = []
  const starts: Array<PromiseWithResolvers<undefined>> = []
  const startOf = (index: number): PromiseWithResolvers<undefined> => (starts[index] ??= Promise.withResolvers<undefined>())
  let calls = 0
  let awaited = 0
  let draining = false
  return {
    service: {
      listRecords: () => {
        const index = calls
        calls += 1
        startOf(index).resolve(undefined)
        if (index === 0 && initial !== 'deferred') return Promise.resolve(initial)
        if (draining) return Promise.resolve([])
        const pending = Promise.withResolvers<Listing>()
        deferred.push(pending)
        return pending.promise
      },
    },
    calls: () => calls,
    drain: () => {
      draining = true
      for (const pending of deferred.splice(0)) pending.resolve([])
    },
    entered: () => {
      const index = awaited
      awaited += 1
      return startOf(index).promise
    },
    release: (listing) => { deferred.shift()!.resolve(listing) },
  }
}

const routes = (ctx: Context): string[] => ctx.llm.listProviders().map(provider => provider.id)
const stored = (ctx: Context, provider: string): boolean | undefined =>
  ctx.llm.listConfigurableProviders().find(entry => entry.provider === provider)?.hasStoredCredential

async function runtime(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  return ctx
}

afterEach(() => { vi.restoreAllMocks() })

describe('initial stored sign-in listing', () => {
  it('holds the mount until the existing store has been listed', async () => {
    const ctx = await runtime()
    const store = gatedStore('deferred')
    ctx.provide('credentials', store.service as never)
    let mounted = false
    const mounting = ctx.plugin(PiAi).then((fiber) => { mounted = true; return fiber })

    await store.entered()
    await nextTurn()
    expect(mounted).toBe(false)
    expect(routes(ctx)).toEqual([])

    store.release([grant('openai-codex')])
    await mounting
    expect(mounted).toBe(true)
    expect(routes(ctx)).toEqual(['openai-codex'])
    expect(stored(ctx, 'openai-codex')).toBe(true)
  })

  it('mounts without waiting when no credential store exists, then follows one that appears', async () => {
    const ctx = await runtime()
    await ctx.plugin(PiAi)
    expect(routes(ctx)).toEqual([])

    ctx.provide('credentials', gatedStore([grant('openai-codex')]).service as never)
    await vi.waitFor(() => { expect(routes(ctx)).toEqual(['openai-codex']) })
  })

  it('keeps shutdown joined to a listing that has not settled, and publishes nothing from it', async () => {
    const ctx = await runtime()
    const llm = ctx.llm
    const store = gatedStore('deferred')
    ctx.provide('credentials', store.service as never)
    const mounting = ctx.plugin(PiAi)
    await store.entered()

    let disposed = false
    const disposing = ctx.fiber.dispose().then(() => { disposed = true })
    await nextTurn()
    expect(disposed).toBe(false)

    store.release([grant('openai-codex')])
    await disposing
    await mounting
    expect(disposed).toBe(true)
    expect(llm.listProviders()).toEqual([])
  })
})

describe('credential store lifecycle', () => {
  /** Mount llm-pi-ai over a store that a separately disposable plugin provides. */
  async function mountOver(
    listing: Listing | 'deferred',
    config: PiAi.Options = {},
  ): Promise<{
    ctx: Context
    store: ReturnType<typeof gatedStore>
    source: Awaited<ReturnType<Context['plugin']>>
    adapter: Awaited<ReturnType<Context['plugin']>>
  }> {
    const ctx = await runtime()
    const store = gatedStore(listing)
    const source = await ctx.plugin({
      name: 'owned-credential-store',
      apply: (child: Context) => { child.provide('credentials', store.service as never) },
    })
    const adapter = await ctx.plugin(PiAi, config)
    // The mount-time listing is spent; the next `entered()` is a later refresh.
    if (listing !== 'deferred') await store.entered()
    return { ctx, store, source, adapter }
  }

  it('withdraws implied routes and readiness when the store is removed, keeping configured profiles', async () => {
    const { ctx, source } = await mountOver([grant('openai-codex')], {
      providers: { deepseek: { apiKeyEnv: 'PI_BINDING_KEY' } },
    })
    expect(routes(ctx).sort()).toEqual(['deepseek', 'openai-codex'])
    expect(stored(ctx, 'openai-codex')).toBe(true)

    await source.dispose()

    expect(ctx.get('credentials')).toBeUndefined()
    expect(routes(ctx)).toEqual(['deepseek'])
    expect(stored(ctx, 'openai-codex')).toBeUndefined()
    expect(ctx.llm.listConfigurableProviders().some(entry => entry.provider === 'deepseek')).toBe(true)
  })

  it('withdraws routes at once and finishes removal only after the admitted listing settles, publishing nothing from it', async () => {
    const { ctx, store, source } = await mountOver([grant('openai-codex')])
    try {
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      await store.entered()

      let removed = false
      const removing = source.dispose().then(() => { removed = true })
      await nextTurn()
      // Withdrawal is observable while the listing the store still owes is outstanding.
      expect(routes(ctx)).toEqual([])
      expect(removed).toBe(false)

      store.release([grant('openai-codex'), grant('github-copilot')])
      await removing
      await nextTurn()

      expect(routes(ctx)).toEqual([])
      expect(stored(ctx, 'github-copilot')).toBeUndefined()
    } finally { store.drain() }
  })

  it('follows the replacement store, which the retired store\'s binding never reads', async () => {
    const { ctx, store: retired, source } = await mountOver([grant('openai-codex')])
    const replacement = gatedStore([grant('github-copilot')])
    try {
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      await retired.entered()
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      const removing = source.dispose()
      await nextTurn()
      expect(routes(ctx)).toEqual([])

      retired.release([grant('openai-codex')])
      await removing
      await ctx.plugin({
        name: 'replacement-credential-store',
        apply: (child: Context) => { child.provide('credentials', replacement.service as never) },
      })
      await vi.waitFor(() => { expect(routes(ctx)).toEqual(['github-copilot']) })

      // The queued update behind the admitted listing never reached the retired store,
      // and the replacement was listed once, by its own binding.
      expect(retired.calls()).toBe(2)
      expect(replacement.calls()).toBe(1)
      expect(stored(ctx, 'openai-codex')).toBeUndefined()
    } finally { retired.drain(); replacement.drain() }
  })

  it('keeps root disposal joined to a later listing that is already admitted', async () => {
    const { ctx, store } = await mountOver([grant('openai-codex')])
    const llm = ctx.llm
    try {
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      await store.entered()

      let disposed = false
      const disposing = ctx.fiber.dispose().then(() => { disposed = true })
      await nextTurn()
      expect(disposed).toBe(false)

      store.release([grant('github-copilot')])
      await disposing
      expect(disposed).toBe(true)
      expect(llm.listProviders()).toEqual([])
    } finally { store.drain() }
  })

  it('starts no queued listing once the adapter alone is disposed', async () => {
    const { ctx, store, adapter } = await mountOver([grant('openai-codex')])
    try {
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      await store.entered()
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))

      let disposed = false
      const disposing = adapter.dispose().then(() => { disposed = true })
      await nextTurn()
      expect(disposed).toBe(false)

      store.release([grant('github-copilot')])
      await disposing
      await nextTurn()

      expect(disposed).toBe(true)
      expect(store.calls()).toBe(2)
      expect(routes(ctx)).toEqual([])
    } finally { store.drain() }
  })

  it('joins an unsettled initial listing when only the store is removed', async () => {
    const ctx = await runtime()
    const store = gatedStore('deferred')
    const source = await ctx.plugin({
      name: 'owned-credential-store',
      apply: (child: Context) => { child.provide('credentials', store.service as never) },
    })
    try {
      const mounting = ctx.plugin(PiAi)
      await store.entered()

      let removed = false
      const removing = source.dispose().then(() => { removed = true })
      await nextTurn()
      expect(removed).toBe(false)

      store.release([grant('openai-codex')])
      await removing
      await mounting
      expect(routes(ctx)).toEqual([])
    } finally { store.drain() }
  })

  /**
   * Withdraw the mount-time store through the exact disposer `ctx.provide` returned, without
   * awaiting it, while the initial listing is held; mount a replacement before that listing
   * settles; optionally end the adapter or the root in the same overlap.
   */
  async function withdrawDuringInitialListing(end: 'none' | 'adapter' | 'root'): Promise<{
    retiredCalls: number
    replacementCalls: number
    replacementCallsBeforeRelease: number
    announced: string[][]
    routes: string[]
  }> {
    const ctx = await runtime()
    const llm = ctx.llm
    const retired = gatedStore('deferred')
    let replacementCalls = 0
    const replacement = {
      listRecords: (): Promise<Listing> => {
        replacementCalls += 1
        return Promise.resolve([grant('github-copilot')])
      },
    }
    let withdraw: (() => void) | undefined
    await ctx.plugin({
      name: 'retiring-credential-store',
      apply: (child: Context) => { withdraw = child.provide('credentials', retired.service as never) },
    })
    const announced: string[][] = []
    let mounting: ReturnType<Context['plugin']> | undefined
    let withdrawing: Promise<void> | undefined
    let ending: Promise<void> | undefined
    try {
      mounting = ctx.plugin(PiAi)
      await retired.entered()
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('openai-codex'))
      ctx.on('llm/adapters-updated', () => { announced.push(llm.listProviders().map(provider => provider.id)) })
      // `provide` is typed as a synchronous disposer, but Cordis returns its removal promise.
      withdrawing = Promise.resolve(withdraw?.())
      await ctx.plugin({
        name: 'replacement-credential-store',
        apply: (child: Context) => { child.provide('credentials', replacement as never) },
      })
      const replacementCallsBeforeRelease = replacementCalls
      if (end === 'adapter') ending = mounting.dispose()
      if (end === 'root') ending = ctx.fiber.dispose()
      retired.release([grant('openai-codex')])
      await withdrawing
      await mounting
      await ending
      return {
        retiredCalls: retired.calls(),
        replacementCalls,
        replacementCallsBeforeRelease,
        announced,
        routes: llm.listProviders().map(provider => provider.id),
      }
    } finally {
      retired.drain()
      await withdrawing
      await mounting
      await ending
    }
  }

  it('retires an initially loading binding at withdrawal, before Cordis can unload it', async () => {
    const result = await withdrawDuringInitialListing('none')

    // The replacement is listed once, by its own binding; the retired binding read only its own store
    // and published nothing after withdrawal was requested.
    expect(result.replacementCallsBeforeRelease).toBe(0)
    expect(result.retiredCalls).toBe(1)
    expect(result.replacementCalls).toBe(1)
    // Every announcement after withdrawal shows the replacement's routes: neither the retired
    // route nor an interim empty set was ever published.
    expect(result.announced.length).toBeGreaterThan(0)
    for (const announcement of result.announced) expect(announcement).toEqual(['github-copilot'])
    expect(result.routes).toEqual(['github-copilot'])
  })

  it('admits no listing of either store when the adapter is disposed in the same initial-load overlap', async () => {
    const result = await withdrawDuringInitialListing('adapter')

    expect(result.retiredCalls).toBe(1)
    expect(result.replacementCalls).toBe(0)
    expect(result.announced.flat()).not.toContain('openai-codex')
    expect(result.routes).toEqual([])
  })

  it('admits no listing of either store when the root is disposed in the same initial-load overlap', async () => {
    const result = await withdrawDuringInitialListing('root')

    expect(result.retiredCalls).toBe(1)
    expect(result.replacementCalls).toBe(0)
    expect(result.announced.flat()).not.toContain('openai-codex')
    expect(result.routes).toEqual([])
  })

  it('starts no queued listing once the adapter alone is disposed during the initial listing', async () => {
    const ctx = await runtime()
    const store = gatedStore('deferred')
    await ctx.plugin({
      name: 'owned-credential-store',
      apply: (child: Context) => { child.provide('credentials', store.service as never) },
    })
    let mounting: ReturnType<Context['plugin']> | undefined
    let disposing: Promise<void> | undefined
    try {
      mounting = ctx.plugin(PiAi)
      await store.entered()
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      let disposed = false
      disposing = mounting.dispose().then(() => { disposed = true })
      await nextTurn()
      expect(disposed).toBe(false)

      store.release([grant('openai-codex')])
      await nextTurn()
      // Checked before joining teardown: an admitted queued listing would hold it open.
      expect(store.calls()).toBe(1)
      await disposing
      await mounting

      expect(store.calls()).toBe(1)
      expect(routes(ctx)).toEqual([])
    } finally {
      store.drain()
      await disposing
      await mounting
    }
  })

  it('lists only its own store when the adapter restarts during the initial listing', async () => {
    const ctx = await runtime()
    const store = gatedStore('deferred')
    await ctx.plugin({
      name: 'owned-credential-store',
      apply: (child: Context) => { child.provide('credentials', store.service as never) },
    })
    let mounting: ReturnType<Context['plugin']> | undefined
    let restarting: Promise<void> | undefined
    try {
      mounting = ctx.plugin(PiAi)
      await store.entered()
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      restarting = mounting.restart()

      store.release([grant('openai-codex')])
      // The update queued behind the initial listing still belongs to the same store.
      await store.entered()
      store.release([grant('openai-codex')])
      // The restarted adapter lists the store again through its own binding.
      await store.entered()
      store.release([grant('github-copilot')])
      await restarting
      await mounting

      await vi.waitFor(() => { expect(routes(ctx)).toEqual(['github-copilot']) })
      expect(store.calls()).toBe(3)
    } finally {
      store.drain()
      await restarting
      await mounting
    }
  })

  it('retires the initial binding when its store\'s provider restarts, and follows the restarted store', async () => {
    const ctx = await runtime()
    const store = gatedStore('deferred')
    const source = await ctx.plugin({
      name: 'owned-credential-store',
      apply: (child: Context) => { child.provide('credentials', store.service as never) },
    })
    const announced: string[][] = []
    let mounting: ReturnType<Context['plugin']> | undefined
    let restarting: Promise<void> | undefined
    try {
      mounting = ctx.plugin(PiAi)
      await store.entered()
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      ctx.on('llm/adapters-updated', () => { announced.push(routes(ctx)) })
      restarting = source.restart()

      store.release([grant('openai-codex')])
      await store.entered()
      store.release([grant('github-copilot')])
      await restarting
      await mounting

      await vi.waitFor(() => { expect(routes(ctx)).toEqual(['github-copilot']) })
      // The retired binding neither ran its queued update nor published its initial listing.
      expect(store.calls()).toBe(2)
      expect(announced.flat()).not.toContain('openai-codex')
    } finally {
      store.drain()
      await restarting
      await mounting
    }
  })

  it('keeps a binding live through a service notification that still carries its store', async () => {
    const { ctx, store } = await mountOver([grant('openai-codex')])
    try {
      ctx.reflect.notify(['credentials'])
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      await store.entered()
      store.release([grant('openai-codex'), grant('github-copilot')])

      await vi.waitFor(() => { expect(routes(ctx).sort()).toEqual(['github-copilot', 'openai-codex']) })
      expect(store.calls()).toBe(2)
    } finally { store.drain() }
  })

  it('keeps following a credential service through a notification that still carries it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-binding-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const ctx = await runtime()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.plugin(PiAi)

    ctx.reflect.notify(['credentials'])
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai-codex'), () => Promise.resolve({
      kind: 'grant', payload: { type: 'oauth', access: 'synthetic', refresh: 'synthetic', expires: 4102444800000 },
    }))

    await vi.waitFor(() => { expect(routes(ctx)).toEqual(['openai-codex']) })
  })

  it('contains a failure while publishing a refresh and keeps later refreshes running', async () => {
    const ctx = await runtime()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const registerAdapter = ctx.llm.registerAdapter.bind(ctx.llm)
    let failReplace = false
    vi.spyOn(ctx.llm, 'registerAdapter').mockImplementation((...args) => {
      const handle = registerAdapter(...args)
      const replace = handle.replace.bind(handle)
      handle.replace = (...replaceArgs) => {
        if (failReplace) throw new Error('replace failed')
        replace(...replaceArgs)
      }
      return handle
    })
    const store = gatedStore([grant('github-copilot')])
    ctx.provide('credentials', store.service as never)
    try {
      await ctx.plugin(PiAi)
      await store.entered()
      failReplace = true
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      await store.entered()
      store.release([grant('github-copilot')])
      await nextTurn()

      failReplace = false
      ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
      await store.entered()
      store.release([grant('github-copilot'), grant('openai-codex')])
      await vi.waitFor(() => { expect(routes(ctx).sort()).toEqual(['github-copilot', 'openai-codex']) })
      expect(error).toHaveBeenCalled()
    } finally { store.drain() }
  })

  it('does not list the store again for another owner\'s record', async () => {
    const { ctx, store } = await mountOver([grant('openai-codex')])
    const list = vi.spyOn(store.service, 'listRecords')

    ctx.emit('credentials/record-updated', credentialKey('unrelated-owner', 'openai-codex'))
    await nextTurn()

    expect(list).not.toHaveBeenCalled()
  })

  it('stays quiet when the root is disposed while it holds sign-in routes', async () => {
    const { ctx } = await mountOver([grant('openai-codex')])
    const llm = ctx.llm
    const logged = vi.spyOn(ctx.logger, 'error')

    await ctx.fiber.dispose()

    expect(logged).not.toHaveBeenCalled()
    expect(llm.listProviders()).toEqual([])
  })
})

describe('stored credential readiness of a resolved profile', () => {
  async function over(config: PiAi.Options): Promise<Context> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-binding-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const ctx = await runtime()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai-codex'), () => Promise.resolve({
      kind: 'grant', payload: { type: 'oauth', access: 'synthetic', refresh: 'synthetic', expires: 4102444800000 },
    }))
    await ctx.plugin(PiAi, config)
    return ctx
  }

  it('reports the stored sign-in for a route that has no credential of its own', async () => {
    const ctx = await over({})
    expect(stored(ctx, 'openai-codex')).toBe(true)

    const named = await over({ providers: { 'openai-codex': {} } })
    expect(stored(named, 'openai-codex')).toBe(true)
  })

  it('does not report a stored sign-in that the route\'s explicit apiKeyEnv overrides', async () => {
    const ctx = await over({ providers: { 'openai-codex': { apiKeyEnv: credentialRef('PI_BINDING_UNSET_KEY') } } })

    expect(await ctx.llm.listModels('openai-codex')).toEqual([])
    expect(stored(ctx, 'openai-codex')).toBeUndefined()
  })
})

describe('model offers that depend on the stored credential', () => {
  /** A Copilot grant; omitting the ids leaves the whole catalog offered. */
  const copilot = (ids?: readonly string[]) => ({
    kind: 'grant' as const,
    payload: {
      type: 'oauth', access: 'a', refresh: 'r', expires: 4102444800000,
      ...ids === undefined ? {} : { availableModelIds: [...ids] },
    },
  })

  async function signedInCopilot(ids?: readonly string[]): Promise<{ ctx: Context }> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-offers-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const ctx = await runtime()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('github-copilot'), () => Promise.resolve(copilot(ids)))
    await ctx.plugin(PiAi)
    return { ctx }
  }

  it('announces a replaced grant with unchanged routes, so open pickers refresh', async () => {
    const all = (await (await signedInCopilot()).ctx.llm.listModels('github-copilot')).map(model => model.id)
    const [first, second] = all
    const { ctx } = await signedInCopilot([first!])
    expect((await ctx.llm.listModels('github-copilot')).map(model => model.id)).toEqual([first])
    const updated = new Promise<void>((resolve) => {
      ctx.on('llm/adapters-updated', () => { resolve() })
    })

    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('github-copilot'), () => Promise.resolve(copilot([second!])))
    await updated

    expect(routes(ctx)).toEqual(['github-copilot'])
    expect((await ctx.llm.listModels('github-copilot')).map(model => model.id)).toEqual([second])
  })

  it('stays quiet when a grant for a provider whose offers do not vary is replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-offers-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const ctx = await runtime()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    const codex = PiAi.recordKeyFor('openai-codex')
    const grantOf = (access: string) => ({
      kind: 'grant' as const, payload: { type: 'oauth', access, refresh: 'r', expires: 4102444800000 },
    })
    await ctx.credentials.modifyRecord(codex, () => Promise.resolve(grantOf('one')))
    await ctx.plugin(PiAi)
    const updates = vi.fn()
    ctx.on('llm/adapters-updated', updates)
    const settled = new Promise<void>((resolve) => {
      ctx.on('credentials/record-updated', () => { setImmediate(resolve) })
    })

    await ctx.credentials.modifyRecord(codex, () => Promise.resolve(grantOf('two')))
    await settled
    await nextTurn()

    expect(updates).not.toHaveBeenCalled()
  })
})
