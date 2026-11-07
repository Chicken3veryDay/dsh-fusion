/** A closed driver schema admits only its own declared properties, never names inherited from Object.prototype. */
import { describe, expect, it } from 'vitest'
import { planDesktopOperation, type DesktopCatalog } from '../src/index.ts'

// Parsed like a listed catalog, so `properties` is an ordinary object with Object.prototype.
const click = JSON.parse('{"type":"object","additionalProperties":false,"properties":{"pid":{"type":"integer"},"window_id":{"type":"integer"},"x":{"type":"number"},"y":{"type":"number"}}}') as Record<string, unknown>
const catalog: DesktopCatalog = { schema: tool => tool === 'click' ? click : undefined }

describe('closed-schema argument check', () => {
  it('control: rejects an ordinary undeclared argument', () => {
    expect(() => planDesktopOperation(catalog, { domain: 'desktop', method: 'act', applicationId: '9', windowId: '7', action: { kind: 'click', button: 'left' } }))
      .toThrow('does not accept "button"')
  })

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('rejects the undeclared argument "%s"', (key) => {
    // Model arguments arrive as parsed JSON, which keeps "__proto__" as an own data property.
    const action = JSON.parse(`{"kind":"click","x":3,"${key}":1}`) as Record<string, number | string>
    expect(() => planDesktopOperation(catalog, { domain: 'desktop', method: 'act', applicationId: '9', windowId: '7', action }))
      .toThrow(`does not accept "${key}"`)
  })
})
