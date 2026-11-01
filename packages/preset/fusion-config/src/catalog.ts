/** Immutable catalog identities; gateway ownership never determines model lineage. */
import { z } from 'zod'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

/** Explicit effort sent separately from the exact model id. */
export const effortSchema = z.enum(['low', 'medium', 'high'])
/** Registered model lineage, independent of route and account. */
export const familySchema = z.enum(['OpenAI', 'Anthropic'])
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
const endpoint = z.url().refine((value) => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
}, 'Use an HTTP base URL without credentials, query or fragment')

/** Strict configured model identity; only exact, traceable aliases are accepted. */
export const definitionSchema = z.strictObject({
  catalogRevision: identifier,
  presetId: identifier,
  canonicalModelId: identifier,
  family: familySchema,
  providerId: identifier,
  adapterId: z.literal('llm-pi-ai'),
  transport: z.enum(['openai-responses', 'anthropic-messages']),
  wireModelId: identifier,
  baseURL: endpoint,
  credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  alias: z.strictObject({ kind: z.literal('exact'), canonicalModelId: identifier }),
  leadEffort: effortSchema,
  executorEffort: effortSchema,
})
/** Catalog declaration before a role selects its explicit effort. */
export type ModelDefinition = z.infer<typeof definitionSchema>
/** Captured role binding; no live inheritance and no secret values. */
export type Binding = Readonly<Omit<ModelDefinition, 'leadEffort' | 'executorEffort' | 'alias' | 'credentialRef'> & {
  credentialRef: ReturnType<typeof credentialRef>
  effort: z.infer<typeof effortSchema>
}>

const shipping = [
  ['Fable', 'Anthropic', 'claude-fable-5-1', 'high'],
  ['Astra', 'OpenAI', 'gpt-6-astra', 'high'],
  ['Sol', 'OpenAI', 'gpt-6.1-sol', 'medium'],
  ['Terra', 'OpenAI', 'gpt-6.1-terra', 'medium'],
  ['Luna', 'OpenAI', 'gpt-6-luna', 'medium'],
  ['Opus', 'Anthropic', 'claude-opus-5-5', 'medium'],
  ['Sonnet', 'Anthropic', 'claude-sonnet-5-5', 'high'],
  ['Haiku', 'Anthropic', 'claude-haiku-5-5', 'high'],
] as const

/** Configuration failure with a safe code; never embeds rejected values or provider diagnostics. */
export class FusionConfigError extends Error {
  constructor(readonly code: 'invalid-configuration' | 'identity' | 'topology' | 'effort' | 'not-found') {
    super(`Fusion configuration: ${code}. Check the named selection and catalog declarations.`)
    this.name = 'FusionConfigError'
  }
}

/**
 * Materialize v1 and low-effort-v1 for one host credential reference.
 * @param reference - host credential name, never a value.
 * @returns ten detached, deeply frozen declarations with exact upstream endpoints.
 */
export function shippingCatalog(reference: string): readonly ModelDefinition[] {
  credentialRef(reference)
  const v1 = shipping.map(([presetId, family, canonicalModelId, executorEffort]): ModelDefinition => ({
    catalogRevision: 'v1', presetId, canonicalModelId, family,
    providerId: family === 'OpenAI' ? 'omniroute-openai' : 'omniroute-anthropic',
    adapterId: 'llm-pi-ai',
    transport: family === 'OpenAI' ? 'openai-responses' : 'anthropic-messages',
    wireModelId: `${family === 'OpenAI' ? 'cx' : 'cc'}/${canonicalModelId}`,
    baseURL: family === 'OpenAI' ? 'http://127.0.0.1:20128/v1' : 'http://127.0.0.1:20128',
    credentialRef: reference, alias: { kind: 'exact', canonicalModelId }, leadEffort: 'high', executorEffort,
  }))
  const low = v1.filter(row => row.presetId === 'Haiku' || row.presetId === 'Luna').map(row => ({
    ...structuredClone(row), catalogRevision: 'low-effort-v1', presetId: `${row.presetId}-low`,
    leadEffort: 'low', executorEffort: 'low',
  } satisfies ModelDefinition))
  return deepFreeze([...v1, ...low])
}

/**
 * Validate custom revisions against registered canonical identities and alias mappings.
 * @param reference - credential name for the shipping declarations.
 * @param additional - explicitly configured, versioned declarations.
 * @returns immutable combined catalog; duplicates, reserved revisions and forged lineage throw.
 */
export function resolveCatalog(reference: string, additional: readonly ModelDefinition[]): readonly ModelDefinition[] {
  const catalog = [...shippingCatalog(reference)]
  for (const row of additional) {
    if (row.catalogRevision === 'v1' || row.catalogRevision === 'low-effort-v1'
      || row.alias.canonicalModelId !== row.canonicalModelId
      || /(?:^|[/._-])(?:auto|fallback|latest)(?:$|[/._-])/iu.test(row.wireModelId)
      || catalog.some(known => known.catalogRevision === row.catalogRevision && known.presetId === row.presetId)
      || catalog.some(known => (known.canonicalModelId === row.canonicalModelId || known.wireModelId === row.wireModelId)
        && (known.family !== row.family || known.canonicalModelId !== row.canonicalModelId))) {
      throw new FusionConfigError('identity')
    }
    catalog.push(structuredClone(row))
  }
  return deepFreeze(catalog)
}

/** Exact revision lookup used by selection capture. */
export const referenceSchema = z.strictObject({ catalogRevision: identifier, presetId: identifier, effort: effortSchema.optional() })
/** Parsed catalog reference; omitted effort means the catalog's role effort. */
export type BindingReference = z.infer<typeof referenceSchema>

/**
 * Capture one role from an immutable catalog revision, refusing effort overrides.
 * @param catalog - resolved immutable declarations.
 * @param reference - exact revision and preset id.
 * @param role - executor or lead (also decider, takeover and auxiliary roles).
 * @returns complete frozen binding; unresolved identity or changed effort throws.
 */
export function bind(catalog: readonly ModelDefinition[], reference: BindingReference, role: 'lead' | 'executor'): Binding {
  const definition = catalog.find(row => row.catalogRevision === reference.catalogRevision && row.presetId === reference.presetId)
  if (definition === undefined) throw new FusionConfigError('not-found')
  const effort = role === 'lead' ? definition.leadEffort : definition.executorEffort
  if (reference.effort !== undefined && reference.effort !== effort) throw new FusionConfigError('effort')
  const { leadEffort: _lead, executorEffort: _executor, alias: _alias, credentialRef: ref, ...identity } = definition
  return deepFreeze({ ...identity, credentialRef: credentialRef(ref), effort })
}
