/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { ModelsError } from '@earendil-works/pi-ai/utils/models-error'
import type {
  Api,
  AuthContext,
  AuthResult,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { observeAccountStream, observeGrant } from './account-pool.ts'
import type { AccountLease, AccountPool } from './account-pool.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { requestImageTarget, toPiContext } from './context.ts'
import { conversationUpdates, createModels, getSupportedThinkingLevels } from './models.ts'
import { assessPiAiControls, finalizeOpenAiControls } from './controls.ts'
import { carriesSubscriptionToken, chatgptAccessToken, chatgptAuth, SUBSCRIPTION_TOKEN_REFUSAL } from './auth.ts'
import { discoverModels, withinBounds } from './discovery.ts'
import { classifyPiAiError, toStreamChunks } from './stream.ts'
import { isWireObservable, observeWire } from './wire.ts'
import type { PiAiRequestHeaderContext } from './types.ts'

/**
 * Initially active declaration added to an Anthropic request whose projected
 * tools are all deferred, because Anthropic rejects a tool list without one.
 */
const ANTHROPIC_TOOL_UPDATE_PLACEHOLDER: ToolSchema = {
  name: 'DeferredToolPlaceholder',
  description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.',
  parameters: { type: 'object', properties: {} },
}

/** Mandatory identity text added by the pinned pi-ai Anthropic OAuth transport. */
const ANTHROPIC_OAUTH_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
  /** The account pool this snapshot was built with, when a route configures accounts. */
  pool: AccountPool | undefined
  /**
   * One collection builder per pooled account: given a credential store over
   * that account's own document, it returns a collection whose authentication
   * reads and refreshes only that store. A pooled request authenticates only
   * through one of these, never through `models`, whose store is the shared
   * sign-in document, and builds its own so the store it passes can report
   * which grant that request used.
   */
  accounts: ReadonlyMap<string, (credentials: CredentialStore) => Models>
}

/** One authentication resolution of a request: the explicit key and the checked result. */
interface AuthBinding {
  readonly apiKey: string | undefined
  readonly checked?: CheckedAuth
}

/** The collection and credential store one authentication resolution reads. */
interface AuthScope {
  readonly models: Models
  readonly credentials: CredentialStore
}

/**
 * What a pooled request claimed: an account with its authentication, an
 * account whose authentication failed in a way the stream reports, or the
 * failure that every signed-in account is cooling.
 */
type PoolClaim =
  | { readonly kind: 'cooling'; readonly failure: LlmFailure }
  | {
    readonly kind: 'bound'
    readonly pool: AccountPool
    readonly lease: AccountLease
    readonly fingerprint: string
    readonly binding: AuthBinding
  }
  | {
    readonly kind: 'failed'
    readonly pool: AccountPool
    readonly lease: AccountLease
    readonly fingerprint: string
    readonly error: unknown
  }

/** A stream whose only chunk is the terminal failure of a request that never reached a provider. */
// oxlint-disable-next-line typescript/require-await -- an async generator keeps a failure a stream element, never a synchronous throw
async function* failedStream(failure: LlmFailure): AsyncGenerator<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'error', failure } }
}

/** A stream that reports a failure the request already met before streaming. */
// oxlint-disable-next-line typescript/require-await -- an async generator defers the throw to the first pull, like a provider stream
async function* throwingStream(error: unknown): AsyncGenerator<StreamChunk> {
  throw error
}

/**
 * The one authentication resolution a request's subscription check examined:
 * the complete result, or the failure that resolution reported.
 */
