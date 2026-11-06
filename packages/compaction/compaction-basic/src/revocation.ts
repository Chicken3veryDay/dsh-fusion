/**
 * Revocable-source selection and stub rendering for one compaction span.
 *
 * @module @deepseek-ai/dsh-compaction-basic/revocation
 */

import type { RevocableSourceStub } from '@deepseek-ai/dsh-compaction'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'

/** Default byte bound for all stubs one checkpoint carries. */
export const DEFAULT_REVOCATION_STUB_BYTES = 2048

const STUB_HEADER = 'Revoked context (reload if needed):'
const ELLIPSIS = '…'
/** Smallest truncated stub text worth emitting when one oversized stub must fit alone. */
const MIN_TRUNCATED_STUB_BYTES = 16

/** Revoked messages found in one compacted span. */
export interface RevocationPlan {
  /** Surface seqs whose messages are omitted from the summarizer input. */
  readonly revokedSeqs: ReadonlySet<SessionSeq>
  /** Stubs of the revoked messages, deduplicated by kind and key in span order. */
  readonly stubs: readonly RevocableSourceStub[]
}

/**
 * Find the revocable user messages in a compacted span.
 * @param session - session supplying the logged messages.
 * @param shadowedSeqs - surface-node seqs of the span, in surface order.
 * @param stubFor - registry lookup returning the stub of a revocable source.
 * @returns the omitted seqs and the deduplicated stubs.
 */
export function planRevocation(
  session: Session,
  shadowedSeqs: readonly SessionSeq[],
  stubFor: (source: MessageSource) => RevocableSourceStub | undefined,
): RevocationPlan {
  const revokedSeqs = new Set<SessionSeq>()
  const stubs: RevocableSourceStub[] = []
  const seen = new Set<string>()
  for (const seq of shadowedSeqs) {
    // shadowedSeqs are current surface seqs, so each is a valid log index.
    // Existing Session history read; migration deferred.
    // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message?.role !== 'user') continue
    const stub = stubFor(message.source)
    if (stub === undefined) continue
    revokedSeqs.add(seq)
    const identity = `${message.source.kind}\u0000${stub.key}`
    if (seen.has(identity)) continue
    seen.add(identity)
    stubs.push(stub)
  }
  return { revokedSeqs, stubs }
}

/**
 * Render the stubs as one text block no longer than `maxBytes` UTF-8 bytes,
 * including the header and the count of stubs that did not fit. A first stub
 * larger than the limit is truncated; later stubs are counted, not truncated.
 * @param stubs - deduplicated stubs in span order.
 * @param maxBytes - hard bound on the complete block.
 * @returns the block text, or `undefined` when there is nothing to emit or not even a header and one line fit.
 */
export function renderStubBlock(
  stubs: readonly RevocableSourceStub[],
  maxBytes: number,
): string | undefined {
  if (stubs.length === 0 || maxBytes <= 0) return undefined
  const lines = stubs.map(stub => stub.text.replace(/\s+/g, ' ').trim())
  let block = STUB_HEADER
  let included = 0
  for (const [index, line] of lines.entries()) {
    const remaining = lines.length - index - 1
    const tail = remaining > 0 ? overflowLine(remaining) : ''
    const candidate = `${block}\n- ${line}`
    if (byteLength(candidate + tail) <= maxBytes) {
      block = candidate
      included += 1
      continue
    }
    if (included === 0) {
      const room = maxBytes - byteLength(`${block}\n- ${ELLIPSIS}${tail}`)
      if (room >= MIN_TRUNCATED_STUB_BYTES) {
        block = `${block}\n- ${truncateBytes(line, room)}${ELLIPSIS}`
        included += 1
      }
    }
    const rest = lines.length - included
    const result = rest > 0 ? `${block}${overflowLine(rest)}` : block
    return byteLength(result) <= maxBytes ? result : undefined
  }
  return block
}

function overflowLine(count: number): string {
  return `\n- ${ELLIPSIS} ${count} more revoked (stub budget reached)`
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** Longest prefix of whole code points within `maxBytes` UTF-8 bytes. */
function truncateBytes(text: string, maxBytes: number): string {
  let used = 0
  let end = 0
  for (const point of text) {
    const size = byteLength(point)
    if (used + size > maxBytes) break
    used += size
    end += point.length
  }
  return text.slice(0, end)
}
