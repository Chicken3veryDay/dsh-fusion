import { describe, expect, it } from 'vitest'
import { renderCatalog } from '../src/catalog.ts'
import { byteLength, sectionize, shortenHeading, splitOversized, truncateUtf8 } from '../src/text.ts'
import type { ContextSectionId, ContextSectionMeta, ContextSourceId } from '../src/types.ts'

const DOCS = 'docs'

function meta(overrides: Omit<Partial<ContextSectionMeta>, 'id'> & { id: string; anchor: string }): ContextSectionMeta {
  return {
    sourceId: 'src_0' as ContextSourceId,
    kind: 'doc',
    path: `${DOCS}/a.md`,
    headingPath: [],
    level: 1,
    part: 1,
    partCount: 1,
    bytes: 10,
    hash: 'sha256:0',
    order: 0,
    ...overrides,
    id: overrides.id as ContextSectionId,
  }
}

describe('sectionize', () => {
  it('splits by heading hierarchy and keeps the heading path of nested headings', () => {
    const text = '# Title\nintro\n\n## A\nbody a\n\n### A1\ndeep\n\n## B\nbody b\n'
    const sections = sectionize(text, 8192)
    expect(sections.map(section => section.headingPath)).toEqual([
      ['Title'],
      ['Title', 'A'],
      ['Title', 'A', 'A1'],
      ['Title', 'B'],
    ])
    expect(sections.map(section => section.level)).toEqual([1, 2, 3, 2])
    expect(sections.map(section => section.text).join('')).toBe(text)
  })

  it('keeps text before the first heading as a level-0 section and drops a blank preamble', () => {
    expect(sectionize('rules\n# H\nx\n', 8192).map(s => [s.level, s.headingPath])).toEqual([[0, []], [1, ['H']]])
    expect(sectionize('\n  \n# H\nx\n', 8192).map(s => s.headingPath)).toEqual([['H']])
    expect(sectionize('just text, no headings\n', 8192)).toHaveLength(1)
  })

  it('treats headings inside fenced code as text and ignores non-headings', () => {
    const text = '# A\n```md\n# fake\n```\n#hashtag\n~~~\n## also fake\n~~~\n    # indented code\n'
    const sections = sectionize(text, 8192)
    expect(sections.map(section => section.headingPath)).toEqual([['A']])
    expect(sections[0]?.text).toBe(text)
  })

  it('normalizes closing hashes, empty titles, and CRLF headings', () => {
    const sections = sectionize('## Title ##\r\nx\r\n#\r\ny\r\n', 8192)
    expect(sections.map(section => section.headingPath)).toEqual([['Title'], ['(untitled)']])
  })

  it('counts occurrences of repeated headings so each section stays addressable', () => {
    const sections = sectionize('# Same\na\n# Same\nb\n## Sub\nc\n# Same\nd\n', 8192)
    expect(sections.filter(s => s.headingPath.join('/') === 'Same').map(s => s.occurrence)).toEqual([0, 1, 2])
  })
})

describe('splitOversized', () => {
  it('returns the text unchanged when it fits exactly', () => {
    expect(splitOversized('abcd', 4)).toEqual(['abcd'])
    expect(splitOversized('abcde', 4)).not.toEqual(['abcde'])
  })

  it('packs whole paragraphs and cuts at paragraph boundaries', () => {
    const text = `# H\n\n${'a'.repeat(40)}\n\n${'b'.repeat(40)}\n\n${'c'.repeat(40)}\n`
    const parts = splitOversized(text, 100)
    expect(parts).toHaveLength(2)
    expect(parts.join('')).toBe(text)
    expect(parts[0]?.endsWith(`${'b'.repeat(40)}\n\n`)).toBe(true)
    expect(parts[1]).toBe(`${'c'.repeat(40)}\n`)
    for (const part of parts) expect(byteLength(part)).toBeLessThanOrEqual(100)
  })

  it('does not split a paragraph at blank lines inside a fenced block', () => {
    const fence = `\`\`\`\n${'x'.repeat(30)}\n\n${'y'.repeat(30)}\n\`\`\`\n`
    const text = `${'p'.repeat(60)}\n\n${fence}`
    const parts = splitOversized(text, 120)
    expect(parts.join('')).toBe(text)
    expect(parts.some(part => part.includes('x'.repeat(30)) !== part.includes('y'.repeat(30)))).toBe(false)
  })

  it('falls back to lines for an oversized paragraph and to characters for an oversized line', () => {
    const lines = `${Array.from({ length: 10 }, (_, i) => `line-${i}-${'z'.repeat(24)}`).join('\n')}\n`
    const lineParts = splitOversized(lines, 100)
    expect(lineParts.join('')).toBe(lines)
    for (const part of lineParts) {
      expect(byteLength(part)).toBeLessThanOrEqual(100)
      expect(part.endsWith('\n')).toBe(true)
    }
    const wide = '界'.repeat(100)
    const wideParts = splitOversized(wide, 16)
    expect(wideParts.join('')).toBe(wide)
    for (const part of wideParts) {
      expect(byteLength(part)).toBeLessThanOrEqual(16)
      expect(part).not.toContain('�')
    }
  })

  it('splits sections into numbered parts that keep the heading path', () => {
    const text = `# Big\n\n${'a'.repeat(50)}\n\n${'b'.repeat(50)}\n`
    const sections = sectionize(text, 64)
    expect(sections.map(s => [s.part, s.partCount])).toEqual([[1, 2], [2, 2]])
    expect(new Set(sections.map(s => s.occurrence))).toEqual(new Set([0]))
    expect(sections.every(s => s.headingPath[0] === 'Big')).toBe(true)
  })
})

