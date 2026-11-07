/** Provider-owned operation plans: explicit targeting, rejection before any call, and catalog-derived methods. */
import { describe, expect, it } from 'vitest'
import type { BrowserOperation } from '@deepseek-ai/dsh-interaction'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { chromeDevtoolsOperations, playwrightOperations } from '../src/mcp-operations.ts'

const LISTING_TEXT: JsonValue = { value: { content: [{ type: 'text', text: '## Pages\n1: about:blank\n4: https://a.invalid/ [selected]' }] } }
const LISTING_STRUCTURED: JsonValue = {
  value: { content: [], structuredContent: { pages: [{ id: 1, selected: false }, { id: 6, selected: true }] } },
}

describe('Chrome DevTools plan', () => {
  it('uses the explicit page id without reading the page list', () => {
    const calls = chromeDevtoolsOperations.plan({ domain: 'browser', method: 'navigate', tabId: '3', url: 'https://a.invalid/' })
    expect(calls.map(call => [call.tools, call.args([])])).toEqual([[['navigate_page'], { pageId: 3, type: 'url', url: 'https://a.invalid/' }]])
  })

  it.each([[LISTING_TEXT, 4], [LISTING_STRUCTURED, 6]])('targets the selected page reported by list_pages when no tab is requested', (listing, pageId) => {
    const calls = chromeDevtoolsOperations.plan({ domain: 'browser', method: 'observe' })
    expect(calls.map(call => call.tools)).toEqual([['list_pages'], ['take_snapshot']])
    expect(calls[1]!.args([listing])).toEqual({ pageId })
  })

  it('fails the second call when list_pages reports no selected page', () => {
    const calls = chromeDevtoolsOperations.plan({ domain: 'browser', method: 'screenshot' })
    expect(() => calls[1]!.args([{ value: { content: [{ type: 'text', text: '## Pages\n1: about:blank' }] } }])).toThrow('no selected page')
  })

  it('maps tab operations to page ids', () => {
    const args = (operation: BrowserOperation) => chromeDevtoolsOperations.plan(operation).map(call => [call.tools, call.args([])])
    expect(args({ domain: 'browser', method: 'tabs', operation: 'list' })).toEqual([[['list_pages'], {}]])
    expect(args({ domain: 'browser', method: 'tabs', operation: 'new', url: 'https://a.invalid/' })).toEqual([[['new_page'], { url: 'https://a.invalid/' }]])
    expect(args({ domain: 'browser', method: 'tabs', operation: 'select', tabId: '2' })).toEqual([[['select_page'], { pageId: 2, bringToFront: true }]])
    expect(args({ domain: 'browser', method: 'tabs', operation: 'close', tabId: '2' })).toEqual([[['close_page'], { pageId: 2 }]])
  })

  it.each([
    [{ domain: 'browser', method: 'tabs', operation: 'list', tabId: '1' } as const, 'does not accept a tabId'],
    [{ domain: 'browser', method: 'tabs', operation: 'select' } as const, 'requires a tabId'],
    [{ domain: 'browser', method: 'navigate', tabId: 'x', url: 'https://a.invalid/' } as const, 'non-negative integer'],
    [{ domain: 'browser', method: 'act', action: { kind: 'scroll' } } as const, 'not supported by chrome-devtools-mcp'],
    [{ domain: 'browser', method: 'act', action: { kind: 'click' } } as const, 'requires "uid"'],
    [{ domain: 'browser', method: 'act', action: { kind: 'click', uid: '1_1', ref: 'x' } } as const, 'does not accept "ref"'],
    [{ domain: 'browser', method: 'act', action: { kind: 'click', uid: 1 } } as const, 'must be a string'],
    [{ domain: 'browser', method: 'act', action: { kind: 'bogus' } } as const, 'not supported by the normalized facade'],
    [{ domain: 'browser', method: 'extract', instruction: 'x' } as const, 'does not support normalized extract'],
  ] satisfies Array<[BrowserOperation, string]>)('rejects %j before any call', (operation, message) => {
    expect(() => chromeDevtoolsOperations.plan(operation)).toThrow(message)
  })

  it('maps typing and waiting onto the tools that accept their fields', () => {
    const plan = (action: JsonValue) => chromeDevtoolsOperations.plan({ domain: 'browser', method: 'act', tabId: '1', action }).map(call => [call.tools, call.args([])])
    expect(plan({ kind: 'type', uid: '1_2', text: 'hi' })).toEqual([[['fill'], { pageId: 1, uid: '1_2', value: 'hi' }]])
    expect(plan({ kind: 'type', text: 'hi' })).toEqual([[['type_text'], { pageId: 1, text: 'hi' }]])
    expect(plan({ kind: 'wait_for', text: 'Done' })).toEqual([[['wait_for'], { pageId: 1, text: ['Done'] }]])
    expect(plan({ kind: 'navigate_back' })).toEqual([[['navigate_page'], { pageId: 1, type: 'back' }]])
  })

  it.each<[string, JsonValue | undefined]>([
    ['no result', undefined],
    ['a non-object result', null],
    ['a result without content', { value: {} }],
    ['content without text', { value: { content: [null, { type: 'image' }] } }],
    ['structured pages without a selection', { value: { structuredContent: { pages: [{ id: 1, selected: false }] }, content: [] } }],
  ])('reports no selected page for %s', (_label, listing) => {
    const calls = chromeDevtoolsOperations.plan({ domain: 'browser', method: 'observe' })
    expect(() => calls[1]!.args(listing === undefined ? [] : [listing])).toThrow('no selected page')
  })

  it('opens a blank page when none is named and omits optional fields', () => {
    expect(chromeDevtoolsOperations.plan({ domain: 'browser', method: 'tabs', operation: 'new' }).map(call => call.args([]))).toEqual([{ url: 'about:blank' }])
    expect(chromeDevtoolsOperations.plan({ domain: 'browser', method: 'act', action: { kind: 'wait_for', text: 'a', timeout: 5 } }).map(call => call.tools)).toEqual([['list_pages'], ['wait_for']])
  })

  it('lists only the methods whose complete tool set the catalog exposes', () => {
    expect(chromeDevtoolsOperations.methods(raw => ['list_pages', 'take_snapshot'].includes(raw))).toEqual(['observe'])
    expect(chromeDevtoolsOperations.methods(() => false)).toEqual([])
    expect(chromeDevtoolsOperations.methods(raw => ['list_pages', 'navigate_page'].includes(raw))).toEqual(['navigate', 'act'])
    expect(chromeDevtoolsOperations.methods(raw => raw === 'browser_navigate')).toEqual([])
    expect(chromeDevtoolsOperations.methods(raw => raw === 'click')).toEqual([])
    expect(chromeDevtoolsOperations.methods(raw => ['list_pages', 'new_page', 'select_page', 'close_page', 'take_screenshot', 'click'].includes(raw))).toEqual(['tabs', 'act', 'screenshot'])
  })
})

