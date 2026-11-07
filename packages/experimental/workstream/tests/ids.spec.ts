import { expect, it } from 'vitest'
import { WorkstreamOperationId } from '../src/ids.ts'

it('preserves opaque operation ids and rejects empty or oversized keys', () => {
  expect(WorkstreamOperationId(' opaque ')).toBe(' opaque ')
  expect(WorkstreamOperationId('x'.repeat(200))).toHaveLength(200)
  for (const value of ['', '  ', 'x'.repeat(201)]) {
    expect(() => WorkstreamOperationId(value)).toThrow('must contain 1–200 characters')
  }
})
