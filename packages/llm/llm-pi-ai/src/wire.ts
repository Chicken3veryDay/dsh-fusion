/**
 * HTTP facts about a rejected provider response, captured below pi-ai.
 *
 * pi-ai folds a failed request into `AssistantMessage.errorMessage` text, so the
 * status, `Retry-After`, and request id of the rejected response are gone by the
 * time the harness sees the error. pi-ai exposes one structured seam that still
 * sees them: the `fetch` it is told to use. This module wraps that `fetch`
 * and keeps the facts of the one rejected response a request produced.
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
}

/** One request's observer: the `fetch` to hand pi-ai and the facts it saw. */
export interface WireObserver {
  /** Pass as pi-ai's `fetch` option; behaves exactly like `globalThis.fetch` and only reads each response. */
  readonly fetch: WireFetch
  /** @returns the facts of the most recent rejected response, or undefined when none was rejected. */
  failure(): WireFailure | undefined
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

/**
 * Observe the HTTP responses of one provider request.
 *
 * The observer resolves `globalThis.fetch` on each call, so a proxy dispatcher
 * or test double installed after construction still applies, and it returns the
 * response untouched: nothing here retries, delays, or reads a body.
 * @returns the observer for exactly one request; do not share it between requests.
 */
export function observeWire(): WireObserver {
  let seen: WireFailure | undefined
  return {
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init)
      if (response.ok) return response
      const retryAfterMs = providerRetryAfterMs(response.headers)
      const id = response.headers.get('x-request-id') ?? response.headers.get('request-id')
      seen = {
        status: response.status,
        ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
        ...id === null || id === '' ? {} : { requestId: ProviderRequestId(id) },
      }
      return response
    },
    failure: () => seen,
  }
}
