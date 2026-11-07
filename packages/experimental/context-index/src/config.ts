/** Defaults, schema, and fail-loud validation for the context index configuration. */
import { sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { agentsHomeDisplay, dshHomeDisplay, resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ContextIndexError } from './error.ts'
import type { Config } from './types.ts'

/** Configuration with every default applied and the harness homes resolved. */
export interface ResolvedConfig extends Required<Config> {
  dshHome: string
  agentsHome: string
  dshHomeDisplay: string
  agentsHomeDisplay: string
}

/**
 * Defaults and the evidence for each, measured on this repository's `docs/` (601
 * Markdown files, 8.4 MB, 10,432 sections: p99 6,124 bytes, headings p99.9 93
 * bytes, deepest level 4) and its 23 AGENTS.md files (largest section 8,483 bytes).
 */
const DEFAULTS = {
  projectRootMarkers: ['.git'],
  instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
  localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md'],
  docRoots: ['docs', 'doc'],
  docExtensions: ['.md', '.markdown'],
  maxSourceBytes: 1_048_576,
  maxSectionBytes: 8192,
  maxHeadingBytes: 120,
  maxDocFiles: 1024,
  maxDocDepth: 8,
  maxTotalSourceBytes: 16_777_216,
  maxReadBytes: 65_536,
  maxCatalogBytes: 8192,
  maxIndexedDirectories: 16,
} as const satisfies Required<Config>

const MINIMUMS = {
  maxSourceBytes: 1,
  maxSectionBytes: 16,
  maxHeadingBytes: 16,
  maxDocFiles: 1,
  maxDocDepth: 1,
  maxTotalSourceBytes: 1,
  maxReadBytes: 1,
  maxCatalogBytes: 1,
  maxIndexedDirectories: 1,
} as const

/** Schemastery schema for the service; every field defaults, so no configuration is required. */
export const ConfigSchema: z<Config> = z.object({
  projectRootMarkers: z.array(z.string()).default([...DEFAULTS.projectRootMarkers]),
  instructionFileCandidates: z.array(z.string()).default([...DEFAULTS.instructionFileCandidates]),
  localInstructionFileCandidates: z.array(z.string()).default([...DEFAULTS.localInstructionFileCandidates]),
  docRoots: z.array(z.string()).default([...DEFAULTS.docRoots]),
  docExtensions: z.array(z.string()).default([...DEFAULTS.docExtensions]),
  maxSourceBytes: z.number().step(1).min(MINIMUMS.maxSourceBytes).default(DEFAULTS.maxSourceBytes),
  maxSectionBytes: z.number().step(1).min(MINIMUMS.maxSectionBytes).default(DEFAULTS.maxSectionBytes),
  maxHeadingBytes: z.number().step(1).min(MINIMUMS.maxHeadingBytes).default(DEFAULTS.maxHeadingBytes),
  maxDocFiles: z.number().step(1).min(MINIMUMS.maxDocFiles).default(DEFAULTS.maxDocFiles),
  maxDocDepth: z.number().step(1).min(MINIMUMS.maxDocDepth).default(DEFAULTS.maxDocDepth),
  maxTotalSourceBytes: z.number().step(1).min(MINIMUMS.maxTotalSourceBytes).default(DEFAULTS.maxTotalSourceBytes),
  maxReadBytes: z.number().step(1).min(MINIMUMS.maxReadBytes).default(DEFAULTS.maxReadBytes),
  maxCatalogBytes: z.number().step(1).min(MINIMUMS.maxCatalogBytes).default(DEFAULTS.maxCatalogBytes),
  maxIndexedDirectories: z.number().step(1).min(MINIMUMS.maxIndexedDirectories).default(DEFAULTS.maxIndexedDirectories),
})

function invalid(message: string): never {
  throw new ContextIndexError(message, 'CONTEXT_INDEX_INVALID_CONFIG')
}

function fileNames(name: string, values: readonly string[]): readonly string[] {
  for (const value of values) {
    if (value === '' || value === '.' || value === '..' || /[\\/]/.test(value)) {
      invalid(`${name} entries must be plain file names, got "${value}"`)
    }
  }
  return values
}

function relativeRoots(values: readonly string[]): readonly string[] {
  return values.map((value) => {
    const segments = value.split('/')
    if (value === '' || value.startsWith('/') || value.includes('\\') || segments.some(s => s === '' || s === '.' || s === '..')) {
      invalid(`docRoots entries must be relative paths of plain segments separated by "/", got "${value}"`)
    }
    return value
  })
}

function extensions(values: readonly string[]): readonly string[] {
  return values.map((value) => {
    if (!/^\.[^./\\]+$/.test(value)) invalid(`docExtensions entries must look like ".md", got "${value}"`)
    return value.toLowerCase()
  })
}

/**
 * Apply defaults, validate, and resolve the harness homes (from the process
 * environment, like agent-instructions, so both packages see the same files).
 * @param config - user configuration.
 * @returns the complete configuration.
 * @throws {@link ContextIndexError} `CONTEXT_INDEX_INVALID_CONFIG` for an unusable value.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const given = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
  const merged = { ...DEFAULTS, ...given } as Required<Config>
  for (const [key, minimum] of Object.entries(MINIMUMS) as [keyof typeof MINIMUMS, number][]) {
    const value = merged[key]
    if (!Number.isSafeInteger(value) || value < minimum) invalid(`${key} must be a safe integer of at least ${minimum}, got ${String(value)}`)
  }
  const dshHome = resolveDshHome()
  const agentsHome = resolveAgentsHome()
  return {
    ...merged,
    projectRootMarkers: fileNames('projectRootMarkers', merged.projectRootMarkers) as string[],
    instructionFileCandidates: fileNames('instructionFileCandidates', merged.instructionFileCandidates) as string[],
    localInstructionFileCandidates: fileNames('localInstructionFileCandidates', merged.localInstructionFileCandidates) as string[],
    docRoots: relativeRoots(merged.docRoots) as string[],
    docExtensions: extensions(merged.docExtensions) as string[],
    dshHome,
    agentsHome,
    dshHomeDisplay: dshHomeDisplay(dshHome),
    agentsHomeDisplay: agentsHomeDisplay(agentsHome),
  }
}

/**
 * Convert a platform path to `/` separators for display.
 * @param path - platform-specific relative path.
 * @returns the path with `/` separators.
 */
export function toPosix(path: string): string {
  return path.split(sep).join('/')
}
