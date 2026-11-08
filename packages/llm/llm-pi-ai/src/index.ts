/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; a route naming an installed pi-ai provider inherits that
 * provider's endpoint, protocol, and model catalog as defaults, and a route
 * pi-ai does not ship is declared outright. Profile facts resolve per request
 * over the optional `llm-pi-ai` user-settings section and the optional
 * credential seam, so a changed key, endpoint, model, or knob reaches the next
 * request without a restart; a changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       # Catalog route: everything but the credential comes from pi-ai.
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       # Catalog route with the catalog narrowed and one capacity corrected.
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *         models:
 *           - id: claude-sonnet-4-5
 *             contextWindow: 200000
 *       # Hand-declared route: pi-ai ships nothing under this key.
 *       acme-gateway:
 *         displayName: Acme Gateway
 *         apiKeyEnv: ACME_GATEWAY_API_KEY
 *         api: openai-completions
 *         baseURL: https://gateway.acme.example/v1
 *         # Reasoning dialect for a URL pi-ai cannot recognize.
 *         compat:
 *           thinkingFormat: deepseek
 *         models:
 *           - id: acme-large
 *             name: Acme Large
 *             contextWindow: 65536
 *             maxTokens: 4096
 *           - id: acme-think
 *             name: Acme Think
 *             contextWindow: 262144
 *             maxTokens: 32768
 *             # key = selectable level, value = wire spelling; only off may
 *             # leave the value empty (supported, send nothing).
 *             reasoningEfforts:
 *               off:
 *               high: high
 *               max: ultra
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */
import type {} from '@deepseek-ai/dsh-settings'

import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'

import type { CredentialStore } from '@earendil-works/pi-ai'
import { symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  assertUsableApiKey,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  resolveImageAttachmentAccess,
} from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import { credentialKeyId, credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { AccountPool } from './account-pool.ts'
import { PiAiAdapter } from './adapter.ts'
import { chatgptAccessToken, authContextFrom, credentialStoreFrom, listProviderCredentials, RECORD_SCOPE, recordKeyFor } from './auth.ts'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import { assertServiceable, Config, DEFAULT_MODEL_LIST_TIMEOUT_MS, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { discoverModelsWithin } from './discovery.ts'
import type { StoredModelDiscoveryProfile } from './discovery.ts'
import { createModels } from './models.ts'
import { registerPiAiFlows } from './login.ts'
import { providerDefaultsOf } from './provider-data.ts'
import type { PiAiRequestHeaderContext } from './types.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export type { PiAiRequestHeaderContext } from './types.ts'
export { Config } from './config.ts'
export type {
  Options,
  PiAiCompatProfile,
  PiAiModality,
  PiAiModelOverride,
  PiAiModelProfile,
  PiAiProviderProfile,
  PiAiReasoningEfforts,
  PiAiThinkingFormat,
  ResolvedPiAiProviderProfile,
} from './config.ts'
export { recordKeyFor } from './auth.ts'
export { supportedProtocols } from './provider.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Prepare headers for one pi-ai inference call, excluding model discovery.
     * Listeners run synchronously and must call next(); they may edit only the
     * request-owned headers and must not retain them. Throws fail the call with
     * REQUEST_HEADERS before inference I/O. Harness attribution wins afterward.
     * Non-TypeError messages are user-visible and must exclude secrets. TypeError
     * details and non-Error values are replaced with safe guidance.
     * @mode waterfall
     * @param request - immutable routing metadata from the exact prepared call.
     * @param headers - fresh profile headers, shared only within this dispatch.
     * @param next - continue header preparation through the remaining listeners.
     * @returns headers passed to pi-ai after Harness attribution is applied.
     */
    'llm-pi-ai/request-headers'(request: PiAiRequestHeaderContext, headers: Headers, next: () => Headers): Headers
  }
}

const NS = 'llm-pi-ai'