type CheckedAuth =
  | { readonly ok: true; readonly result: AuthResult | undefined }
  | { readonly ok: false; readonly error: ModelsError }

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call, and by `listModels`, which offers no
   * models while it throws `MISSING_CREDENTIAL`. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /**
   * Synchronously prepare this call's headers before SDK dispatch. The input
   * contains a fresh copy of profile headers; attribution is enforced afterward.
   * Omission preserves profile headers. Throws fail the call with REQUEST_HEADERS
   * before inference I/O. Do not retain or mutate headers after returning.
   * Non-TypeError messages become public diagnostics and must exclude secrets;
   * TypeError details and non-Error values are replaced with safe guidance.
   * @param request - immutable routing metadata from the prepared call.
   * @param headers - request-owned headers initialized from the profile.
   * @returns headers to pass to pi-ai after applying Harness attribution.
   */
  prepareHeaders?: (request: PiAiRequestHeaderContext, headers: Headers) => Headers
  /**
   * The current account pool of a route that configures `accounts`; called
   * once per operation. A pooled route whose profile and pool facts disagree
   * (a reconfiguration still being applied) fails closed with
   * `ACCOUNT_POOL_UNAVAILABLE` instead of authenticating through the shared
   * sign-in document.
   */
  accountPool?: () => AccountPool | undefined
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Lifetime of the owner (the plugin instance). Its abort cancels every network
   * model listing and control finalization in flight and closes the connections; omission leaves only each
   * caller's own cancellation and the route's `modelListTimeoutMs`.
   */
  lifetime?: AbortSignal
  /**
   * Observe account-listed models withheld from the offers because the captured
   * configuration cannot resolve them; the owner decides how to report them.
   */
  onUnofferedAccountModels?: (detail: { provider: string; models: readonly string[] }) => void
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  model: Model<Api>,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    // pi-ai's Codex default (`auto`) opens a WebSocket and, when it fails before
    // any output, re-sends the same request over SSE, and it retries a lost
    // continuation or a connection limit once more: one visible attempt would be
    // several unlogged requests. SSE is one request per attempt; the WebSocket
    // stays available through an explicit `transport`.
    ...profile.transport === undefined
      ? model.api === 'openai-codex-responses' ? { transport: 'sse' as const } : {}
      : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Native header TypeErrors can echo credentials; other plugin errors own their public message. */
function requestHeaderDiagnostic(error: unknown): string {
  if (error instanceof TypeError) {
    return 'TypeError during header preparation; check the contributing plugin\'s header names, values, and configuration'
  }
  return error instanceof Error
    ? error.message
    : 'the contributing plugin threw a non-Error value; throw an Error with a safe diagnostic'
}

