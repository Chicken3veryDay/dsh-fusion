/** Provider-owned mappings from normalized browser operations to one MCP server's raw tools. @module */

import type { BrowserActionKind, BrowserOperation } from '@deepseek-ai/dsh-interaction'
import { BROWSER_ACTION_KINDS, isBrowserActionKind } from '@deepseek-ai/dsh-interaction'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Normalized browser methods an MCP mapping can supply. */
export type BrowserMcpMethod = 'navigate' | 'tabs' | 'observe' | 'act' | 'screenshot'

/** One raw provider call of a planned operation. */
export interface BrowserMcpCall {
  /** Raw tool names in preference order; the first one the live catalog exposes runs. */
  readonly tools: readonly string[]
  /**
   * Build the call's arguments immediately before it runs.
   * @param earlier - settled raw results of this operation's preceding calls, oldest first.
   * @returns the raw tool arguments.
   * @throws when an earlier result cannot supply them; later calls then never run.
   */
  args(earlier: readonly JsonValue[]): Record<string, JsonValue>
}

/** How one MCP server's catalog executes the normalized browser operations. */
export interface BrowserMcpOperations {
  /**
   * List the normalized methods the catalog can execute completely.
   * @param has - whether the live catalog exposes a raw tool.
   * @returns the methods whose every required raw tool is present.
   */
  methods(has: (tool: string) => boolean): readonly BrowserMcpMethod[]
  /**
   * Translate one operation, including its explicit tab, into ordered raw calls.
   * Every call is read-only or targets the requested tab; the whole plan runs in one
   * serialized resource operation and stops at the first failed call.
   * @param operation - normalized browser operation.
   * @returns the raw calls to run in order.
   * @throws before any call runs when the operation or its targeting is unsupported or malformed.
   */
  plan(operation: BrowserOperation): readonly BrowserMcpCall[]
}

type JsonObject = Record<string, JsonValue>

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fixed(tools: readonly string[], args: JsonObject = {}): BrowserMcpCall {
  return { tools, args: () => args }
}

