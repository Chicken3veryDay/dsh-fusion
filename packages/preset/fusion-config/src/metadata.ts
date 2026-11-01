/** Bounded exact-ID metadata traversal; all requests stay on the configured origin. */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { z } from 'zod'
import type { Binding } from './catalog.ts'

/** Deployment-owned response, traversal and time limits; limits never imply absence. */
export const limitsSchema = z.strictObject({
  responseBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pages: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
})
/** Parsed traversal bounds, including the complete encoded response size. */
export type MetadataLimits = z.infer<typeof limitsSchema>
/** Sanitized evidence retained without response bodies, headers, credentials or continuation URLs. */
export interface MetadataReceipt {
  readonly host: string
  readonly endpoint: string
  readonly retrievedAt: string
  readonly pages: number
  readonly bytes: number
  readonly listingDigest: string
  readonly selectedId: string
  readonly providerEvidence: 'absent' | 'consistent'
}
/** Complete traversal alone establishes membership or absence. All other outcomes block. */
export type Membership =
  | { readonly kind: 'present' | 'absent'; readonly receipt: MetadataReceipt }
  | { readonly kind: 'unknown'; readonly code: 'cancelled' | 'timeout' | 'limit' | 'metadata-failed' | 'invalid-page' | 'invalid-continuation' | 'conflicting-evidence' }

const modelSchema = z.object({
  id: z.string().min(1),
  canonical_model_id: z.string().optional(),
  family: z.string().optional(),
  capabilities: z.object({
    tools: z.boolean().optional(), structured_decisions: z.boolean().optional(), efforts: z.array(z.string()).optional(),
  }).optional(),
})
const pageSchema = z.strictObject({
  object: z.string().optional(),
  first_id: z.string().nullable().optional(),
  data: z.array(modelSchema),
  has_more: z.boolean().optional(),
  last_id: z.string().min(1).nullable().optional(),
  next: z.string().min(1).nullable().optional(),
  next_page: z.string().min(1).nullable().optional(),
})

class MetadataFailure extends Error {
  constructor(readonly code: Extract<Membership, { kind: 'unknown' }>['code']) { super(code) }
}

/**
 * Derive the provider's authoritative listing endpoint without duplicating /v1.
 * @param binding - exact configured upstream.
 * @returns metadata URL on the binding's pinned origin.
 */
export function metadataEndpoint(binding: Binding): URL {
  const base = new URL(binding.baseURL)
  base.pathname = `${base.pathname.replace(/\/$/u, '').replace(/\/v1$/u, '')}/v1/models`
  return base
}

async function boundedBody(response: Response, remaining: number, limit: number): Promise<{ text: string; bytes: number }> {
  if (response.body === null) throw new MetadataFailure('invalid-page')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > limit || bytes > remaining) throw new MetadataFailure('limit')
      chunks.push(part.value)
    }
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), bytes }
  } finally {
    await reader.cancel().catch((error: unknown) => {
      // A fetch-aborted body is already closed; the caller reports cancellation.
      if (!(error instanceof Error)) throw error
    })
    reader.releaseLock()
  }
}

function continuation(page: z.infer<typeof pageSchema>, url: URL, binding: Binding): URL | undefined {
  const links = [page.next, page.next_page].filter(value => value !== undefined && value !== null)
  if (links.length > 1 && links[0] !== links[1]) throw new MetadataFailure('invalid-continuation')
  const link = links[0]
  if (page.has_more === false && link !== undefined) throw new MetadataFailure('invalid-continuation')
  let next: URL | undefined
  if (link !== undefined) next = new URL(link, url)
  else if (page.has_more === true) {
    if (binding.transport !== 'anthropic-messages' || page.last_id === undefined || page.last_id === null) throw new MetadataFailure('invalid-continuation')
    next = new URL(url)
    next.searchParams.set('after_id', page.last_id)
  }
  if (next !== undefined && (next.origin !== url.origin || next.username || next.password || next.hash)) {
    throw new MetadataFailure('invalid-continuation')
  }
  return next
}

/**
 * Read all advertised pages, checking exact identity and declared provider evidence.
 * Never dispatches inference, follows redirects, or returns raw provider failures.
 * @param binding - frozen selected binding and pinned upstream.
 * @param key - operation-local resolved credential, never retained in the result.
 * @param limits - explicit response, total, page and time bounds.
 * @param signal - caller cancellation; omission uses only the traversal deadline.
 * @returns present/absent only after complete traversal; otherwise unknown with a safe code.
 */
export async function exactMembership(binding: Binding, key: string, limits: MetadataLimits, signal?: AbortSignal): Promise<Membership> {
  const deadline = AbortSignal.timeout(limits.timeoutMs)
  const cancellation = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const endpoint = metadataEndpoint(binding)
  const seen = new Set<string>()
  const ids = new Set<string>()
  let next: URL | undefined = endpoint
  let pages = 0
  let bytes = 0
  let evidence = false
  try {
    while (next !== undefined) {
      cancellation.throwIfAborted()
      if (pages >= limits.pages) throw new MetadataFailure('limit')
      if (seen.has(next.href)) throw new MetadataFailure('invalid-continuation')
      seen.add(next.href)
      const response = await fetch(next, {
        method: 'GET', redirect: 'manual', signal: cancellation,
        headers: binding.transport === 'anthropic-messages'
          ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          : { authorization: `Bearer ${key}` },
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new MetadataFailure('metadata-failed')
      }
      if (response.headers.has('link')) {
        await response.body?.cancel()
        throw new MetadataFailure('invalid-continuation')
      }
      const body = await boundedBody(response, limits.totalBytes - bytes, limits.responseBytes)
      pages++
      bytes += body.bytes
      const parsed = pageSchema.safeParse(JSON.parse(body.text))
      if (!parsed.success) throw new MetadataFailure('invalid-page')
      for (const model of parsed.data.data) {
        ids.add(model.id)
        if (model.id !== binding.wireModelId) continue
        const caps = model.capabilities
        if ((model.family !== undefined && model.family !== binding.family)
          || (model.canonical_model_id !== undefined && model.canonical_model_id !== binding.canonicalModelId)
          || caps?.tools === false || caps?.structured_decisions === false
          || (caps?.efforts !== undefined && !caps.efforts.includes(binding.effort))) {
          throw new MetadataFailure('conflicting-evidence')
        }
        evidence ||= model.family !== undefined || model.canonical_model_id !== undefined || caps !== undefined
      }
      next = continuation(parsed.data, next, binding)
    }
    const receipt: MetadataReceipt = {
      host: hostname(), endpoint: endpoint.href, retrievedAt: new Date().toISOString(), pages, bytes,
      selectedId: binding.wireModelId,
      listingDigest: createHash('sha256').update([...ids].sort().map(id => `${id}\n`).join('')).digest('hex'),
      providerEvidence: evidence ? 'consistent' : 'absent',
    }
    return { kind: ids.has(binding.wireModelId) ? 'present' : 'absent', receipt }
  } catch (error) {
    if (signal?.aborted) return { kind: 'unknown', code: 'cancelled' }
    if (deadline.aborted) return { kind: 'unknown', code: 'timeout' }
    return { kind: 'unknown', code: error instanceof MetadataFailure ? error.code : 'invalid-page' }
  }
}
