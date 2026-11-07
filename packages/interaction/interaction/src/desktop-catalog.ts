/** Mapping of normalized desktop operations onto a Cua Driver tool catalog. @module */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { DesktopActionKind, DesktopOperation } from './index.ts'

/** The live driver catalog a desktop mapping reads. */
export interface DesktopCatalog {
  /**
   * Read one raw tool's declared input.
   * @param tool - raw driver tool name.
   * @returns the tool's JSON Schema, or undefined when the live catalog lacks the tool.
   */
  schema(tool: string): Readonly<Record<string, unknown>> | undefined
}

/** One raw driver call planned for a normalized desktop operation. */
export interface DesktopCall {
  /** Exact raw driver tool name. */
  readonly tool: string
  /** Arguments that the tool's declared input accepts. */
  readonly args: Record<string, JsonValue>
}

/** Normalized desktop methods a catalog can execute. */
export type DesktopMethod = DesktopOperation['method']

/**
 * The raw driver tool that executes each normalized action kind. Matching is by exact name:
 * a kind resolves to this tool or to nothing.
 */
export const DESKTOP_ACTION_TOOLS = {
  click: 'click',
  type: 'type_text',
  press_key: 'press_key',
  scroll: 'scroll',
  drag: 'drag',
  hotkey: 'hotkey',
  set_value: 'set_value',
} as const satisfies Record<DesktopActionKind, string>

/** Whole-display capture: the only observation that needs no window. */
const DESKTOP_STATE_TOOL = 'get_desktop_state'
/** Per-window observation: it addresses a window by integer `pid` and `window_id`. */
const WINDOW_STATE_TOOL = 'get_window_state'

function declared(schema: Readonly<Record<string, unknown>> | undefined, key: string): boolean {
  const properties = schema?.properties
  return typeof properties === 'object' && properties !== null && Object.hasOwn(properties, key)
}

function closed(schema: Readonly<Record<string, unknown>>): boolean {
  return schema.additionalProperties === false
}

/** Parse a driver id that must be a positive integer, or reject it before any call. */
function driverId(value: string, label: string): number {
  const parsed = Number(value)
  if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer for this provider (applicationId is the process id, windowId the window id)`)
  }
  return parsed
}

/**
 * List the normalized methods the catalog executes completely.
 * @param catalog - live driver catalog.
 * @returns `observe` and `screenshot` when a window or desktop observation tool exists, `act` when any action kind maps.
 */
export function desktopMethods(catalog: DesktopCatalog): readonly DesktopMethod[] {
  const observes = catalog.schema(WINDOW_STATE_TOOL) !== undefined || catalog.schema(DESKTOP_STATE_TOOL) !== undefined
  return [
    ...observes ? ['observe', 'screenshot'] as const : [],
    ...desktopActionKinds(catalog).length > 0 ? ['act'] as const : [],
  ]
}

/**
 * List the normalized action kinds whose exact driver tool the catalog exposes.
 * @param catalog - live driver catalog.
 * @returns the executable kinds in normalized order.
 */
export function desktopActionKinds(catalog: DesktopCatalog): readonly DesktopActionKind[] {
  return (Object.keys(DESKTOP_ACTION_TOOLS) as DesktopActionKind[]).filter(kind => catalog.schema(DESKTOP_ACTION_TOOLS[kind]) !== undefined)
}

function targetArgs(operation: DesktopOperation): Record<string, JsonValue> {
  return {
    ...operation.applicationId === undefined ? {} : { pid: driverId(operation.applicationId, 'applicationId') },
    ...operation.windowId === undefined ? {} : { window_id: driverId(operation.windowId, 'windowId') },
  }
}

function requireDeclared(tool: string, schema: Readonly<Record<string, unknown>>, keys: Iterable<string>): void {
  for (const key of keys) {
    if (closed(schema) && !declared(schema, key)) throw new Error(`Cua Driver tool "${tool}" does not accept "${key}"`)
  }
}

function plannedObservation(catalog: DesktopCatalog, operation: DesktopOperation): DesktopCall {
  if (operation.applicationId === undefined && operation.windowId === undefined) {
    if (catalog.schema(DESKTOP_STATE_TOOL) === undefined) {
      throw new Error(`desktop_${operation.method} needs applicationId and windowId: this Cua Driver has no whole-display observation`)
    }
    return { tool: DESKTOP_STATE_TOOL, args: {} }
  }
  if (operation.applicationId === undefined || operation.windowId === undefined) {
    throw new Error(`desktop_${operation.method} needs both applicationId and windowId, or neither for the whole display`)
  }
  const schema = catalog.schema(WINDOW_STATE_TOOL)
  if (schema === undefined) throw new Error('Cua Driver does not expose a window observation tool')
  const args: Record<string, JsonValue> = {
    ...targetArgs(operation),
    ...operation.method === 'screenshot' ? { include_screenshot: true, include_accessibility_tree: false } : {},
  }
  requireDeclared(WINDOW_STATE_TOOL, schema, Object.keys(args))
  return { tool: WINDOW_STATE_TOOL, args }
}

function plannedAction(catalog: DesktopCatalog, operation: Extract<DesktopOperation, { method: 'act' }>): DesktopCall {
  const action = operation.action
  if (typeof action !== 'object' || action === null || Array.isArray(action)) throw new Error('desktop_act requires an object action with kind')
  const { kind, ...rest } = action
  if (typeof kind !== 'string') throw new Error('desktop_act action.kind must be a string')
  const supported = desktopActionKinds(catalog)
  const mapped = Object.hasOwn(DESKTOP_ACTION_TOOLS, kind) ? DESKTOP_ACTION_TOOLS[kind as DesktopActionKind] : undefined
  const schema = mapped === undefined ? undefined : catalog.schema(mapped)
  if (mapped === undefined || schema === undefined) {
    throw new Error(`desktop_act action.kind "${kind}" is not supported; supported kinds: ${supported.join(', ') || 'none'}`)
  }
  const target = targetArgs(operation)
  const clash = Object.keys(target).find(key => Object.hasOwn(rest, key))
  if (clash !== undefined) throw new Error(`desktop_act action must not repeat "${clash}"; use applicationId and windowId`)
  const args = { ...target, ...rest }
  requireDeclared(mapped, schema, Object.keys(args))
  return { tool: mapped, args }
}

/**
 * Translate one normalized desktop operation into one raw driver call.
 * Observation without ids captures the whole display; with both ids it reads that window.
 * @param catalog - live driver catalog.
 * @param operation - normalized desktop operation.
 * @returns the exact tool and arguments.
 * @throws before any call when an id is malformed, the target is incomplete, the action kind has no exact tool,
 *   or an argument is undeclared.
 */
export function planDesktopOperation(catalog: DesktopCatalog, operation: DesktopOperation): DesktopCall {
  return operation.method === 'act' ? plannedAction(catalog, operation) : plannedObservation(catalog, operation)
}
