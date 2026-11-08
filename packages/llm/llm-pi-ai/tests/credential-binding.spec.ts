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
} {
  const deferred: Array<PromiseWithResolvers<Listing>> = []
  const starts: Array<PromiseWithResolvers<undefined>> = []
  const startOf = (index: number): PromiseWithResolvers<undefined> => (starts[index] ??= Promise.withResolvers<undefined>())
  let calls = 0
  let awaited = 0
  return {
    service: {
      listRecords: () => {
        const index = calls
        calls += 1
        startOf(index).resolve(undefined)
        if (index === 0 && initial !== 'deferred') return Promise.resolve(initial)
        const pending = Promise.withResolvers<Listing>()
        deferred.push(pending)
        return pending.promise
      },
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
  ): Promise<{ ctx: Context; store: ReturnType<typeof gatedStore>; source: Awaited<ReturnType<Context['plugin']>> }> {
    const ctx = await runtime()
    const store = gatedStore(listing)
    const source = await ctx.plugin({
      name: 'owned-credential-store',
      apply: (child: Context) => { child.provide('credentials', store.service as never) },
    })
    await ctx.plugin(PiAi, config)
    // The mount-time listing is spent; the next `entered()` is a later refresh.
    if (listing !== 'deferred') await store.entered()
    return { ctx, store, source }
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

  it('does not republish a listing that settles after its store was removed', async () => {
    const { ctx, store, source } = await mountOver([grant('openai-codex')])
    ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
    await store.entered()

    await source.dispose()
    expect(routes(ctx)).toEqual([])
    store.release([grant('openai-codex'), grant('github-copilot')])
    await nextTurn()

    expect(routes(ctx)).toEqual([])
    expect(stored(ctx, 'github-copilot')).toBeUndefined()
  })

  it('follows the replacement store and ignores the retired store\'s late listing', async () => {
    const { ctx, store: retired, source } = await mountOver([grant('openai-codex')])
    ctx.emit('credentials/record-updated', PiAi.recordKeyFor('github-copilot'))
    await retired.entered()
    await source.dispose()

    const replacement = gatedStore([grant('github-copilot')])
    await ctx.plugin({
      name: 'replacement-credential-store',
      apply: (child: Context) => { child.provide('credentials', replacement.service as never) },
    })
    await vi.waitFor(() => { expect(routes(ctx)).toEqual(['github-copilot']) })

    retired.release([grant('openai-codex')])
    await nextTurn()

    expect(routes(ctx)).toEqual(['github-copilot'])
    expect(stored(ctx, 'openai-codex')).toBeUndefined()
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
