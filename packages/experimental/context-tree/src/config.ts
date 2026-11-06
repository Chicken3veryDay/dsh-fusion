/** Defaults, schema, and fail-loud validation for the context tree configuration. */
import z from '@deepseek-ai/schemastery'
import { ContextTreeError } from './error.ts'
import type { Config } from './types.ts'

/** Configuration with every default applied. */
export type ResolvedConfig = Required<Config>

/**
 * The tools the owner wants always visible. Names that no plugin registers are absent from
 * a request, because the base set never adds tools.
 */
export const DEFAULT_BASE_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'grep',
  'bash',
  'web_search',
  'web_fetch',
  'todo_write',
  'skill',
  'context_browse',
  'context_load',
  'context_note',
]

/**
 * Names the two tree tools; they are always exposed whatever `baseTools` says. `context_note` is
 * a base tool only when a plugin registers it.
 */
export const CONTEXT_TOOL_NAMES: readonly string[] = ['context_browse', 'context_load']

/**
 * Defaults and what each bound is sized against: a browse of 64 nodes at 160 bytes is about
 * 10 KB of lines, so 8 KB of rendered text keeps one browse under a quarter of the
 * agent-instructions chain budget; a load injects at most half of the 64 KiB read ceiling of
 * the context index; the dropped list gets half of the 2,048-byte stub budget compaction-basic
 * gives one checkpoint; the eager core gets the 4,096 bytes the profile already gives agent-instructions;
 * 32 activations cover the largest default tool group (21 `ticket_*` tools).
 */
const DEFAULTS = {
  baseTools: DEFAULT_BASE_TOOLS as string[],
  maxBrowseDepth: 3,
  maxBrowseNodes: 64,
  maxBrowseBytes: 8192,
  maxLoadPaths: 16,
  maxLoadBytes: 32_768,
  maxActivatedTools: 32,
  maxSummaryBytes: 160,
  maxDroppedBytes: 1024,
  coreBytes: 4096,
} as const satisfies Required<Config>

const MINIMUMS = {
  maxBrowseDepth: 1,
  maxBrowseNodes: 1,
  maxBrowseBytes: 256,
  maxLoadPaths: 1,
  maxLoadBytes: 1,
  maxActivatedTools: 1,
  maxSummaryBytes: 32,
  maxDroppedBytes: 64,
  coreBytes: 1,
} as const

/** Schemastery schema for the service; every field defaults, so no configuration is required. */
export const ConfigSchema: z<Config> = z.object({
  baseTools: z.array(z.string()).default([...DEFAULTS.baseTools]),
  maxBrowseDepth: z.number().step(1).min(MINIMUMS.maxBrowseDepth).default(DEFAULTS.maxBrowseDepth),
  maxBrowseNodes: z.number().step(1).min(MINIMUMS.maxBrowseNodes).default(DEFAULTS.maxBrowseNodes),
  maxBrowseBytes: z.number().step(1).min(MINIMUMS.maxBrowseBytes).default(DEFAULTS.maxBrowseBytes),
  maxLoadPaths: z.number().step(1).min(MINIMUMS.maxLoadPaths).default(DEFAULTS.maxLoadPaths),
  maxLoadBytes: z.number().step(1).min(MINIMUMS.maxLoadBytes).default(DEFAULTS.maxLoadBytes),
  maxActivatedTools: z.number().step(1).min(MINIMUMS.maxActivatedTools).default(DEFAULTS.maxActivatedTools),
  maxSummaryBytes: z.number().step(1).min(MINIMUMS.maxSummaryBytes).default(DEFAULTS.maxSummaryBytes),
  maxDroppedBytes: z.number().step(1).min(MINIMUMS.maxDroppedBytes).default(DEFAULTS.maxDroppedBytes),
  coreBytes: z.number().step(1).min(MINIMUMS.coreBytes).default(DEFAULTS.coreBytes),
})

function invalid(message: string): never {
  throw new ContextTreeError(message, 'CONTEXT_TREE_INVALID_CONFIG')
}

/**
 * Apply defaults and validate.
 * @param config - user configuration.
 * @returns the complete configuration; the two tree tools are always in `baseTools`.
 * @throws {@link ContextTreeError} `CONTEXT_TREE_INVALID_CONFIG` for an unusable value.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const given = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
  const merged = { ...DEFAULTS, ...given } as ResolvedConfig
  for (const [key, minimum] of Object.entries(MINIMUMS) as [keyof typeof MINIMUMS, number][]) {
    const value = merged[key]
    if (!Number.isSafeInteger(value) || value < minimum) invalid(`${key} must be a safe integer of at least ${minimum}, got ${String(value)}`)
  }
  for (const name of merged.baseTools) {
    if (name === '' || /\s/.test(name)) invalid(`baseTools entries must be tool names, got "${name}"`)
  }
  return { ...merged, baseTools: [...new Set([...merged.baseTools, ...CONTEXT_TOOL_NAMES])] }
}
