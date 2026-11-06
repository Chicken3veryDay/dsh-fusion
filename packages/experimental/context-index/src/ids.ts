/** Runtime constructors and derivations for context index identifiers and digests. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ContextIndexError } from './error.ts'
import type { ContextSectionId, ContextSourceId, ContextSourceKind } from './types.ts'

const SECTION_ID_PATTERN = /^sec_[0-9a-f]{16}$/

function shortDigest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

/**
 * Compute the `sha256:` digest used for source and section content hashes.
 * @param data - exact text or bytes to hash.
 * @returns the digest string.
 */
export function contentHash(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/**
 * Derive a source id from its kind and display path, so edits to the file keep the id.
 * @param kind - where the source comes from.
 * @param path - the source's display path.
 * @returns the branded source id.
 */
export function deriveSourceId(kind: ContextSourceKind, path: string): ContextSourceId {
  return brandString<ContextSourceId>(`src_${shortDigest([kind, path])}`)
}

/**
 * Derive a section id from source identity and heading path, never from content.
 * @param sourceId - owning source.
 * @param headingPath - enclosing headings, outermost first.
 * @param occurrence - 0-based count of earlier sections in the source with the same heading path.
 * @param part - 1-based part number of a split section; 1 for an unsplit section.
 * @returns the branded section id.
 */
export function deriveSectionId(
  sourceId: ContextSourceId,
  headingPath: readonly string[],
  occurrence: number,
  part: number,
): ContextSectionId {
  return brandString<ContextSectionId>(`sec_${shortDigest([sourceId, String(occurrence), String(part), ...headingPath])}`)
}

/**
 * Validate and brand a section id received from a caller.
 * @param value - candidate id text.
 * @returns the branded section id.
 * @throws {@link ContextIndexError} `CONTEXT_INDEX_INVALID_INPUT` when `value` is not a section id.
 */
export function ContextSectionIdOf(value: string): ContextSectionId {
  if (!SECTION_ID_PATTERN.test(value)) {
    throw new ContextIndexError(`"${value}" is not a context section id`, 'CONTEXT_INDEX_INVALID_INPUT')
  }
  return brandString<ContextSectionId>(value)
}