/** Parse a provider tab id that is a non-negative integer, or reject it before any call. */
function tabNumber(tabId: string, label: string): number {
  const value = Number(tabId)
  if (tabId.trim() === '' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} tabId must be a non-negative integer for this provider`)
  }
  return value
}

type FieldType = 'string' | 'boolean' | 'number' | 'strings'
type FieldSpec = Readonly<Record<string, readonly [type: FieldType, required: boolean]>>

function matchesType(value: JsonValue, type: FieldType): boolean {
  if (type === 'strings') return Array.isArray(value) && value.every(item => typeof item === 'string')
  return typeof value === type
}

/**
 * Pick one action's declared fields; an undeclared or mistyped field is rejected, never dropped.
 * @param action - normalized action fields without `kind`.
 * @param kind - action kind named in diagnostics.
 * @param spec - field names mapped to their type and whether they are required.
 * @returns the validated provider arguments.
 */
function pickFields(action: JsonObject, kind: string, spec: FieldSpec): JsonObject {
  const picked: JsonObject = {}
  for (const [name, value] of Object.entries(action)) {
    const field = spec[name]
    if (field === undefined) throw new Error(`browser_act ${kind} does not accept "${name}" for this provider`)
    if (!matchesType(value, field[0])) throw new Error(`browser_act ${kind} "${name}" must be a ${field[0]}`)
    picked[name] = value
  }
  for (const [name, field] of Object.entries(spec)) {
    if (field[1] && picked[name] === undefined) throw new Error(`browser_act ${kind} requires "${name}"`)
  }
  return picked
}

/** Split a normalized action into its validated kind and remaining fields. */
function actionOf(operation: Extract<BrowserOperation, { method: 'act' }>): { kind: BrowserActionKind; fields: JsonObject } {
  if (!isJsonObject(operation.action)) throw new Error('browser_act action must be an object with kind')
  const { kind, ...fields } = operation.action
  if (typeof kind !== 'string' || kind.length === 0) throw new Error('browser_act action.kind must be a non-empty string')
  if (!isBrowserActionKind(kind)) throw new Error(`browser_act action.kind "${kind}" is not supported by the normalized facade`)
  return { kind, fields }
}

const PLAYWRIGHT_TABS = ['browser_tabs', 'browser_tab_list'] as const

/** Select the requested tab before a current-tab call; Playwright MCP has no per-call tab argument. */
function playwrightTarget(tabId: string | undefined): BrowserMcpCall[] {
  return tabId === undefined ? [] : [fixed(PLAYWRIGHT_TABS, { action: 'select', index: tabNumber(tabId, 'browser_tabs') })]
}

/**
 * Playwright MCP: current-tab tools preceded by a tab selection when `tabId` is explicit.
 * Tab ids are the zero-based indexes of its `browser_tabs` list. Fixture servers that follow
 * its tool names use this mapping when a provider names none.
 */
export const playwrightOperations: BrowserMcpOperations = {
  methods(has) {
    const anyOf = (...tools: string[]): boolean => tools.some(has)
    const methods: BrowserMcpMethod[] = []
    if (has('browser_navigate')) methods.push('navigate')
    if (anyOf(...PLAYWRIGHT_TABS)) methods.push('tabs')
    if (anyOf('browser_snapshot', 'browser_observe')) methods.push('observe')
    if (BROWSER_ACTION_KINDS.some(kind => anyOf(`browser_${kind}`, kind))) methods.push('act')
    if (anyOf('browser_take_screenshot', 'browser_screenshot')) methods.push('screenshot')
    return methods
  },
  plan(operation) {
    if (operation.method === 'navigate') return [...playwrightTarget(operation.tabId), fixed(['browser_navigate'], { url: operation.url })]
    if (operation.method === 'observe') {
      return [...playwrightTarget(operation.tabId), fixed(['browser_snapshot', 'browser_observe'], operation.instruction === undefined ? {} : { target: operation.instruction })]
    }
    if (operation.method === 'screenshot') return [...playwrightTarget(operation.tabId), fixed(['browser_take_screenshot', 'browser_screenshot'])]
    if (operation.method === 'tabs') {
      if (operation.tabId !== undefined && (operation.operation === 'list' || operation.operation === 'new')) {
        throw new Error(`browser_tabs ${operation.operation} does not accept a tabId`)
      }
      if (operation.operation === 'select' && operation.tabId === undefined) throw new Error('browser_tabs select requires a tabId')
      return [fixed(PLAYWRIGHT_TABS, {
        action: operation.operation,
        ...operation.tabId === undefined ? {} : { index: tabNumber(operation.tabId, 'browser_tabs') },
        ...operation.url === undefined ? {} : { url: operation.url },
      })]
    }
    if (operation.method === 'act') {
      const { kind, fields } = actionOf(operation)
      return [...playwrightTarget(operation.tabId), fixed([`browser_${kind}`, kind], fields)]
    }
    throw new Error(`browser provider does not support normalized ${operation.method} yet`)
  },
}

const DEVTOOLS_LIST = ['list_pages'] as const

/** Read the selected page id from a settled `list_pages` result, structured first, then its text lines. */
function selectedPageId(listing: JsonValue | undefined): number {
  const value = isJsonObject(listing) ? listing.value : undefined
  const structured = isJsonObject(value) ? value.structuredContent : undefined
  const pages = isJsonObject(structured) ? structured.pages : undefined
  const selected = Array.isArray(pages) ? pages.find(page => isJsonObject(page) && page.selected === true) : undefined
  if (isJsonObject(selected) && typeof selected.id === 'number') return selected.id
  const blocks = isJsonObject(value) && Array.isArray(value.content) ? value.content : []
  for (const block of blocks) {
    const match = isJsonObject(block) && typeof block.text === 'string' ? /^(\d+): .*\[selected\]/mu.exec(block.text) : null
    if (match?.[1] !== undefined) return Number(match[1])
  }
  throw new Error('chrome-devtools-mcp list_pages reported no selected page')
}

/**
 * Run a page-scoped DevTools tool against an explicit page id; without a tab the selected
 * page is read first, because the pinned server requires a `pageId` on every page tool.
 */
function devtoolsPage(tabId: string | undefined, tools: readonly string[], args: JsonObject = {}): BrowserMcpCall[] {
  if (tabId !== undefined) return [fixed(tools, { pageId: tabNumber(tabId, 'chrome-devtools-mcp'), ...args })]
  return [fixed(DEVTOOLS_LIST), { tools, args: earlier => ({ pageId: selectedPageId(earlier[0]), ...args }) }]
}

/** Copy `fields` with one key renamed. */
function renameField(fields: JsonObject, from: string, to: string): JsonObject {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key === from ? to : key, value]))
}

const TEXT = ['string', true] as const
interface DevtoolsAction {
  readonly tools: readonly string[]
  readonly spec: FieldSpec
  /** Rewrite the validated fields onto another tool or argument layout. */
  readonly map?: (fields: JsonObject) => { tools?: readonly string[]; args: JsonObject }
}

const DEVTOOLS_ACTIONS: Readonly<Record<string, DevtoolsAction>> = {
  click: { tools: ['click'], spec: { uid: TEXT, dblClick: ['boolean', false] } },
  hover: { tools: ['hover'], spec: { uid: TEXT } },
  press_key: { tools: ['press_key'], spec: { key: TEXT } },
  drag: { tools: ['drag'], spec: { from_uid: TEXT, to_uid: TEXT } },
  navigate_back: { tools: ['navigate_page'], spec: {}, map: () => ({ args: { type: 'back' } }) },
  select_option: { tools: ['fill'], spec: { uid: TEXT, value: TEXT } },
  wait_for: {
    tools: ['wait_for'],
    spec: { text: ['strings', true], timeout: ['number', false] },
  },
  type: {
    tools: ['fill', 'type_text'],
    spec: { uid: ['string', false], text: TEXT },
    map: fields => fields.uid === undefined ? { tools: ['type_text'], args: fields } : { tools: ['fill'], args: renameField(fields, 'text', 'value') },
  },
}

/** Chrome DevTools MCP: pages addressed by the numeric ids its `list_pages` reports. */
export const chromeDevtoolsOperations: BrowserMcpOperations = {
  methods(has) {
    const all = (...tools: string[]): boolean => tools.every(has)
    const methods: BrowserMcpMethod[] = []
    if (all('list_pages', 'navigate_page')) methods.push('navigate')
    if (all('list_pages', 'new_page', 'select_page', 'close_page')) methods.push('tabs')
    if (all('list_pages', 'take_snapshot')) methods.push('observe')
    if (has('list_pages') && Object.values(DEVTOOLS_ACTIONS).some(action => action.tools.some(has))) methods.push('act')
    if (all('list_pages', 'take_screenshot')) methods.push('screenshot')
    return methods
  },
  plan(operation) {
    if (operation.method === 'navigate') return devtoolsPage(operation.tabId, ['navigate_page'], { type: 'url', url: operation.url })
    if (operation.method === 'observe') return devtoolsPage(operation.tabId, ['take_snapshot'])
    if (operation.method === 'screenshot') return devtoolsPage(operation.tabId, ['take_screenshot'])
    if (operation.method === 'tabs') {
      if (operation.operation === 'list' || operation.operation === 'new') {
        if (operation.tabId !== undefined) throw new Error(`browser_tabs ${operation.operation} does not accept a tabId`)
        return [operation.operation === 'list'
          ? fixed(DEVTOOLS_LIST)
          : fixed(['new_page'], { url: operation.url ?? 'about:blank' })]
      }
      if (operation.tabId === undefined) throw new Error(`browser_tabs ${operation.operation} requires a tabId`)
      const pageId = tabNumber(operation.tabId, 'chrome-devtools-mcp')
      return [operation.operation === 'select'
        ? fixed(['select_page'], { pageId, bringToFront: true })
        : fixed(['close_page'], { pageId })]
    }
    if (operation.method === 'act') {
      const { kind, fields } = actionOf(operation)
      const action = DEVTOOLS_ACTIONS[kind]
      if (action === undefined) throw new Error(`browser_act ${kind} is not supported by chrome-devtools-mcp`)
      const text = fields.text
      const picked = pickFields(kind === 'wait_for' && typeof text === 'string' ? { ...fields, text: [text] } : fields, kind, action.spec)
      const mapped = action.map?.(picked) ?? { args: picked }
      return devtoolsPage(operation.tabId, mapped.tools ?? action.tools, mapped.args)
    }
    throw new Error(`browser provider does not support normalized ${operation.method} yet`)
  },
}
