/** Exhaustive small-budget controls over complete revocation stub output. */
import { expect, it } from 'vitest'
import { renderStubBlock } from '../src/revocation.ts'

it('bounds complete stub output for every small byte budget and multibyte truncation position', () => {
  for (const text of ['', 'short', '界😀é'.repeat(80)]) {
    for (const count of [1, 2, 11]) {
      const stubs = Array.from({ length: count }, (_, index) => ({ key: String(index), text }))
      for (let budget = 0; budget <= 512; budget++) {
        const output = renderStubBlock(stubs, budget)
        if (output === undefined) continue
        expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(budget)
        expect(output).not.toContain('�')
      }
    }
  }
})
