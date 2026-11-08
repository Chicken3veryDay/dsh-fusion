/**
 * Failure facts of one provider request, captured below pi-ai.
 *
 * pi-ai folds a failed request into `AssistantMessage.errorMessage` text, so the
 * status, `Retry-After`, and request id of the rejected response are gone by the
 * time the harness sees the error. pi-ai exposes one structured seam that still
 * sees them: the `fetch` it is told to use. This module wraps that `fetch`
 * and keeps the facts of the one rejected response a request produced. A Codex
 * failure carried inside a successful stream loses its code the same way; pi-ai's
 * `onProviderStreamEvent` sees the frame first, so the observer keeps that code too.
 *
 * @module dsh-llm-pi-ai/wire
 */

import { ProviderRequestId } from '@deepseek-ai/dsh-llm'

/** The `fetch` signature pi-ai accepts in its request options. */
export type WireFetch = typeof globalThis.fetch

/** What a rejected (non-2xx) provider response said, in the harness failure vocabulary. */
export interface WireFailure {
  /** HTTP status of the rejected response. */
  readonly status: number
  /** Delay the provider asked for, in milliseconds, when its headers gave a valid one. */
  readonly providerRetryAfterMs?: number
  /** The provider's request identifier, when its headers carried one. */
  readonly requestId?: ProviderRequestId
  /**
   * The structured `error.code` or `error.type` of a 429 body. pi-ai flattens
   * that body to display text, so this is the only record of whether a 429 is
   * an exhausted quota or a transient rate limit. Classification input only:
   * it never becomes a persisted failure field.
   */
  readonly providerCode?: string
}

/** One request's observer: the `fetch` and frame callback to hand pi-ai, and the facts they saw. */
export interface WireObserver {
  /** Pass as pi-ai's `fetch` option; behaves exactly like `globalThis.fetch` and only reads each response. */
  readonly fetch: WireFetch
  /**
   * Pass as pi-ai's `onProviderStreamEvent` option of an `openai-codex-responses` request.
   * Only reads the frame and never throws, so it cannot turn into pi-ai's callback failure.
   */
  readonly onProviderStreamEvent: (frame: unknown) => void
  /** @returns the facts of the most recent rejected response, or undefined when none was rejected. */
  failure(): WireFailure | undefined
  /**
   * @returns the code of the Codex terminal failure frame (`error` or `response.failed`) when it
   *   was the last frame of the current HTTP attempt, else undefined. Classification input only:
   *   like {@link WireFailure.providerCode}, it never becomes a persisted failure field.
   */
  frameErrorCode(): string | undefined
}

/**
 * Provider APIs whose pi-ai implementation honors the `fetch` option. Google
 * and Bedrock reject or ignore a custom `fetch`, so a request to them is not
 * observed and its status stays what pi-ai's message text says.
 */
const OBSERVABLE_APIS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
])

/**
 * Whether pi-ai passes a custom `fetch` through for one API.
 * @param api - the pi-ai API identifier of the request's model.
 * @returns true when {@link observeWire} can see that API's HTTP responses.
 */
export function isWireObservable(api: string): boolean {
  return OBSERVABLE_APIS.has(api)
}

/**
 * The delay a provider asked for. `retry-after-ms` wins over `retry-after`,
 * which is either delay-seconds or an HTTP date.
 * @param headers - the rejected response's headers.
 * @returns milliseconds greater than zero, or undefined when absent or invalid.
 */
