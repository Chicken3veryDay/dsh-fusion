/** Normalized desktop operations map onto a driver catalog by exact tool name and declared input. */
import { describe, expect, it } from 'vitest'
import { desktopActionKinds, desktopMethods, planDesktopOperation, type DesktopCatalog } from '../src/index.ts'

const window = { pid: { type: 'integer' }, window_id: { type: 'integer' } }
const closedObject = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })

/** The order matters: `browser_type` precedes `type_text`, as a substring match would pick it. */
const schemas: Record<string, Record<string, unknown>> = {
  get_window_state: closedObject({ ...window, include_screenshot: {}, include_accessibility_tree: {} }, ['pid', 'window_id']),
  get_desktop_state: closedObject({ session: {} }),
  browser_type: closedObject({ tab_id: {}, text: {} }, ['tab_id', 'text']),
  click: closedObject({ ...window, x: {}, y: {} }),
  type_text: closedObject({ ...window, text: {} }, ['text']),
  press_key: closedObject({ ...window, key: {} }, ['key']),
  scroll: closedObject({ ...window, direction: {} }, ['direction']),
  drag: closedObject({ ...window, from_x: {}, from_y: {}, to_x: {}, to_y: {} }),
  hotkey: closedObject({ ...window, keys: {} }, ['keys']),
  set_value: closedObject({ ...window, value: {} }),
}
const catalog = (without: readonly string[] = []): DesktopCatalog => ({
  schema: tool => without.includes(tool) ? undefined : schemas[tool],
})

describe('desktop catalog mapping', () => {
  it('maps every normalized action kind to one exact driver tool', () => {
    const expected = { click: 'click', type: 'type_text', press_key: 'press_key', scroll: 'scroll', drag: 'drag', hotkey: 'hotkey', set_value: 'set_value' }
    expect(Object.fromEntries(desktopActionKinds(catalog()).map(kind => [
      kind,
      planDesktopOperation(catalog(), { domain: 'desktop', method: 'act', action: { kind } }).tool,
    ]))).toEqual(expected)
  })

  it.each(['select', 'perform_action', 'type_text', 'browser_type', 'ty', 'toString', ''])('rejects action kind %j before any call', (kind) => {
    expect(() => planDesktopOperation(catalog(), { domain: 'desktop', method: 'act', action: { kind } })).toThrow(/not supported; supported kinds: click, type,/u)
  })

  it('rejects a kind whose exact tool is missing instead of a similarly named one', () => {
    const live = catalog(['type_text'])
    expect(desktopActionKinds(live)).not.toContain('type')
    expect(() => planDesktopOperation(live, { domain: 'desktop', method: 'act', action: { kind: 'type', text: 'hi' } })).toThrow('not supported')
  })

  it('advertises only the methods the live catalog executes', () => {
    expect(desktopMethods(catalog())).toEqual(['observe', 'screenshot', 'act'])
    expect(desktopMethods(catalog(['get_window_state', 'get_desktop_state']))).toEqual(['act'])
    const actionTools = ['click', 'type_text', 'press_key', 'scroll', 'drag', 'hotkey', 'set_value']
    expect(desktopMethods(catalog(actionTools))).toEqual(['observe', 'screenshot'])
  })

  it('converts targets to the driver\'s integer ids and puts them beside the action fields', () => {
    expect(planDesktopOperation(catalog(), { domain: 'desktop', method: 'act', applicationId: '4242', windowId: '7', action: { kind: 'type', text: 'hi' } }))
      .toEqual({ tool: 'type_text', args: { pid: 4242, window_id: 7, text: 'hi' } })
    expect(planDesktopOperation(catalog(), { domain: 'desktop', method: 'observe', applicationId: '4242', windowId: '7' }))
      .toEqual({ tool: 'get_window_state', args: { pid: 4242, window_id: 7 } })
    expect(planDesktopOperation(catalog(), { domain: 'desktop', method: 'screenshot', applicationId: '4242', windowId: '7' }))
      .toEqual({ tool: 'get_window_state', args: { pid: 4242, window_id: 7, include_screenshot: true, include_accessibility_tree: false } })
  })

  it('observes the whole display without ids and rejects a half target', () => {
    expect(planDesktopOperation(catalog(), { domain: 'desktop', method: 'observe' })).toEqual({ tool: 'get_desktop_state', args: {} })
    expect(() => planDesktopOperation(catalog(), { domain: 'desktop', method: 'observe', windowId: '7' })).toThrow('needs both applicationId and windowId')
    expect(() => planDesktopOperation(catalog(['get_desktop_state']), { domain: 'desktop', method: 'screenshot' })).toThrow('no whole-display observation')
  })

  it.each(['abc', '', '0', '-3', '1.5', '1e3', '99999999999999999999'])('rejects malformed id %j before any call', (id) => {
    expect(() => planDesktopOperation(catalog(), { domain: 'desktop', method: 'observe', applicationId: id, windowId: '7' })).toThrow('positive integer')
    expect(() => planDesktopOperation(catalog(), { domain: 'desktop', method: 'act', windowId: id, action: { kind: 'click' } })).toThrow('positive integer')
  })

  it('rejects a repeated target field and an argument the tool does not declare', () => {
    expect(() => planDesktopOperation(catalog(), { domain: 'desktop', method: 'act', applicationId: '4242', action: { kind: 'click', pid: 1 } })).toThrow('must not repeat "pid"')
    expect(() => planDesktopOperation(catalog(), { domain: 'desktop', method: 'act', action: { kind: 'click', application_id: 'x' } })).toThrow('does not accept "application_id"')
    expect(() => planDesktopOperation(catalog(), { domain: 'desktop', method: 'act', action: 'click' })).toThrow('object action')
    expect(() => planDesktopOperation(catalog(), { domain: 'desktop', method: 'act', action: { kind: 3 } })).toThrow('kind must be a string')
  })
})