/** Prepare request-owned headers without allowing contributors to replace attribution. */
function requestHeaders(
  configured: Readonly<Record<string, string>> | undefined,
  options: GenerateOptions<string>,
  baseURL: string,
  prepare: PiAiAdapterOptions['prepareHeaders'],
): Record<string, string> {
  try {
    const initial = new Headers()
    // Profile aliases overwrite case-insensitively; the Headers constructor appends them.
    for (const [name, value] of Object.entries(configured ?? {})) initial.set(name, value)
    const request: PiAiRequestHeaderContext = Object.freeze({
      provider: options.provider,
      model: options.model,
      baseURL,
      ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
      ...options.purpose === undefined ? {} : { purpose: options.purpose },
    })
    const headers = prepare === undefined ? initial : prepare(request, initial)
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    return Object.fromEntries(headers)
  } catch (error) {
    throw new LlmError(
      `pi-ai request header preparation failed for provider "${options.provider}": ${requestHeaderDiagnostic(error)}`,
      'REQUEST_HEADERS', { cause: error },
    )
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  override imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef) {
    const snapshot = this.current()
    this.modelOf(snapshot, provider, model)
    const profile = this.profileOf(snapshot, provider)
    return requestImageTarget(image, { maxPixels: profile.requestImagePixelBudget, maxBytes: profile.requestImageMaxBytes })
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    const pool = this.config.accountPool?.()
    if (this.snapshot?.profiles === profiles && this.snapshot.pool === pool) return this.snapshot
    const build = (auth: PiAiAuthInjection): MutableModels => {
      const models = createModels(auth)
      for (const profile of profiles.values()) {
        if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
      }
      return models
    }
    const accounts = new Map<string, (credentials: CredentialStore) => Models>()
    if (pool !== undefined) {
      for (const account of pool.accounts) {
        accounts.set(account, credentials => build({ credentials, authContext: this.config.auth.authContext }))
      }
    }
    this.snapshot = { profiles, models: build(this.config.auth), pool, accounts }
    return this.snapshot
  }

  /**
   * The pool a pooled route's snapshot holds, or the failure that the route
   * cannot authenticate: the pool is missing, or was built for another
   * configuration than the profile's.
   */
  private poolOf(snapshot: PiAiSnapshot, profile: ResolvedPiAiProviderProfile): AccountPool {
    const { pool } = snapshot
    if (pool === undefined || pool.facts !== profile.accountPool?.facts) {
      throw new LlmError(
        'The Claude account pool is not ready for this configuration; retry shortly. The shared sign-in and API-key billing were not used.',
        'ACCOUNT_POOL_UNAVAILABLE',
      )
    }
    return pool
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  /**
   * Resolve plan or API-key authentication before dispatch, refusing
   * unsupported subscription credentials.
   *
   * The returned key is the explicit one (or the ChatGPT plan bearer). A
   * Messages request, and every request on the direct Anthropic route, resolves
   * the complete effective authentication (key, base URL, headers, environment)
   * exactly once, refuses a Claude subscription token found in any of it, and
   * returns that resolution in `checked` so the dispatch applies it instead of
   * resolving again. Responses requests on the OpenAI route also retain their complete effective
   * resolution. Other requests leave resolution to pi-ai's dispatch.
   * @param snapshot - the captured configuration.
   * @param provider - the route.
   * @param profile - the route's resolved profile.
   * @param model - the exact model about to be requested; omitted by a catalog listing.
   * @param signal - caller cancellation for a request; the bounds of a lookup, which
   *   the credential store also receives.
   * @param headers - the request headers this call will send.
   * @param preparing - stop after each cancelled await before publishing preparation.
   * @param scope - the collection and store of the pooled account this call
   *   authenticates as. A route that configures an account pool refuses a call
   *   without one, so no path reaches the shared sign-in document by omission.
   * @returns the explicit credential to pass as the request's `apiKey`, if any,
   *   and the checked resolution when one was made.
   */
  private async requestAuth(
    snapshot: PiAiSnapshot,
    provider: string,
    profile: ResolvedPiAiProviderProfile,
    model?: Model<Api>,
    signal?: AbortSignal,
    headers: Readonly<Record<string, string>> = {},
    preparing = false,
    scope?: AuthScope,
  ): Promise<AuthBinding> {
    if (profile.accountPool !== undefined && scope === undefined) {
      throw new LlmError(
        `The "${provider}" route pools several accounts; authentication needs a selected account. The shared sign-in was not used.`,
        'ACCOUNT_POOL_UNAVAILABLE',
      )
    }
    const { models, credentials } = scope ?? { models: snapshot.models, credentials: this.config.auth.credentials }
    // A lookup stops at the first wait that outlives its bounds; a request
    // leaves its caller's abort to the dispatch, which reports an aborted finish.
    const lookup = model === undefined || preparing ? signal : undefined
    const explicit = await this.config.resolveApiKey(provider, profile)
    lookup?.throwIfAborted()
    const messages = model?.api === 'anthropic-messages'
    const stored = explicit === undefined && (provider === 'openai' || provider === 'anthropic' || profile.requiresStoredCredential === true)
      ? await credentials.read(provider, lookup === undefined ? undefined : { signal: lookup })
      : undefined
    lookup?.throwIfAborted()
    if (explicit === undefined && profile.requiresStoredCredential === true && stored === undefined) {
      throw new LlmError(provider === 'openai'
        ? 'ChatGPT sign-in was removed; sign in again or explicitly configure an API-key route. API-key billing was not selected.'
        : `The "${provider}" sign-in was removed; sign in again or explicitly configure an API-key route. API-key billing was not selected.`, 'AUTH')
    }
    if (provider === 'openai' && model !== undefined && stored?.type === 'oauth') {
      if (model.api !== 'openai-responses') throw new LlmError('ChatGPT plan sign-in requires the openai-responses protocol; configure an API key for other protocols.', 'AUTH')
      return { apiKey: undefined, checked: { ok: true, result: structuredClone(await chatgptAuth(models, signal, model)) } }
    }
    if (provider !== 'anthropic' && !messages && !(provider === 'openai' && model?.api === 'openai-responses')) return { apiKey: explicit }
    if (provider === 'anthropic' && stored?.type === 'oauth') {
      if (model !== undefined && model.api !== 'anthropic-messages') {
        throw new LlmError('Anthropic subscription sign-in requires the anthropic-messages protocol.', 'AUTH')
      }
      if (Object.keys(headers).some(name => /^(authorization|x-api-key)$/i.test(name))) {
        throw new LlmError('Anthropic subscription authentication cannot be overridden by request auth headers.', 'AUTH')
      }
    } else if (provider === 'anthropic' && explicit === undefined && profile.requiresStoredCredential === true) {
      throw new LlmError('Anthropic subscription sign-in is unavailable; sign in again. API-key billing was not selected.', 'AUTH')
    }
    let resolved: Awaited<ReturnType<Models['getAuth']>>
    // The same resolution Models.applyAuth performs at dispatch, minus the
    // network: it yields the key, base URL, headers and environment pi-ai will
    // actually use. A resolution failure is not this guard's to report: the
    // dispatch reports exactly this failure, without resolving again.
    const authOptions = {
      ...explicit === undefined ? {} : { apiKey: explicit },
      ...signal === undefined ? {} : { signal },
    }
    try {
      resolved = await (model === undefined
        ? models.getAuth(provider, authOptions)
        : models.getAuth(model, authOptions))
    }
    catch (error) {
      if (error instanceof ModelsError) return { apiKey: explicit, checked: { ok: false, error } }
      throw error
    }
    lookup?.throwIfAborted()
    if (provider === 'anthropic' && stored?.type === 'oauth') {
      if (resolved?.source !== 'OAuth' || resolved.auth.apiKey === undefined) {
        throw new LlmError('Anthropic subscription sign-in was removed or replaced; sign in again. API-key billing was not selected.', 'AUTH')
      }
      return { apiKey: undefined, checked: { ok: true, result: structuredClone(resolved) } }
    }
    const resolvedCredentials = [resolved?.auth.apiKey, ...Object.values(resolved?.auth.headers ?? {})]
    if ((provider === 'anthropic' || messages) && carriesSubscriptionToken([explicit, ...resolvedCredentials, ...Object.values(headers)])) {
      throw new LlmError(SUBSCRIPTION_TOKEN_REFUSAL, 'AUTH')
    }
    return { apiKey: explicit, checked: { ok: true, result: structuredClone(resolved) } }
  }

  /**
   * The collection one request dispatches through. Without a checked
   * resolution it is the snapshot's own, which resolves authentication at
   * dispatch. With one, it is a request-local collection, over an empty
   * in-memory credential store, whose only provider is the snapshot's provider
   * with its authentication replaced by that resolution, so `Models.applyAuth`
   * applies exactly the checked key, base URL, headers and environment and
   * reads, refreshes or resolves nothing again. A checked failure is
   * reported by the provider's stream setup with the original error, which is
   * what the dispatch's own resolution would have reported; the provider's
   * protocol implementation never runs. The collection lives only as long as
   * the request and is never shared.
   * @param snapshot - the captured configuration.
   * @param model - the exact model being requested.
   * @param checked - the request's single checked resolution, if one was made.
   * @returns the collection to stream through.
   */
  private dispatchModels(snapshot: PiAiSnapshot, model: Model<Api>, checked: CheckedAuth | undefined): Models {
    const provider = snapshot.models.getProvider(model.provider)
    if (checked === undefined || provider === undefined) return snapshot.models
    // No credential store: a stored record would take precedence over the
    // checked resolution, and this collection must neither read nor refresh one.
    const pinned = createModels({ authContext: this.config.auth.authContext })
    const failed = checked.ok ? undefined : checked.error
    pinned.setProvider({
      ...provider,
      auth: { apiKey: {
        name: 'checked request authentication',
        resolve: () => Promise.resolve(checked.ok ? checked.result : { auth: {} }),
      } },
      ...failed === undefined ? {} : { streamSimple: () => { throw failed } },
    })
    return pinned
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      return this.lookup(profile, undefined, signal => this.offers(snapshot, provider, profile, signal))
    })
  }

  /**
   * Run one model lookup under the route's `modelListTimeoutMs`, the owner
   * lifetime and the caller's signal, from admission through every credential
   * read and network listing. The returned promise settles when the first bound
   * fires even if a credential read that cannot be cancelled is still pending;
   * that abandoned work stops at its next step, before any further I/O or
   * report, and its eventual outcome is discarded.
   */
  private lookup<T>(
    profile: ResolvedPiAiProviderProfile,
    caller: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return withinBounds({ timeoutMs: profile.modelListTimeoutMs, lifetime: this.config.lifetime }, caller, operation)
  }

  /** The offers of one route within a lookup already bounded by `signal`. */
  private async offers(
    snapshot: PiAiSnapshot,
    provider: string,
    profile: ResolvedPiAiProviderProfile,
    signal: AbortSignal,
  ): Promise<readonly LlmModelInfo[]> {
    if (profile.accountPool !== undefined) {
      // A listing selects no account and refreshes no grant: it reads each
      // account's own store and offers the catalog while any account is signed in.
      if (!await this.poolOf(snapshot, profile).hasGrant(signal)) return []
      signal.throwIfAborted()
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    }
    let apiKey: string | undefined
    try { ({ apiKey } = await this.requestAuth(snapshot, provider, profile, undefined, signal)) }
    catch (error) {
      // A route whose named key does not resolve cannot serve a request, so it offers no models until the key is stored.
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
      throw error
    }
    if (await this.offersByAccount(provider, apiKey, signal)) return this.accountOffers(snapshot, provider, profile, signal)
    const catalog = snapshot.models.getModels(provider)
    // A provider that narrows its catalog per credential (Copilot, by the
    // signed-in account) is asked with the effective credential, so the picker
    // offers only models the account can call. Explicitly selecting another
    // catalog model still resolves; this narrows the offer, not the route.
    const piProvider = snapshot.models.getProvider(provider)
    const offered = piProvider?.filterModels === undefined
      ? catalog
      : piProvider.filterModels(catalog, apiKey === undefined
        ? await this.config.auth.credentials.read(provider, { signal })
        : { type: 'api_key', key: apiKey })
    signal.throwIfAborted()
    return offered.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    }))
  }

  /** Whether this route's offers come from the signed-in account's own listing. */
  private async offersByAccount(provider: string, apiKey: string | undefined, signal: AbortSignal): Promise<boolean> {
    if (provider !== 'openai' || apiKey !== undefined) return false
    const stored = await this.config.auth.credentials.read(provider, { signal })
    signal.throwIfAborted()
    return stored?.type === 'oauth'
  }

  /**
   * The signed-in account's list-visible models, in the server's order and with
   * its display names, limited to the models the captured configuration can
   * resolve. A slug the account lists but the configuration has no metadata for
   * is withheld rather than offered: choosing it could only fail. The withheld
   * report is made only while the lookup is still live.
   */
  private async accountOffers(
    snapshot: PiAiSnapshot,
    provider: string,
    profile: ResolvedPiAiProviderProfile,
    signal: AbortSignal,
  ): Promise<LlmModelInfo[]> {
    const account = await discoverModels({ provider, signal }, () => ({
      headers: profile.headers,
      resolveApiKey: this.config.resolveApiKey.bind(undefined, provider, profile),
      chatgpt: async (chatgptSignal) => {
        return { baseURL: profile.baseURL ?? 'https://api.openai.com/v1', accessToken: await chatgptAccessToken(snapshot.models, chatgptSignal) }
      },
    }))
    signal.throwIfAborted()
    const offers: LlmModelInfo[] = []
    const withheld: string[] = []
    for (const row of account) {
      const known = profile.modelErrors.has(row.id) ? undefined : snapshot.models.getModel(provider, row.id)
      if (known === undefined) withheld.push(row.id)
      else offers.push({ ...row, provider, inputModalities: [...known.input] })
    }
    if (withheld.length > 0) this.config.onUnofferedAccountModels?.({ provider, models: withheld })
    return offers
  }

  override canSelectModel(provider: string, model: string, signal?: AbortSignal): Promise<boolean> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      return this.lookup(profile, signal, async (bounded) => {
        if (profile.accountPool !== undefined) {
          return (await this.offers(snapshot, provider, profile, bounded)).some(entry => entry.id === model)
        }
        let apiKey: string | undefined
        try { ({ apiKey } = await this.requestAuth(snapshot, provider, profile, undefined, bounded)) }
        catch (error) {
          if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return false
          throw error
        }
        // The account listing needs the network, and choosing a registered model must not.
        // The account still decides at inference whether the grant may use it.
        if (await this.offersByAccount(provider, apiKey, bounded)) {
          return !profile.modelErrors.has(model) && snapshot.models.getModel(provider, model) !== undefined
        }
        return (await this.offers(snapshot, provider, profile, bounded)).some(entry => entry.id === model)
      })
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
      ...conversationUpdates(resolvedModel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    return Promise.resolve().then(() => {
      const profile = this.profileOf(snapshot, provider)
      const piModel = structuredClone(this.modelOf(snapshot, provider, model))
      const stream = (options: GenerateOptions) => this.streamOf(options, snapshot, piModel)
      return {
        model: this.modelInfo(snapshot, provider, model),
        assessControls: controls => assessPiAiControls(piModel, profile, controls),
        finalizeControls: async (controls, caller) => {
          const assessment = assessPiAiControls(piModel, profile, controls)
          if (profile.accountPool !== undefined) {
            return this.finalizePooled(snapshot, profile, piModel, assessment, caller)
          }
          const anthropic = piModel.provider === 'anthropic' && piModel.api === 'anthropic-messages'
          const openai = piModel.provider === 'openai' && piModel.api === 'openai-responses'
            && (controls.temperature !== undefined || controls.maxTokens !== undefined)
          if (!anthropic && !openai) {
            return { assessment, stream }
          }
          const signal = AbortSignal.any([caller, this.config.lifetime].filter(entry => entry !== undefined))
          const settled = Promise.withResolvers<Awaited<ReturnType<PiAiAdapter['requestAuth']>>>()
          const onAbort = (): void => { settled.reject(new LlmError('pi-ai preparation aborted', 'ABORTED', { cause: signal.reason })) }
          signal.addEventListener('abort', onAbort, { once: true })
          try {
            if (signal.aborted) onAbort()
            else this.requestAuth(snapshot, provider, profile, piModel, signal, {}, true).then(settled.resolve, settled.reject)
            let binding: Awaited<ReturnType<PiAiAdapter['requestAuth']>>
            try { binding = await settled.promise }
            catch (error) {
              if (signal.aborted) throw new LlmError('pi-ai preparation aborted', 'ABORTED', { cause: signal.reason })
              if (error instanceof LlmError && ['AUTH', 'MISSING_CREDENTIAL', 'ABORTED'].includes(error.code)) throw error
              // Authentication I/O failures belong to the request stream and its retry owner.
              // This operation must never resolve authentication again.
              return {
                assessment: openai ? finalizeOpenAiControls(piModel, controls, assessment, undefined) : assessment,
                stream: async function* () { await settled.promise },
              }
            }
            signal.throwIfAborted()
            if (binding.checked?.ok === false && classifyPiAiError(binding.checked.error.message) === 'AUTH') {
              throw new LlmError(binding.checked.error.message, 'AUTH', { cause: binding.checked.error })
            }
            const resolved = binding.checked?.ok === true ? binding.checked.result : undefined
            const effective = resolved === undefined ? undefined : {
              ...resolved,
              auth: { ...resolved.auth, ...binding.apiKey === undefined ? {} : { apiKey: binding.apiKey } },
            }
            return {
              assessment: openai ? finalizeOpenAiControls(piModel, controls, assessment, effective) : assessment,
              ...anthropic && resolved?.source === 'OAuth' ? { systemPromptPrefix: ANTHROPIC_OAUTH_SYSTEM_PREFIX } : {},
              stream: options => this.streamWithSnapshot(options, snapshot, binding, piModel),
            }
          } finally {
            signal.removeEventListener('abort', onAbort)
          }
        },
        stream,
      }
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamOf(options, this.current())
  }

  /**
   * One unbound stream call: a pooled route claims its own account first, every
   * other route resolves its authentication inside the stream as before.
   */
  private streamOf(options: GenerateOptions, snapshot: PiAiSnapshot, model?: Model<Api>): AsyncIterable<StreamChunk> {
    return snapshot.profiles.get(options.provider)?.accountPool === undefined
      ? this.streamWithSnapshot(options, snapshot, undefined, model)
      : this.pooledStream(options, snapshot, model)
  }

  private async * pooledStream(options: GenerateOptions, snapshot: PiAiSnapshot, captured?: Model<Api>): AsyncIterable<StreamChunk> {
    const profile = this.profileOf(snapshot, options.provider)
    const model = captured ?? this.modelOf(snapshot, options.provider, options.model)
    let claim: PoolClaim
    try { claim = await this.claimAccount(snapshot, profile, model, options.signal) }
    catch (error) {
      if (options.signal?.aborted) throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      throw error
    }
    yield * this.streamClaim(claim, options, snapshot, model)
  }

  /** The stream of one claim: the account's request, its stored failure, or the cooling report. */
  private streamClaim(
    claim: PoolClaim,
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
    model: Model<Api>,
  ): AsyncIterable<StreamChunk> {
    if (claim.kind === 'cooling') return failedStream(claim.failure)
    const inner = claim.kind === 'failed'
      ? throwingStream(claim.error)
      : this.streamWithSnapshot(options, snapshot, claim.binding, model)
    return observeAccountStream(claim.pool, claim.lease, claim.fingerprint, inner)
  }

  /**
   * Prepare a pooled call: claim one account and authenticate as it, once, for
   * this call. Aborting or failing here releases the claim; an unstreamed
   * prepared call's claim stops counting as load when its reservation expires.
   */
  private async finalizePooled(
    snapshot: PiAiSnapshot,
    profile: ResolvedPiAiProviderProfile,
    piModel: Model<Api>,
    assessment: ReturnType<typeof assessPiAiControls>,
    caller: AbortSignal | undefined,
  ): Promise<{ assessment: ReturnType<typeof assessPiAiControls>; systemPromptPrefix: string; stream: PreparedAdapterCall['stream'] }> {
    const signal = AbortSignal.any([caller, this.config.lifetime].filter(entry => entry !== undefined))
    const settled = Promise.withResolvers<PoolClaim>()
    const release = (claim: PoolClaim): void => { if (claim.kind !== 'cooling') claim.pool.release(claim.lease) }
    const onAbort = (): void => { settled.reject(new LlmError('pi-ai preparation aborted', 'ABORTED', { cause: signal.reason })) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal.aborted) onAbort()
      else {
        this.claimAccount(snapshot, profile, piModel, signal).then((claim) => {
          // An abort that won the race left nobody to own this claim.
          if (signal.aborted) release(claim)
          else settled.resolve(claim)
        }, settled.reject)
      }
      let claim: PoolClaim
      try { claim = await settled.promise }
      catch (error) {
        if (signal.aborted) throw new LlmError('pi-ai preparation aborted', 'ABORTED', { cause: signal.reason })
        throw error
      }
      if (signal.aborted) {
        release(claim)
        throw new LlmError('pi-ai preparation aborted', 'ABORTED', { cause: signal.reason })
      }
      // Until the call streams, its claim belongs to the prepared call: a later
      // abort (a prepared call the loop then discards) gives the account back.
      const releaseOnAbort = (): void => { release(claim) }
      signal.addEventListener('abort', releaseOnAbort, { once: true })
      return {
        assessment,
        systemPromptPrefix: ANTHROPIC_OAUTH_SYSTEM_PREFIX,
        stream: (options) => {
          signal.removeEventListener('abort', releaseOnAbort)
          return this.streamClaim(claim, options, snapshot, piModel)
        },
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Claim the best eligible account and authenticate as it. An account whose
   * grant is missing, revoked or rejected is marked signed out and skipped; a
   * failure that is not about the grant stays with the claim so the stream
   * reports it to the retry owner. When no account is eligible the result is
   * the earliest cooling reset, or a terminal AUTH when every account is signed
   * out. Every path that throws has released the claim it took.
   */
  private async claimAccount(
    snapshot: PiAiSnapshot,
    profile: ResolvedPiAiProviderProfile,
    model: Model<Api>,
    signal?: AbortSignal,
  ): Promise<PoolClaim> {
    const pool = this.poolOf(snapshot, profile)
    if (model.api !== 'anthropic-messages') {
      throw new LlmError('The Claude account pool requires the anthropic-messages protocol.', 'INVALID_CONFIG')
    }
    await pool.readmit(signal)
    for (;;) {
      signal?.throwIfAborted()
      const lease = pool.acquire()
      if (lease === undefined) {
        const reset = pool.earliestReset()
        if (reset === undefined) throw pool.signedOutError()
        return { kind: 'cooling', failure: pool.coolingFailure(reset) }
      }
      try {
        const outcome = await this.authenticateAccount(snapshot, profile, model, pool, lease.account, signal)
        signal?.throwIfAborted()
        if (outcome.kind === 'rejected') {
          pool.release(lease)
          pool.markSignedOut(lease.account, outcome.fingerprint)
          continue
        }
        return { ...outcome, pool, lease }
      } catch (error) {
        pool.release(lease)
        throw error
      }
    }
  }

  /**
   * Authenticate as one account, reading and refreshing only that account's
   * own credentials document. The returned fingerprint identifies the grant
   * the attempt itself ended on: the grant its bearer came from, the refreshed
   * grant when it refreshed, or the grant whose refresh or read failed. It is
   * never read from the store after the attempt, so a sign-in or another
   * process's refresh that replaces the grant meanwhile cannot be mistaken for
   * the grant the provider is about to judge.
   */
  private async authenticateAccount(
    snapshot: PiAiSnapshot,
    profile: ResolvedPiAiProviderProfile,
    model: Model<Api>,
    pool: AccountPool,
    account: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: 'rejected'; readonly fingerprint: string }
    | { readonly kind: 'bound'; readonly fingerprint: string; readonly binding: AuthBinding }
    | { readonly kind: 'failed'; readonly fingerprint: string; readonly error: unknown }
  > {
    const collectionOf = snapshot.accounts.get(account)
    if (collectionOf === undefined) throw new LlmError(`The Claude account "${account}" has no collection in this configuration.`, 'ACCOUNT_POOL_UNAVAILABLE')
    const grants = observeGrant(pool.store(account))
    const scope: AuthScope = { models: collectionOf(grants.store), credentials: grants.store }
    // A call that read no grant has no identity to quarantine, and no stored grant equals this marker.
    const fingerprint = (): string => grants.observed() ?? 'unobserved'
    let binding: AuthBinding
    try { binding = await this.requestAuth(snapshot, model.provider, profile, model, signal, {}, true, scope) }
    catch (error) {
      signal?.throwIfAborted()
      return error instanceof LlmError && ['AUTH', 'MISSING_CREDENTIAL'].includes(error.code)
        ? { kind: 'rejected', fingerprint: fingerprint() }
        : { kind: 'failed', fingerprint: fingerprint(), error }
    }
    if (binding.checked?.ok === false && classifyPiAiError(binding.checked.error.message) === 'AUTH') {
      return { kind: 'rejected', fingerprint: fingerprint() }
    }
    return { kind: 'bound', fingerprint: fingerprint(), binding }
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
    binding?: Awaited<ReturnType<PiAiAdapter['requestAuth']>>,
    capturedModel?: Model<Api>,
  ): AsyncIterable<StreamChunk> {
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = capturedModel ?? this.modelOf(snapshot, options.provider, options.model)
    const updates = conversationUpdates(model)
    // pi-ai collapses Anthropic tool updates without an initially active declaration.
    const tools = options.tools ?? []
    const needsPlaceholder = model.api === 'anthropic-messages' && updates.toolUpdate === 'in-history'
      && tools.every(tool => tool.deferLoading === true)
      && options.messages.some(message => message.role === 'developer'
        && message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal'))
    const request = needsPlaceholder
      ? { ...options, tools: [ANTHROPIC_TOOL_UPDATE_PLACEHOLDER, ...tools] }
      : options
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const headers = requestHeaders(profile.headers, options, model.baseUrl, this.config.prepareHeaders)
    const { apiKey, checked } = binding ?? await this.requestAuth(snapshot, options.provider, profile, model, options.signal, headers)
    const anthropicOAuth = model.provider === 'anthropic' && checked?.ok === true && checked.result?.source === 'OAuth'
    if (anthropicOAuth) {
      if (Object.keys(headers).some(name => /^(authorization|x-api-key)$/i.test(name))) {
        throw new LlmError('Anthropic subscription authentication cannot be overridden by request auth headers.', 'AUTH')
      }
      // The maintained OAuth transport supplies its compatibility User-Agent.
      // Other Harness attribution remains; no native backend is involved.
      delete headers['user-agent']
    }
    const dispatch = this.dispatchModels(snapshot, model, checked)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(request, undefined, onReplayDegrade, updates.systemPromptUpdate === 'in-history')
        : await toPiContext({ ...request, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade, updates.systemPromptUpdate === 'in-history')
      stripOAuthPrefix(context, anthropicOAuth)
      // pi-ai flattens a rejected response into error text; the observer keeps
      // its status, Retry-After, and request id for the failure chunk. Codex alone
      // drops an in-band failure frame's code the same way, so only it is handed
      // the frame callback.
      const wire = isWireObservable(model.api) ? observeWire() : undefined
      const events = dispatch.streamSimple(model, context, {
        ...profileOptions(profile, model, reasoning, apiKey),
        ...wire === undefined ? {} : { fetch: wire.fetch },
        ...wire === undefined || model.api !== 'openai-codex-responses' ? {} : { onProviderStreamEvent: wire.onProviderStreamEvent },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        headers,
      })
      const iterator = toStreamChunks(
        events, model.contextWindow, options.signal, model.id, wire,
      )[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          // A demand the deadline abandoned can stay pending forever, and this
          // generator queues its return behind it; the abort above owns SDK termination.
          /* v8 ignore next -- the detached drain only rejects while unwinding an abandoned stream. */
          void iterator.return(undefined).catch(() => {})
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}

/** Let the maintained transport encode its mandatory prefix once when the caller already supplied it. */
function stripOAuthPrefix(context: { systemPrompt?: string }, anthropicOAuth: boolean): void {
  if (anthropicOAuth) {
    if (context.systemPrompt === ANTHROPIC_OAUTH_SYSTEM_PREFIX) delete context.systemPrompt
    else if (context.systemPrompt?.startsWith(`${ANTHROPIC_OAUTH_SYSTEM_PREFIX}\n\n`)) {
      context.systemPrompt = context.systemPrompt.slice(ANTHROPIC_OAUTH_SYSTEM_PREFIX.length + 2)
    }
  }
}
