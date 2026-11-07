/** Compact JSON rendering for tools without a narrower result schema. */
import { describe, expect, it } from 'vitest'
import { jsonToolOutput } from '../src/index.ts'

describe('JSON tool output', () => {
  it('renders the complete JSON value as one compact text block', () => {
    const output = jsonToolOutput()
    expect(output.schema).toEqual({ type: 'json' })
    expect(output.render({}, { text: '引号 "', rows: [null, true, 3] }))
      .toEqual([{ type: 'text', text: '{"text":"引号 \\\"","rows":[null,true,3]}' }])
  })
})