describe('truncateUtf8 and shortenHeading', () => {
  it('cuts at character boundaries at tiny and exact limits', () => {
    expect(truncateUtf8('héllo', 0)).toBe('')
    expect(truncateUtf8('héllo', 1)).toBe('h')
    expect(truncateUtf8('héllo', 2)).toBe('h')
    expect(truncateUtf8('héllo', 3)).toBe('hé')
    expect(truncateUtf8('héllo', 6)).toBe('héllo')
    expect(truncateUtf8('😀😀', 7)).toBe('😀')
    expect(truncateUtf8('😀😀', 3)).toBe('')
    expect(truncateUtf8('界界', 3)).toBe('界')
  })

  it('marks a shortened heading and keeps it within the bound', () => {
    expect(shortenHeading('short', 16)).toBe('short')
    const shortened = shortenHeading('界'.repeat(40), 16)
    expect(byteLength(shortened)).toBeLessThanOrEqual(16)
    expect(shortened.endsWith('...')).toBe(true)
  })
})

describe('renderCatalog', () => {
  const sections = [
    meta({ id: 'sec_aaaaaaaaaaaaaaaa', anchor: `${DOCS}/a.md#One`, bytes: 12 }),
    meta({ id: 'sec_bbbbbbbbbbbbbbbb', anchor: `${DOCS}/a.md#界 > 文`, bytes: 3456, part: 2, partCount: 3 }),
    meta({ id: 'sec_cccccccccccccccc', anchor: `${DOCS}/a.md#Three`, bytes: 7 }),
  ]
  const full = renderCatalog(sections, 10_000)

  it('lists every section in order with size and anchor', () => {
    expect(full.omitted).toBe(0)
    expect(full.included).toBe(3)
    expect(full.text.split('\n')).toEqual([
      'Context sections (id, size, location):',
      `sec_aaaaaaaaaaaaaaaa 12B ${DOCS}/a.md#One`,
      `sec_bbbbbbbbbbbbbbbb 3456B ${DOCS}/a.md#界 > 文 [part 2/3]`,
      `sec_cccccccccccccccc 7B ${DOCS}/a.md#Three`,
    ])
    expect(full.bytes).toBe(byteLength(full.text))
  })

  it('accepts the exact limit and shrinks with a closing count one byte below it', () => {
    const exact = renderCatalog(sections, full.bytes)
    expect(exact.text).toBe(full.text)
    const below = renderCatalog(sections, full.bytes - 1)
    expect(below.omitted).toBeGreaterThan(0)
    expect(below.bytes).toBeLessThanOrEqual(full.bytes - 1)
    expect(below.text.endsWith(`(${below.omitted} more sections not listed)`)).toBe(true)
    expect(below.included + below.omitted).toBe(3)
  })

  it('never exceeds the bound at any limit, including multibyte lines', () => {
    for (let limit = 1; limit <= full.bytes + 2; limit++) {
      const catalog = renderCatalog(sections, limit)
      expect(catalog.bytes).toBeLessThanOrEqual(limit)
      expect(byteLength(catalog.text)).toBe(catalog.bytes)
      expect(catalog.included + catalog.omitted).toBe(3)
      expect(catalog.text).not.toContain('�')
    }
  })

  it('returns empty text when not even the header and closing count fit, and for no sections', () => {
    const tiny = renderCatalog(sections, 10)
    expect(tiny).toMatchObject({ text: '', bytes: 0, included: 0, omitted: 3 })
    expect(renderCatalog([], 100)).toMatchObject({ text: '', included: 0, omitted: 0 })
  })
})