describe('Playwright plan', () => {
  it('lists methods from the catalog', () => {
    expect(playwrightOperations.methods(raw => ['browser_navigate', 'browser_take_screenshot'].includes(raw))).toEqual(['navigate', 'screenshot'])
    expect(playwrightOperations.methods(raw => raw === 'browser_click')).toEqual(['act'])
    expect(playwrightOperations.methods(raw => raw === 'list_pages')).toEqual([])
  })
  it('rejects extraction and malformed actions before any call', () => {
    expect(() => playwrightOperations.plan({ domain: 'browser', method: 'extract', instruction: 'x' })).toThrow('does not support normalized extract')
    expect(() => playwrightOperations.plan({ domain: 'browser', method: 'act', action: 'click' })).toThrow('must be an object with kind')
    expect(() => playwrightOperations.plan({ domain: 'browser', method: 'act', action: { kind: '' } })).toThrow('non-empty string')
  })
  it('plans tab operations and optional fields without a target', () => {
    const args = (operation: BrowserOperation) => playwrightOperations.plan(operation).map(call => [call.tools, call.args([])])
    expect(args({ domain: 'browser', method: 'tabs', operation: 'list' })).toEqual([[['browser_tabs', 'browser_tab_list'], { action: 'list' }]])
    expect(args({ domain: 'browser', method: 'tabs', operation: 'new', url: 'https://a.invalid/' })).toEqual([[['browser_tabs', 'browser_tab_list'], { action: 'new', url: 'https://a.invalid/' }]])
    expect(args({ domain: 'browser', method: 'tabs', operation: 'close', tabId: '2' })).toEqual([[['browser_tabs', 'browser_tab_list'], { action: 'close', index: 2 }]])
    expect(args({ domain: 'browser', method: 'observe', instruction: 'e1' })).toEqual([[['browser_snapshot', 'browser_observe'], { target: 'e1' }]])
  })
})
