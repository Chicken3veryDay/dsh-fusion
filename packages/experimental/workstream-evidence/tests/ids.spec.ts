import { expect, it } from 'vitest'
import { WorkstreamEvidenceArtifactId, WorkstreamEvidenceOperationId } from '../src/ids.ts'

it('normalizes logical artifact and operation ids and enforces their length limits', () => {
  for (const parse of [WorkstreamEvidenceArtifactId, WorkstreamEvidenceOperationId]) {
    expect(parse(' opaque ')).toBe('opaque')
    expect(parse('x'.repeat(200))).toHaveLength(200)
    for (const value of ['', '  ', 'x'.repeat(201)]) expect(() => parse(value)).toThrow('must contain 1–200 characters')
  }
})

it('refuses artifact path separators and traversal', () => {
  for (const value of ['a/b', 'a\\b', 'a..b']) {
    expect(() => WorkstreamEvidenceArtifactId(value)).toThrow('must not contain path separators or traversal')
  }
})