export function providerRetryAfterMs(headers: Headers): number | undefined {
  const milliseconds = Number.parseFloat(headers.get('retry-after-ms') ?? '')
  if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds
  const retryAfter = headers.get('retry-after')
  if (retryAfter === null) return undefined
  const seconds = Number.parseFloat(retryAfter)
  const delay = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/** Most of a 429 body inspected for its structured error code. */
const ERROR_BODY_LIMIT_BYTES = 16 * 1024

/**
 * A body read that failed or a cancel that found nothing to release: the clone
 * only feeds classification, so either leaves the status-only classification.
 * @param _error - the stream failure, intentionally unused.
 * @returns undefined, the "no usable body" marker.
 */
const unreadable = (_error: unknown): undefined => undefined

/**
 * Read a rejected response's clone up to {@link ERROR_BODY_LIMIT_BYTES}.
 * @param response - the rejected response; its own body stays readable.
 * @returns the decoded text, or undefined when the body is absent, unreadable, or larger than the limit.
 */
async function readBoundedErrorBody(response: Response): Promise<string | undefined> {
  const reader = response.clone().body?.getReader()
  if (reader === undefined) return undefined
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read().catch(unreadable)
      if (chunk === undefined) return undefined
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > ERROR_BODY_LIMIT_BYTES) return undefined
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    // Not awaited: a tee branch's cancel settles only after the other branch,
    // which pi-ai still reads, is cancelled or drained too.
    void reader.cancel().catch(unreadable)
  }
}

/**
 * Parse an error body as JSON.
 * @param text - the bounded body text.
 * @returns the parsed value, or undefined when the text is not JSON.
 */
function parseJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch (error) {
    // A body that is not JSON carries no structured code, and the caller reads its absence.
    void error
    return undefined
  }
}

/**
 * Read the structured error code of a rate-limit response from a clone, so the
 * body pi-ai reads is untouched.
 * @param response - the rejected response.
 * @returns `error.code` or `error.type` from a bounded JSON body, or undefined for any other body.
 */
async function providerErrorCode(response: Response): Promise<string | undefined> {
  const text = await readBoundedErrorBody(response)
  const parsed = text === undefined ? undefined : parseJson(text)
  const failure: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'error') : undefined
  if (typeof failure !== 'object' || failure === null) return undefined
  for (const field of ['code', 'type']) {
    const value: unknown = Reflect.get(failure, field)
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * One field of a parsed stream value.
 * @param value - a frame or one of its fields, as parsed from the stream.
 * @param field - the field to read.
 * @returns the field's value, or undefined when `value` is not an object.
 */
function fieldOf(value: unknown, field: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, field) : undefined
}

/**
 * Read the code of a Codex terminal failure frame the way pi-ai does: an `error` frame's
 * top-level `code`, else its nested `error.code`; a `response.failed` frame's `response.error.code`.
 * @param frame - one parsed provider frame.
 * @returns the non-empty code, or undefined for any other frame or a frame without one.
 */
function frameErrorCodeOf(frame: unknown): string | undefined {
  const type = fieldOf(frame, 'type')
  const top = fieldOf(frame, 'code')
  const code = type === 'error' ? typeof top === 'string' ? top : fieldOf(fieldOf(frame, 'error'), 'code')
    : type === 'response.failed' ? fieldOf(fieldOf(fieldOf(frame, 'response'), 'error'), 'code')
      : undefined
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/**
 * Observe the HTTP responses and Codex stream frames of one provider request.
 *
 * The observer resolves `globalThis.fetch` on each call, so a proxy dispatcher
 * or test double installed after construction still applies, and it returns the
 * response untouched: nothing here retries or delays. A 429 body is read from a
 * clone, bounded to {@link ERROR_BODY_LIMIT_BYTES}, to keep its structured code.
 * The frame code follows the last frame only, and each HTTP attempt starts without one.
 * @returns the observer for exactly one request; do not share it between requests.
 */
export function observeWire(): WireObserver {
  let seen: WireFailure | undefined
  let frameCode: string | undefined
  return {
    fetch: async (input, init) => {
      frameCode = undefined
      const response = await globalThis.fetch(input, init)
      if (response.ok) return response
      const retryAfterMs = providerRetryAfterMs(response.headers)
      const id = response.headers.get('x-request-id') ?? response.headers.get('request-id')
      const providerCode = response.status === 429 ? await providerErrorCode(response) : undefined
      seen = {
        status: response.status,
        ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
        ...id === null || id === '' ? {} : { requestId: ProviderRequestId(id) },
        ...providerCode === undefined ? {} : { providerCode },
      }
      return response
    },
    onProviderStreamEvent: (frame) => { frameCode = frameErrorCodeOf(frame) },
    failure: () => seen,
    frameErrorCode: () => frameCode,
  }
}
