/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * Catalog routes use installed model metadata without a network request,
 * except for a stored ChatGPT plan grant: its account-specific public listing
 * supplies visible slugs and display names. Other endpoints are interrogated
 * when the installed catalog does not describe them.
 *
 * Neither path is a catalog refresh. Nothing here is stored: the request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `cordis.patch.yml` remains the only
 * thing that decides what a route serves.
 *
 * OpenAI-compatible and Anthropic Messages protocols are interrogated through
 * their native model-listing endpoints. The parser accepts the standard
 * `data` array and the enriched `models` map some compatible gateways expose.
 * Every other protocol reports that it cannot be interrogated so the surface
 * falls back to hand-entry rather than guessing its response fields.
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryOperation } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { carriesSubscriptionToken, SUBSCRIPTION_TOKEN_REFUSAL } from './auth.ts'
import { catalogModels } from './catalog.ts'

/** Discovered rows always carry a display name, including id-based defaults. */
type DiscoveredModel = LlmDiscoveredModel & { readonly name: string }

/**
 * Protocols whose model listing this module can read. OpenAI protocols use
 * bearer auth at `GET {baseURL}/models`; Anthropic Messages uses `x-api-key`
 * and `anthropic-version` at its native `GET /v1/models`. Azure is absent
 * despite its OpenAI lineage — it authenticates with an `api-key` header and
 * requires an `api-version` query — and Codex authenticates through OAuth;
 * guessing at either would report an authentication failure as a provider
 * with no models. pi-ai's remaining protocols are absent for the same reason.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** Visible ChatGPT entries use account-owned request slugs and display names. */
const CHATGPT_MODEL = z.object({ slug: z.string().min(1).required(), display_name: z.string().min(1).required() })

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest model-list page accepted by Anthropic's public endpoint; discovery reads one page and does not follow `has_more`. */
const ANTHROPIC_MODEL_LIMIT = 1000

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Capacity fields nested by enriched model-directory replies. */
interface ListingLimit {
  context?: unknown
  output?: unknown
}

/** Per-route capacities OpenRouter nests under each entry. */
interface ListingTopProvider {
  max_completion_tokens?: unknown
}

/** One entry of a supported `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_tokens?: unknown
  max_completion_tokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  limit?: ListingLimit | null
  top_provider?: ListingTopProvider | null
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Join the endpoint base with the protocol's listing path. The base is
 * treated as a prefix rather than a URL to resolve against, so a deployment
 * path such as `https://gateway.example/openai/v1` keeps its segments instead
 * of losing them to `URL` resolution. OpenAI protocols list at
 * `{baseURL}/models`. Anthropic lists at `{root}/v1/models`, where the root is
 * the base without trailing slashes and without one trailing `/v1` segment:
 * gateway documentation publishes both spellings of the same root. Only this
 * listing URL normalizes that segment; model requests receive the configured
 * `baseURL` unchanged.
 */
function listingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one supported model-listing reply. The standard `data` array takes
 * precedence when both supported formats are present. An enriched `models`
 * map uses each property key as the endpoint-facing id; its nested `id` is
 * only a fallback for an empty key because gateways may put a canonical model
 * identity there instead of the alias they accept on requests. Only
 * object-valued map entries are models; primitive properties are ignored
 * because they may be directory metadata rather than model records.
 *
 * Entries without a usable id are skipped rather than failing the whole
 * interrogation: a single malformed row should not deny the user the rest of
 * a working endpoint's catalog. Missing names fall back to the adopted id so
 * the Web form receives a complete human-readable row.
 */