/** Failure codes after which another eligible account of the pool may serve the same step. */
const FAILOVER_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT', 'AUTH', QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE])

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    // `displayName` rides along because the registry hands it to every selector
    // through `providerInfo()`: a rename that did not re-register would leave
    // the old label showing until some unrelated fact happened to change.
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The configurable-provider directory: every installed catalog route, plus
 * every route the current profiles declare. A hand-declared route has no
 * catalog entry, so without this union it would have no settings address and
 * configuration surfaces could neither show nor edit it. A catalog route also
 * carries its catalog endpoint and native authentication, which a settings
 * editor shows while the profile leaves the endpoint or the credential
 * reference unset.
 * @param profiles - the currently resolved provider profiles.
 * @param settingsNs - Settings namespace owning the provider profiles.
 * @param signedIn - Catalog routes with stored credentials this adapter recognizes. A route
 *   is reported as holding one only while its resolved profile names no credential of its own.
 * @returns the directory entries in catalog order, declared routes last.
 */
function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  settingsNs: string,
  signedIn: ReadonlySet<string>,
): LlmConfigurableProvider[] {
  const entries = new Map<string, LlmConfigurableProvider>()
  // A profile that names its own credential reference overrides the stored
  // sign-in, so that sign-in is not what the route authenticates with.
  // A pooled route authenticates from its own accounts' documents, never the shared one.
  const usesStoredCredential = (provider: string): boolean =>
    signedIn.has(provider) && profiles.get(provider)?.apiKeyEnv === undefined
    && profiles.get(provider)?.accountPool === undefined
  const declare = (provider: string, displayName: string, error?: string): void => {
    const installed = catalogProvider(provider)
    entries.set(provider, {
      provider,
      displayName,
      settingsNs,
      ...usesStoredCredential(provider) ? { hasStoredCredential: true } : {},
      settingsPath: ['providers', provider],
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: installed === undefined,
      ...installed === undefined ? {} : providerDefaultsOf(installed),
      ...error === undefined ? {} : { error },
    })
  }
  for (const provider of catalogProviderIds()) declare(provider, provider)
  for (const [provider, profile] of profiles) declare(provider, profile.displayName, profile.catalogError)
  return [...entries.values()]
}

/**
 * The implementation a service value stands for. Cordis hands a listener or a declared
 * injection a context-bound view of a traceable service, and that view names its target.
 * @param value - a service implementation or a view of one.
 * @returns the viewed implementation, or `value` itself when it is not a view.
 */
function serviceIdentity(value: unknown): unknown {
  const original: unknown = (typeof value === 'object' || typeof value === 'function') && value !== null
    ? Reflect.get(value, symbols.original)
    : undefined
  return original ?? value
}

