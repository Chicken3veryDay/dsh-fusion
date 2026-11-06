/** Compact, byte-bounded catalog rendering of section metadata. */
import { byteLength } from './text.ts'
import type { ContextCatalog, ContextSectionMeta } from './types.ts'

const HEADER = 'Context sections (id, size, location):'

function line(section: ContextSectionMeta): string {
  const part = section.partCount > 1 ? ` [part ${section.part}/${section.partCount}]` : ''
  return `${section.id} ${section.bytes}B ${section.anchor}${part}`
}

function footer(omitted: number): string {
  return `(${omitted} more sections not listed)`
}

/**
 * Render a bounded listing of sections in the given order.
 *
 * The bound applies to the complete text: header, every listed line, newlines, and
 * the closing count of unlisted sections. Lines are whole; the listing stops at
 * the first line that would not fit together with the closing count. When not even
 * the header and closing count fit, the text is empty.
 * @param sections - sections to list, in listing order.
 * @param maxBytes - inclusive UTF-8 byte bound of the text.
 * @returns the text with its size and how many sections were listed or omitted.
 */
export function renderCatalog(sections: readonly ContextSectionMeta[], maxBytes: number): ContextCatalog {
  const empty = (omitted: number): ContextCatalog => ({ text: '', bytes: 0, included: 0, omitted, maxBytes })
  if (sections.length === 0) return empty(0)
  if (byteLength(HEADER) + 1 + byteLength(footer(sections.length)) > maxBytes) return empty(sections.length)
  const lines = [HEADER]
  let used = byteLength(HEADER)
  for (const [index, section] of sections.entries()) {
    const text = line(section)
    const next = used + 1 + byteLength(text)
    const remaining = sections.length - index - 1
    const closing = remaining > 0 ? 1 + byteLength(footer(remaining)) : 0
    if (next + closing > maxBytes) break
    lines.push(text)
    used = next
  }
  const included = lines.length - 1
  const omitted = sections.length - included
  if (omitted > 0) {
    lines.push(footer(omitted))
  }
  const text = lines.join('\n')
  return { text, bytes: byteLength(text), included, omitted, maxBytes }
}
