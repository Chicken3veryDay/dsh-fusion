/** Deterministic Markdown sectioning, oversized-section splitting, and UTF-8 bounded text helpers. */

/** One heading-delimited part of a source before ids are assigned. */
export interface RawSection {
  /** Enclosing headings, outermost first; empty for text before the first heading. */
  readonly headingPath: readonly string[]
  /** Heading level 1–6, or 0 for text before the first heading. */
  readonly level: number
  /** 0-based count of earlier sections with the same heading path. */
  readonly occurrence: number
  /** 1-based part number. */
  readonly part: number
  readonly partCount: number
  readonly text: string
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const UNTITLED = '(untitled)'

/**
 * Count the UTF-8 bytes of a string.
 * @param text - the string to measure.
 * @returns its encoded byte length.
 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Cut text to at most `maxBytes` UTF-8 bytes without splitting a character.
 * @param text - the text to bound.
 * @param maxBytes - inclusive byte bound, zero or larger.
 * @returns the longest prefix of whole characters within the bound.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  const bytes = Buffer.from(text, 'utf8')
  let end = maxBytes
  // A continuation byte (10xxxxxx) at the cut means the cut is inside a character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xC0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * Shorten heading text for an anchor, marking the cut with `...`.
 * @param heading - heading text.
 * @param maxBytes - inclusive byte bound of the result, at least 4.
 * @returns the heading, or a prefix plus `...`, within the bound.
 */
export function shortenHeading(heading: string, maxBytes: number): string {
  if (byteLength(heading) <= maxBytes) return heading
  return `${truncateUtf8(heading, maxBytes - 3)}...`
}

function lineList(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** Tracks whether a line sits inside a fenced code block, in document order. */
class FenceTracker {
  private close: RegExp | undefined

  /**
   * Advance over one line.
   * @param line - the next line including its newline.
   * @returns true when the line is part of a fenced block (including its fence lines).
   */
  inFence(line: string): boolean {
    if (this.close !== undefined) {
      if (this.close.test(line)) this.close = undefined
      return true
    }
    const marker = FENCE_OPEN.exec(line)?.[1]
    if (marker === undefined) return false
    this.close = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}[ \\t]*\\r?\\n?$`)
    return true
  }
}

function paragraphBlocks(text: string): string[] {
  const blocks: string[] = []
  const tracker = new FenceTracker()
  let current = ''
  let sawBlank = false
  for (const line of lineList(text)) {
    const blank = !tracker.inFence(line) && line.trim().length === 0
    if (!blank && sawBlank) {
      blocks.push(current)
      current = ''
      sawBlank = false
    }
    if (blank) sawBlank = true
    current += line
  }
  if (current.length > 0) blocks.push(current)
  return blocks
}

/**
 * Join consecutive units into parts of at most `maxBytes`; a unit above the bound goes to `split`.
 * @param units - pieces in order that may be joined.
 * @param maxBytes - inclusive byte bound per part.
 * @param split - cuts a unit that alone exceeds the bound.
 * @returns the parts in order.
 */
function pack(units: readonly string[], maxBytes: number, split: (unit: string) => string[]): string[] {
  const parts: string[] = []
  let current = ''
  let currentBytes = 0
  const flush = (): void => {
    if (current.length > 0) parts.push(current)
    current = ''
    currentBytes = 0
  }
  for (const unit of units) {
    const unitBytes = byteLength(unit)
    if (unitBytes > maxBytes) {
      flush()
      parts.push(...split(unit))
      continue
    }
    if (currentBytes + unitBytes > maxBytes) flush()
    current += unit
    currentBytes += unitBytes
  }
  flush()
  return parts
}

function cutCharacters(text: string, maxBytes: number): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > 0) {
    const piece = truncateUtf8(rest, maxBytes)
    parts.push(piece)
    rest = rest.slice(piece.length)
  }
  return parts
}

function splitLongText(text: string, maxBytes: number): string[] {
  return pack(lineList(text), maxBytes, line => cutCharacters(line, maxBytes))
}

/**
 * Split text larger than `maxBytes` into parts at paragraph boundaries. A
 * paragraph that alone exceeds the bound is split at line boundaries, and a
 * line that alone exceeds it at character boundaries. Parts concatenate back to
 * the exact input.
 * @param text - the section text.
 * @param maxBytes - inclusive byte bound per part, at least 4 so one character fits.
 * @returns the parts in order; `[text]` when it already fits.
 */
export function splitOversized(text: string, maxBytes: number): string[] {
  if (byteLength(text) <= maxBytes) return [text]
  return pack(paragraphBlocks(text), maxBytes, block => splitLongText(block, maxBytes))
}

/**
 * Split Markdown into heading-delimited sections and cut oversized sections into parts.
 * Each ATX heading starts a section that runs to the next heading of any level;
 * `headingPath` carries the hierarchy. Headings inside fenced code are text. Text
 * before the first heading becomes a level-0 section unless it is blank.
 * @param text - decoded file text.
 * @param maxSectionBytes - inclusive byte bound per section part.
 * @returns sections in document order.
 */
export function sectionize(text: string, maxSectionBytes: number): RawSection[] {
  const raw: { headingPath: string[]; level: number; text: string }[] = []
  const stack: { level: number; title: string }[] = []
  let current: { headingPath: string[]; level: number; text: string } = { headingPath: [], level: 0, text: '' }
  const tracker = new FenceTracker()
  for (const line of lineList(text)) {
    const match = tracker.inFence(line) ? null : HEADING.exec(line.replace(/\r?\n$/, ''))
    if (match !== null) {
      raw.push(current)
      const level = (match[1] as string).length
      while (stack.length > 0 && (stack.at(-1) as { level: number }).level >= level) stack.pop()
      const title = (match[2] ?? '').trim()
      stack.push({ level, title: title.length === 0 ? UNTITLED : title })
      current = { headingPath: stack.map(entry => entry.title), level, text: '' }
    }
    current.text += line
  }
  raw.push(current)
  const seen = new Map<string, number>()
  const sections: RawSection[] = []
  for (const section of raw) {
    if (section.level === 0 && section.text.trim().length === 0) continue
    const key = section.headingPath.join('\u0000')
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    const parts = splitOversized(section.text, maxSectionBytes)
    parts.forEach((part, index) => {
      sections.push({
        headingPath: section.headingPath,
        level: section.level,
        occurrence,
        part: index + 1,
        partCount: parts.length,
        text: part,
      })
    })
  }
  return sections
}