/**
 * Register pi-ai routes from profiles and supported stored sign-ins.
 * @param ctx - Plugin context with the LLM registry and optional credential store.
 * @param config - Provider profiles and their request defaults.
 * @returns after the credential store present at mount has been listed for initial route
 *   registration; at once when no store exists yet. Its sign-in routes follow that store:
 *   they leave when it is withdrawn and are re-read from a replacement. Every listing, initial
 *   or event-triggered, belongs to the binding to the store and reads only the store that binding
 *   committed to. Withdrawal or replacement of the store, even during the initial listing, and the
 *   start of adapter or root disposal close admission at once (a queued listing never reads any
 *   store, and a running one publishes nothing); teardown then withdraws the routes and joins the
 *   listing already running while the store is still mounted. A store whose listing never settles
 *   therefore holds that teardown. Listing and publication failures are logged, never rejected.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  let lastRaw: ReturnType<Config['providers']['get']> | undefined
  let lastSignedIn: ReadonlySet<string> | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  // Catalog providers this installation holds a stored credential for. Each
  // one is a route without any settings profile, so signing in is enough.
  let signedIn: ReadonlySet<string> = new Set()
  /**
   * The resolved profiles for the current configuration, memoized by the raw
   * snapshot's and the signed-in set's identity — which is also what makes the
   * adapter's own snapshot stable across operations that observe no change.
   * A signed-in provider with no profile of its own resolves as an empty
   * catalog profile; a profile the settings document does declare always wins.
   *
   * Catalog diagnostics stay in the snapshot beside serviceable models, so
   * stored configuration remains visible after an installed catalog changes.
   * Scalar configuration errors still reject resolution.
   */
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = config.providers.get()
    if (raw === lastRaw && signedIn === lastSignedIn && memoized !== undefined) return memoized
    const configured = structuredClone(raw) as import('./config.ts').Options['providers']
    const implied = Object.fromEntries([...signedIn].filter(provider => configured?.[provider] === undefined)
      .map(provider => [provider, {}]))
    const next = resolveProfiles({ ...implied, ...configured }, 'deferred')
    for (const [provider, profile] of next) {
      if ((provider === 'openai' || provider === 'anthropic') && provider in implied) profile.requiresStoredCredential = true
    }
    lastRaw = raw
    lastSignedIn = signedIn
    memoized = next
    return next
  }
  profiles()
  ctx.on('internal/config', (fiber, next) => {
    const raw: unknown = next()
    if (fiber !== ctx.fiber) return raw
    const candidate = Config(raw as import('./config.ts').Options)
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as import('./config.ts').Options,
      { providers: structuredClone(config.providers.get()) } as import('./config.ts').Options,
    )
    return raw
  })

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  // One store and one ambient context for the whole plugin instance: both read
  // through `ctx` per call, so they stay correct across the collection rebuilds
  // a configuration change causes, and a sign-in survives one.
  const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
  // Owner of every network model listing: unloading this instance cancels the
  // ones in flight and closes their connections.
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('llm-pi-ai: adapter unloaded')) })
  const reportedWithheld = new Map<string, string>()
  // The selection state of the route that configures `accounts`; undefined
  // until its account documents are mounted, and while a changed account list
  // is being applied, which the adapter treats as unavailable rather than
  // falling back to the shared sign-in.
  let pool: AccountPool | undefined
  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    auth,
    accountPool: () => pool,
    lifetime: lifetime.signal,
    onUnofferedAccountModels: ({ provider, models }) => {
      const key = models.join('\n')
      if (reportedWithheld.get(provider) === key) return
      reportedWithheld.set(provider, key)
      ctx.logger.warn(
        `llm-pi-ai: route "${provider}" is not offering account-listed model(s) ${models.join(', ')}:`
        + ' the configuration has no metadata for them; add a models entry with their capacities to offer them',
      )
    },
    prepareHeaders: (request, headers) => ctx.waterfall('llm-pi-ai/request-headers', request, headers, () => headers),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(
        `llm-pi-ai: unusable replay state on assistant history for route "${provider}/${model}";`
        + ` sending that message as provider-neutral content (${reason})`,
      )
    },
  })
  // Independent of the route set: signing in is what makes a route worth
  // adding, so the flows are offered before any profile names their provider.
  // Scoped to the authorization seam rather than injected outright, because a
  // composition without it (headless, ACP) simply has no surface to sign in
  // from, while everything else this plugin does still works.
  ctx.inject(['authorization'], (authorized) => { registerPiAiFlows(authorized, auth) })
  // The full installed catalog is configurable from the moment the plugin
  // mounts — dormant or not — so configuration surfaces can offer every
  // pi-ai provider before any route exists. Hand-declared routes join it as
  // profiles appear, and leave with them.
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(profiles(), settingsNs, signedIn)
    if (deepEqualJson(entries, directoryFacts)) return
    // Atomic replace, never dispose-then-register: a route another adapter
    // family already declares (a profile keyed `deepseek-official`) would
    // otherwise leave this plugin's whole directory withdrawn and the Models
    // page empty. The candidate set is validated first, so a collision keeps
    // the previous entries serving and only costs a diagnostic.
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()
  /** Host-owned request inputs for discovery of one configured route. */
  const storedDiscoveryProfile = (
    provider: string | undefined,
  ): StoredModelDiscoveryProfile | undefined => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return {
      headers: profile.headers,
      resolveApiKey: () => resolveApiKey(provider, profile),
      ...provider !== 'openai' || profile.apiKeyEnv !== undefined ? {} : {
        chatgpt: async (signal: AbortSignal) => {
          const stored = await auth.credentials.read(provider, { signal })
          if (stored?.type !== 'oauth') return undefined
          const models = createModels(auth)
          if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
          return { baseURL: profile.baseURL ?? 'https://api.openai.com/v1', accessToken: await chatgptAccessToken(models, signal) }
        },
      },
    }
  }
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace rather than per route: the provider
  // a surface is adding does not exist yet. The draft is the whole request
  // except the stored credential and deployment-owned headers: the curated UI
  // accepts neither, so an already-configured route supplies both inside the
  // Host rather than widening the discovery request.
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverModelsWithin(
    {
      // A draft not yet saved has no profile to carry a deadline, so it runs under the default.
      timeoutMs: (request.provider === undefined ? undefined : profiles().get(request.provider)?.modelListTimeoutMs)
        ?? DEFAULT_MODEL_LIST_TIMEOUT_MS,
      lifetime: lifetime.signal,
    },
    { ...request, ...signal === undefined ? {} : { signal } },
    () => storedDiscoveryProfile(request.provider),
  ))
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (zero routes) is the dormant posture: nothing registers until a
  // settings section supplies profiles, and routes drop when it empties.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    // The registry captures the route set and each route's retry policy at
    // registration, so a change to either must re-register. The swap is
    // atomic (same adapter instance, validated before anything moves): a
    // conflicting route leaves the previous routes serving requests, and
    // `registeredFacts` only advances once the registry actually holds the
    // new set — so returning to a working configuration always re-applies.
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  const reconcile = (): void => {
    try { ensureRegistrationFacts(); ensureDirectory() }
    catch (error) {
      ctx.logger.error('llm-pi-ai: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  }
  ctx.on('loader/volatile-update', reconcile)

  // A stored credential for an installed catalog provider is a route of its
  // own: signing in is the whole setup, with no settings profile to write. The
  // set follows the credential store, so a sign-in adds the route and a
  // sign-out removes it. Anthropic's subscription grant is not one: only its
  // API key activates an Anthropic route.
  //
  // Everything read from a store belongs to the binding to that store: when the
  // store is withdrawn or replaced its sign-ins leave with it, and a listing
  // still in flight from it can no longer publish.
  // Reload unloads this apply instance without disposing its fiber.
  let unloaded = false
  ctx.effect(() => () => { unloaded = true })
  const mounted = (): boolean => !unloaded && ctx.fiber.uid !== null
  /**
   * Whether a credential change can alter account-specific model offers,
   * including ChatGPT discovery and catalog-provider filters such as Copilot's.
   */
  const offersVaryByCredential = (provider: string): boolean =>
    (provider === 'openai' || catalogProvider(provider)?.filterModels !== undefined) && registration !== undefined
  /**
   * The registration of the ChatGPT sign-in the offers were last announced for: the
   * `clientId` OpenAI issues to each login. A refresh keeps it, so a rotated token
   * is recognized as the same sign-in; a new login (possibly another account) changes
   * it. Undefined when nothing identifies the login, which is treated as changed.
   */
  let announcedLogin: string | undefined
  const loginOf = async (store: CredentialProvider): Promise<string | undefined> => {
    const record = await store.readRecord(recordKeyFor('openai'))
    if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) return undefined
    const { type, clientId } = record.payload as { type?: unknown; clientId?: unknown }
    return type === 'oauth' && typeof clientId === 'string' && clientId.length > 0 ? clientId : undefined
  }
  /**
   * One refresh of the signed-in set from the store one binding committed to. Never
   * rejects: a failure is logged and leaves the routes as they were, so a refresh
   * started from an event has no caller to report to and cannot go unhandled.
   * @param store - the credential store the binding captured when it loaded.
   * @param admitted - whether the binding may still publish; asked again after the listing settles.
   * @param touched - the provider whose record changed, for an event-triggered refresh.
   */
  const refreshSignedIn = async (
    store: CredentialProvider,
    admitted: () => boolean,
    touched: string | undefined,
  ): Promise<void> => {
    try {
      let stored: Awaited<ReturnType<typeof listProviderCredentials>>
      try { stored = await listProviderCredentials(store) }
      catch (error) {
        ctx.logger.warn('llm-pi-ai: could not list stored credentials; signed-in routes are unchanged')
        ctx.logger.warn(error)
        return
      }
      // The listing was admitted before its binding was retired; its result is dropped.
      if (!admitted()) return
      const next = new Set(stored
        .filter(entry => catalogProvider(entry.providerId) !== undefined
          && (entry.providerId !== 'anthropic' || entry.type === 'oauth'))
        .map(entry => entry.providerId))
      const login = next.has('openai') ? await loginOf(store) : undefined
      if (!admitted()) return
      const previousLogin = announcedLogin
      announcedLogin = login
      if (next.size === signedIn.size && [...next].every(provider => signedIn.has(provider))) {
        // The routes are the same, but a replaced credential can still change
        // which models the route offers. The registry announces a route swap
        // like any topology change, which is what open model pickers listen to.
        // An ordinary token refresh of the same ChatGPT login changes no offer
        // and would only make every open picker repeat its listing request.
        const sameLogin = touched === 'openai' && login !== undefined && login === previousLogin
        if (touched !== undefined && offersVaryByCredential(touched) && !sameLogin) registration?.replace([...profiles().keys()])
        return
      }
      signedIn = next
      reconcile()
    } catch (error) {
      ctx.logger.error('llm-pi-ai: could not apply the stored credential listing; signed-in routes are unchanged')
      ctx.logger.error(error)
    }
  }
  const bindingFiber = ctx.inject(['credentials'], (binding) => {
    // The store this binding committed to. Every listing of the binding reads it, never the
    // store the context currently resolves, which after a replacement is another binding's.
    const store = binding.credentials
    // Its identity: the committed implementation itself, since the injected store and the value a
    // service notification carries can each be a context-bound view of it.
    const committed = serviceIdentity(binding.fiber.committed?.credentials?.value)
    // Validity, kept apart from the store and its identity: Cordis holds a binding's unload until
    // its load callback settles, so while the initial listing runs, withdrawal, replacement, and the
    // provider's own disposal reach the binding only as service notifications. Each one retires the
    // binding at once unless the active store still is the committed implementation, which is the
    // test Cordis itself applies before unloading the binding later; a notification that changed
    // nothing for this store leaves the binding live.
    let live = true
    binding.on('internal/service', (name) => {
      if (name === 'credentials' && serviceIdentity(binding.get('credentials')) !== committed) live = false
    })
    // Admission: a refresh reads the store only while the binding is live and the adapter is
    // not being disposed. Both close before teardown can unload anything, so a queued refresh
    // never starts against a retired store.
    const admitted = (): boolean => live && mounted()
    // Refreshes run one after another so a slow listing cannot overwrite a newer one.
    // The chain never rejects (`refreshSignedIn` contains its failures), so joining it is safe.
    let refreshing: Promise<void> = Promise.resolve()
    binding.effect(() => async () => {
      live = false
      // Withdraw the sign-in routes now; the store is still mounted, because Cordis
      // unloads this binding before the service provider it depends on.
      if (mounted() && signedIn.size > 0) {
        signedIn = new Set()
        reconcile()
      }
      // Quiescence: the admitted listing, if any, settles before the store or this
      // plugin may finish unloading. Queued refreshes are no longer admitted and skip the store.
      await refreshing
    })
    const refresh = (touched?: string): Promise<void> => {
      refreshing = refreshing.then(() => admitted() ? refreshSignedIn(store, admitted, touched) : undefined)
      return refreshing
    }
    binding.on('credentials/record-updated', (key) => {
      if (credentialKeyScope(key) === RECORD_SCOPE) void refresh(credentialKeyId(key))
    })
    // Returned so the binding finishes loading, and the mount below settles, once the
    // routes of a sign-in made in an earlier run exist.
    return refresh()
  })

  /** Mounted account documents of the current pool, torn down when the account list changes. */
  let retirePool: (() => Promise<void>) | undefined
  /**
   * Make the pool match the profiles: mount one credentials provider per
   * account over that account's own document, then publish the selection state.
   * The previous pool is withdrawn first, so a request during the swap fails
   * closed. A mount failure (an unreadable or group-readable document) is
   * logged and leaves the route unavailable; it never falls back.
   */
  const applyPool = async (): Promise<void> => {
    if (!mounted()) return
    const spec = profiles().get('anthropic')?.accountPool
    if (spec?.facts === pool?.facts) return
    const previous = retirePool
    pool = undefined
    retirePool = undefined
    await previous?.()
    if (spec === undefined) return
    const fibers: { dispose: () => Promise<unknown> }[] = []
    const retire = async (): Promise<void> => { await Promise.allSettled(fibers.map(fiber => fiber.dispose())) }
    const stores = new Map<string, CredentialStore>()
    try {
      for (const account of spec.accounts) {
        const scope = ctx.isolate('credentials')
        const fiber = scope.plugin(LocalCredentialProvider, { path: account.credentialsPath, watch: true })
        fibers.push(fiber)
        await fiber
        stores.set(account.id, credentialStoreFrom(scope))
      }
    } catch (error) {
      await retire()
      ctx.logger.error('llm-pi-ai: could not mount the Claude account credential documents; the pooled route stays unavailable')
      ctx.logger.error(error)
      return
    }
    retirePool = retire
    pool = new AccountPool(spec, stores)
  }
  // Applications run one after another, so a slow mount cannot publish over a newer list.
  let applying: Promise<void> = Promise.resolve()
  const reconcilePool = (): Promise<void> => {
    applying = applying.then(applyPool)
    return applying
  }
  ctx.on('loader/volatile-update', () => { void reconcilePool() })
  ctx.effect(() => async () => {
    unloaded = true
    // An application that was mounting finishes first, so a pool it publishes during unload is retired below.
    await applying
    pool = undefined
    await retirePool?.()
  })

  // A limited or rejected account has already been taken out of selection when
  // the failed attempt's stream finished, so a request that still has an
  // eligible account retries at once on that one. Only the pool decides this
  // retry: it replays no tool or history (the loop re-prepares the same step),
  // and it is capped per step so two failing accounts cannot bounce forever.
  // Everything else, including an exhausted pool, flows on to the retry policy.
  const failovers = new WeakMap<object, { turn: number; step: number; count: number }>()
  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
    const active = pool
    if (active === undefined || signal.aborted || !FAILOVER_CODES.has(failure.code)
      || profiles().get(provider)?.accountPool?.facts !== active.facts || !active.hasEligible()) return next()
    const previous = failovers.get(agent)
    const count = previous?.turn === turn && previous.step === step ? previous.count : 0
    if (count >= active.accounts.length) return next()
    failovers.set(agent, { turn, step, count: count + 1 })
    return { kind: 'retry' }
  }, true)

  await reconcilePool()
  // The routes of a sign-in made in an earlier run exist before the first request:
  // a bare mount with no credential store has no binding to wait for and settles at once.
  await bindingFiber
}
