/** Defaults, schema, and fail-loud validation for the map and default curator configuration. */
import z from '@deepseek-ai/schemastery'
import { ContextMapError } from './error.ts'
import type { Config, CuratorConfig } from './types.ts'

/** Map configuration with every default applied. */
export type ResolvedConfig = Required<Config>

/** Default curator configuration with every default applied. */
export type ResolvedCuratorConfig = Required<CuratorConfig>

/**
 * Defaults and what each is sized against. A group holds as many members as one load may
 * activate (context-tree `maxActivatedTools`, 32) and the map as many groups as one browse lists
 * (`maxBrowseNodes`, 64) halved, because groups sit beside file nodes. A note is a short fact of
 * about 100 tokens (400 bytes) so a full group stays near 1 KB of notes at eight notes; the
 * eager core holds eight sections because the 4,096-byte core budget of the tree divides into
 * roughly 512-byte sections. A logged snapshot may use the 64 KiB read ceiling of the context
 * index, and a view the 8 KiB a browse may render.
 */
const DEFAULTS = {
  maxGroups: 32,
  maxGroupMembers: 32,
  maxNotesPerGroup: 8,
  maxCitesPerNote: 4,
  maxNoteBytes: 400,
  maxEvidenceBytes: 200,
  maxPendingNotes: 16,
  maxTitleBytes: 80,
  maxSummaryBytes: 160,
  maxCoreSections: 8,
  maxSnapshotBytes: 65_536,
  maxViewBytes: 8192,
} as const satisfies Required<Config>

const MINIMUMS: Readonly<Record<keyof Required<Config>, number>> = {
  maxGroups: 1,
  maxGroupMembers: 1,
  maxNotesPerGroup: 1,
  maxCitesPerNote: 1,
  maxNoteBytes: 16,
  maxEvidenceBytes: 8,
  maxPendingNotes: 1,
  maxTitleBytes: 8,
  maxSummaryBytes: 16,
  maxCoreSections: 1,
  maxSnapshotBytes: 1024,
  maxViewBytes: 1024,
}

const CURATOR_DEFAULTS = {
  provider: 'spawn',
  maxSteps: 24,
  maxTokens: 4096,
  minContextTokens: 32_768,
  maxRoutesInspected: 16,
} as const satisfies Required<CuratorConfig>

const positive = (minimum: number, fallback: number): z<number> => z.number().step(1).min(minimum).default(fallback)

/** Schemastery schema of the map service. */
export const ConfigSchema: z<Config> = z.object({
  maxGroups: positive(MINIMUMS.maxGroups, DEFAULTS.maxGroups),
  maxGroupMembers: positive(MINIMUMS.maxGroupMembers, DEFAULTS.maxGroupMembers),
  maxNotesPerGroup: positive(MINIMUMS.maxNotesPerGroup, DEFAULTS.maxNotesPerGroup),
  maxCitesPerNote: positive(MINIMUMS.maxCitesPerNote, DEFAULTS.maxCitesPerNote),
  maxNoteBytes: positive(MINIMUMS.maxNoteBytes, DEFAULTS.maxNoteBytes),
  maxEvidenceBytes: positive(MINIMUMS.maxEvidenceBytes, DEFAULTS.maxEvidenceBytes),
  maxPendingNotes: positive(MINIMUMS.maxPendingNotes, DEFAULTS.maxPendingNotes),
  maxTitleBytes: positive(MINIMUMS.maxTitleBytes, DEFAULTS.maxTitleBytes),
  maxSummaryBytes: positive(MINIMUMS.maxSummaryBytes, DEFAULTS.maxSummaryBytes),
  maxCoreSections: positive(MINIMUMS.maxCoreSections, DEFAULTS.maxCoreSections),
  maxSnapshotBytes: positive(MINIMUMS.maxSnapshotBytes, DEFAULTS.maxSnapshotBytes),
  maxViewBytes: positive(MINIMUMS.maxViewBytes, DEFAULTS.maxViewBytes),
})

/** Schemastery schema of the default curator. */
export const CuratorConfigSchema: z<CuratorConfig> = z.object({
  provider: z.string().min(1).default(CURATOR_DEFAULTS.provider),
  maxSteps: positive(1, CURATOR_DEFAULTS.maxSteps),
  maxTokens: positive(256, CURATOR_DEFAULTS.maxTokens),
  minContextTokens: positive(1024, CURATOR_DEFAULTS.minContextTokens),
  maxRoutesInspected: positive(1, CURATOR_DEFAULTS.maxRoutesInspected),
})

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

/**
 * Apply defaults and validate the map configuration.
 * @param config - user configuration.
 * @returns the complete configuration.
 * @throws {@link ContextMapError} `CONTEXT_MAP_INVALID_CONFIG` for an unusable value.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const merged = { ...DEFAULTS, ...withoutUndefined(config) } as ResolvedConfig
  for (const [key, minimum] of Object.entries(MINIMUMS) as [keyof ResolvedConfig, number][]) {
    const value = merged[key]
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new ContextMapError(`${key} must be a safe integer of at least ${minimum}, got ${String(value)}`, 'CONTEXT_MAP_INVALID_CONFIG')
    }
  }
  const metadataBytes = 512 + merged.maxCoreSections * 23
  if (merged.maxViewBytes < metadataBytes) {
    throw new ContextMapError(`maxViewBytes must be at least ${metadataBytes} for maxCoreSections`, 'CONTEXT_MAP_INVALID_CONFIG')
  }
  return merged
}

/**
 * Apply defaults and validate the default curator configuration.
 * @param config - user configuration.
 * @returns the complete configuration.
 * @throws {@link ContextMapError} `CONTEXT_MAP_INVALID_CONFIG` for an unusable value.
 */
export function resolveCuratorConfig(config: CuratorConfig): ResolvedCuratorConfig {
  const merged = { ...CURATOR_DEFAULTS, ...withoutUndefined(config) } as ResolvedCuratorConfig
  const minimums = { maxSteps: 1, maxTokens: 256, minContextTokens: 1024, maxRoutesInspected: 1 } as const
  for (const [key, minimum] of Object.entries(minimums) as [keyof typeof minimums, number][]) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] < minimum) {
      throw new ContextMapError(`${key} must be a safe integer of at least ${minimum}, got ${String(merged[key])}`, 'CONTEXT_MAP_INVALID_CONFIG')
    }
  }
  if (merged.provider === '') throw new ContextMapError('provider must name a subagent provider', 'CONTEXT_MAP_INVALID_CONFIG')
  return merged
}