function readListing(body: unknown): DiscoveredModel[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  const data = listing?.data
  let listed: { readonly key?: string; readonly raw: unknown }[]
  if (Array.isArray(data)) {
    const rows = data as readonly unknown[]
    listed = rows.map(raw => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new LlmError(
        'the endpoint\'s model listing has neither a "data" array nor a "models" object; '
        + 'enter this provider\'s models by hand',
        'DISCOVERY_FAILED',
      )
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const models: DiscoveredModel[] = []
  for (const { key, raw } of listed) {
    const entry = raw as ListingEntry | null
    const id = label(key, entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id
    const contextWindow = capacity(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context,
    )
    const maxTokens = capacity(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.max_completion_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens,
    )
    models.push({
      id,
      name,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/** Host-owned profile inputs that a configuration draft deliberately omits. */
export interface StoredModelDiscoveryProfile {
  /** Deployment headers configured on the named route. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** Resolve the named route's credential only when the draft carries none. */
  readonly resolveApiKey: () => Promise<string | undefined>
  /** Resolve a stored ChatGPT grant through pi-ai, including refresh; absent for API-key routes. */
  readonly chatgpt?: (signal: AbortSignal) => Promise<{ baseURL: string; accessToken: string } | undefined>
}

/**
 * Interrogate one draft provider endpoint for the models it advertises. This
 * applies no deadline of its own; product callers run it through
 * {@link withinBounds}, whose combined signal it passes to every cancellable
 * step and checks after each credential wait.
 * @param request - the endpoint, protocol, one-shot credential, and the
 *   lookup's signal.
 * @param storedProfile - Host-owned headers and lazy credential resolution for
 *   the named route. A stored ChatGPT grant selects account discovery before
 *   the catalog shortcut; other credentials resolve only on the network path
 *   when the draft carries none.
 * @returns the advertised models with display names in endpoint order.
 * @throws LlmError when the protocol has no readable listing, the endpoint
 *   refuses or fails the request, or the reply is not a model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryOperation & { readonly signal: AbortSignal },
  storedProfile?: () => StoredModelDiscoveryProfile | undefined,
): Promise<readonly DiscoveredModel[]> {
  let stored = request.provider === 'openai' ? storedProfile?.() : undefined
  const plan = request.provider === 'openai' && request.apiKey === undefined
    ? await stored?.chatgpt?.(request.signal) : undefined
  // A credential wait may outlive its lookup's bounds; abandoned work stops here.
  request.signal.throwIfAborted()
  // A catalog route already has its answer, and a better one: the installed
  // entries carry context windows and output caps no listing endpoint reports.
  if (plan === undefined && request.provider !== undefined) {
    const installed = catalogModels(request.provider)
    if (installed.size > 0) {
      return [...installed.values()].map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        inputModalities: [...model.input],
      }))
    }
  }
  const baseURL = plan?.baseURL ?? request.baseURL
  if (baseURL === undefined || baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  // A draft that has not chosen a protocol yet is asked as OpenAI Chat
  // Completions: it is the shape a gateway is overwhelmingly likely to speak,
  // and the alternative — refusing until the field is filled — would withhold
  // the action from the case it exists for. The cost is a misdirected message
  // when the endpoint speaks something else (an Anthropic gateway answers 401,
  // which reads as a credential problem), and hand-entry remains the way out.
  const api = plan === undefined ? request.api ?? 'openai-completions' : 'openai-responses'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const url = listingUrl(baseURL, api)
  // A key typed into the form wins: it may replace the stored key that is
  // failing. Non-plan credentials resolve past the catalog and protocol checks,
  // and its credential resolver remains lazy so a typed key cannot fail over a
  // stored credential it supersedes. A route may still authenticate through a
  // deployment-owned Authorization header when neither key exists.
  stored ??= storedProfile?.()
  const supplied = plan?.accessToken ?? request.apiKey ?? await stored?.resolveApiKey()
  request.signal.throwIfAborted()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  // The listing carries the key and deployment headers to whatever endpoint the
  // draft names, so a Claude subscription token is refused here exactly as the
  // request path refuses it, before anything is sent.
  if (api === 'anthropic-messages' && carriesSubscriptionToken([apiKey, ...Object.values(stored?.headers ?? {})])) {
    throw new LlmError(SUBSCRIPTION_TOKEN_REFUSAL, 'AUTH')
  }
  let response: Response
  try {
    const headers = new Headers(stored?.headers === undefined ? undefined : Object.entries(stored.headers))
    headers.set('accept', 'application/json')
    if (api === 'anthropic-messages') {
      headers.set('anthropic-version', ANTHROPIC_VERSION)
      if (apiKey !== undefined) headers.set('x-api-key', apiKey)
    } else if (apiKey !== undefined) {
      headers.set('authorization', `Bearer ${apiKey}`)
    }
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: request.signal,
    })
  } catch (error: unknown) {
    if (request.signal.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // Cancellation during the body read rejects with the abort reason, which
    // may be any value; the caller gets the same coded failure it would have
    // for a cancellation before the request went out.
    if (request.signal.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (plan !== undefined) {
    if (typeof body !== 'object' || body === null || !('models' in body) || !Array.isArray(body.models)) {
      throw new LlmError(`${url} did not return a ChatGPT model listing`, 'DISCOVERY_FAILED')
    }
    const models: DiscoveredModel[] = []
    const rows: readonly unknown[] = body.models
    for (const entry of rows) {
      if (typeof entry !== 'object' || entry === null || !('visibility' in entry) || entry.visibility !== 'list') continue
      let parsed: ReturnType<typeof CHATGPT_MODEL>
      try { parsed = CHATGPT_MODEL(entry) }
      catch (error) { throw new LlmError(`${url} returned an invalid ChatGPT model entry`, 'DISCOVERY_FAILED', { cause: error }) }
      models.push({ id: parsed.slug, name: parsed.display_name })
    }
    return models
  }
  return readListing(body)
}

/** The two bounds every network model listing runs under. */
export interface DiscoveryBounds {
  /** Validated deadline in milliseconds for the whole lookup, body included. */
  readonly timeoutMs: number
  /** Owner lifetime; its abort cancels the lookup and releases the connection. */
  readonly lifetime: AbortSignal | undefined
}

/**
 * Run one model lookup under a deadline, its owner's lifetime and its caller's
 * signal. The operation receives one signal combining all three and must pass
 * it to every cancellable step and check it after every wait it cannot cancel.
 *
 * The returned promise settles as soon as any bound fires, even while the
 * operation still waits on a step that ignores the signal, such as a credential
 * read whose interface takes none. That abandoned operation keeps running only
 * until its next signal check, which it reaches before any further I/O or
 * report; its eventual outcome is observed and discarded here, so a late
 * rejection is never unhandled. The deadline timer and abort listener are
 * released when the returned promise settles.
 * @param bounds - the deadline and owner lifetime.
 * @param caller - the caller's own cancellation, if any.
 * @param operation - the lookup, given the combined signal.
 * @returns what the operation resolves with, when it finishes first.
 * @throws LlmError `TIMEOUT` when the deadline fires first; `ABORTED` for the
 *   caller's or the owner's cancellation; otherwise what the operation throws.
 */
export async function withinBounds<T>(
  bounds: DiscoveryBounds,
  caller: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort() }, bounds.timeoutMs)
  const signal = AbortSignal.any([deadline.signal, bounds.lifetime, caller].filter(entry => entry !== undefined))
  const bounded = (cause: unknown): LlmError => {
    const cancelled = bounds.lifetime?.aborted === true || caller?.aborted === true
    return cancelled
      ? new LlmError('model discovery aborted by caller', 'ABORTED', { cause })
      : new LlmError(`model listing did not finish within ${String(bounds.timeoutMs)}ms`, 'TIMEOUT', { cause })
  }
  const settled = Promise.withResolvers<T>()
  const onAbort = (): void => { settled.reject(bounded(signal.reason)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    // An abort rejects synchronously from its listener, before any reaction to
    // the operation's own outcome can run, so the bound always names the failure.
    if (signal.aborted) onAbort()
    else operation(signal).then(settled.resolve, settled.reject)
    return await settled.promise
  } finally {
    signal.removeEventListener('abort', onAbort)
    clearTimeout(timer)
  }
}

/**
 * Run {@link discoverModels} through {@link withinBounds}, so a listing whose
 * credential lookup is held, or whose endpoint never answers or stalls
 * mid-body, settles and closes its connection instead of holding its caller.
 * @param bounds - the deadline and owner lifetime.
 * @param request - the draft or route to interrogate.
 * @param storedProfile - Host-owned headers and credential resolution.
 * @returns the advertised models in endpoint order.
 * @throws LlmError `TIMEOUT` when the deadline passes first; `ABORTED` for the
 *   caller's or the owner's cancellation; otherwise what {@link discoverModels} throws.
 */
export function discoverModelsWithin(
  bounds: DiscoveryBounds,
  request: LlmModelDiscoveryOperation,
  storedProfile?: () => StoredModelDiscoveryProfile | undefined,
): Promise<readonly DiscoveredModel[]> {
  return withinBounds(bounds, request.signal, signal => discoverModels({ ...request, signal }, storedProfile))
}
