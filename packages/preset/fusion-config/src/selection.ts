/** Named, revisioned selections; capturing configuration does not admit a task. */
import { z } from 'zod'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { bind, FusionConfigError, referenceSchema } from './catalog.ts'
import type { Binding, BindingReference, ModelDefinition } from './catalog.ts'

const topologySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('top'), coLeads: z.tuple([referenceSchema, referenceSchema]), executor: referenceSchema }),
  z.strictObject({ kind: z.enum(['middle', 'low']), lead: referenceSchema, executor: referenceSchema, upgrades: z.array(referenceSchema) }),
  z.strictObject({ kind: z.literal('single'), participant: referenceSchema }),
])
/** Named configuration accepted by the Loader; every role resolves before publication. */
export const selectionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  revision: z.string().min(1),
  agentPreset: z.string().min(1),
  topology: topologySchema,
  decider: referenceSchema.optional(),
  takeover: referenceSchema.optional(),
  auxiliaries: z.record(z.string().min(1), referenceSchema),
})
/** Loader-owned declaration; builtin defaults are declarations too, never enabled defaults. */
export type SelectionDefinition = z.infer<typeof selectionSchema>
/** Captured configuration for a future task, not a runtime or default-eligibility receipt. */
export interface Selection {
  readonly id: string
  readonly revision: string
  readonly agentPreset: string
  readonly mode: 'fusion' | 'single'
  readonly runtime: 'quickjs-script'
  readonly tier: 'top' | 'middle' | 'low' | 'single'
  readonly roles: Readonly<Record<string, Binding>>
  readonly upgrades: readonly Binding[]
}

const ref = (presetId: string): BindingReference => ({ catalogRevision: 'v1', presetId })

/**
 * Build shipping tier choices with their specified pairs and upgrade chains.
 * @param agentPreset - existing DSH capability composition used by these choices.
 * @returns named opt-in declarations; no choice becomes the application's default.
 */
export function shippingSelections(agentPreset: string): readonly SelectionDefinition[] {
  const common = { revision: 'v1', agentPreset, auxiliaries: {} }
  return deepFreeze([
    { ...common, id: 'top', topology: { kind: 'top', coLeads: [ref('Fable'), ref('Astra')], executor: ref('Sol') } },
    { ...common, id: 'top-opus', topology: { kind: 'top', coLeads: [ref('Fable'), ref('Astra')], executor: ref('Opus') } },
    { ...common, id: 'middle', topology: { kind: 'middle', lead: ref('Astra'), executor: ref('Sonnet'), upgrades: [ref('Opus')] } },
    { ...common, id: 'middle-fable-terra', topology: { kind: 'middle', lead: ref('Fable'), executor: ref('Terra'), upgrades: [ref('Sol')] } },
    { ...common, id: 'low', topology: { kind: 'low', lead: ref('Sol'), executor: ref('Haiku'), upgrades: [ref('Sonnet'), ref('Opus')] } },
    { ...common, id: 'low-opus-luna', topology: { kind: 'low', lead: ref('Opus'), executor: ref('Luna'), upgrades: [ref('Terra'), ref('Sol')] } },
  ] satisfies SelectionDefinition[])
}

/**
 * Resolve all roles and upgrade edges, validating lineage without provider-based guesses.
 * @param catalog - immutable registered model declarations.
 * @param definition - parsed named configuration.
 * @returns detached deeply frozen selection; invalid pairs, cycles and efforts throw.
 */
export function captureSelection(catalog: readonly ModelDefinition[], definition: SelectionDefinition): Selection {
  const roles: Record<string, Binding> = {}
  const upgrades: Binding[] = []
  const topology = definition.topology
  switch (topology.kind) {
    case 'top': {
      const first = bind(catalog, topology.coLeads[0], 'lead')
      const second = bind(catalog, topology.coLeads[1], 'lead')
      if (first.family === second.family) throw new FusionConfigError('topology')
      roles.coLead1 = first
      roles.coLead2 = second
      roles.executor = bind(catalog, topology.executor, 'executor')
      break
    }
    case 'middle':
    case 'low': {
      const lead = bind(catalog, topology.lead, 'lead')
      const executor = bind(catalog, topology.executor, 'executor')
      roles.lead = lead
      roles.executor = executor
      const seen = new Set([executor.canonicalModelId])
      for (const next of [executor, ...topology.upgrades.map(row => bind(catalog, row, 'executor'))]) {
        if (next.family === lead.family || (next !== executor && seen.has(next.canonicalModelId))) {
          throw new FusionConfigError('topology')
        }
        seen.add(next.canonicalModelId)
        if (next !== executor) upgrades.push(next)
      }
      // Shipping revisions have fixed upgrade order. A changed topology needs its own revision.
      const chain = [executor, ...upgrades]
      const allowed = topology.kind === 'middle'
        ? [['Sonnet', 'Opus'], ['Terra', 'Sol']]
        : [['Haiku', 'Sonnet', 'Opus'], ['Luna', 'Terra', 'Sol']]
      if (chain.every(row => catalog.some(known => known.catalogRevision === 'v1' && known.canonicalModelId === row.canonicalModelId)) && !allowed.some((path) => {
        const canonicalPath = path.map(id => catalog.find(row => row.catalogRevision === 'v1' && row.presetId === id)?.canonicalModelId)
        const start = canonicalPath.indexOf(executor.canonicalModelId)
        return start >= 0 && chain.every((row, index) => canonicalPath[start + index] === row.canonicalModelId)
      })) throw new FusionConfigError('topology')
      break
    }
    case 'single':
      roles.participant = bind(catalog, topology.participant, 'lead')
      break
  }
  if (definition.decider !== undefined) roles.decider = bind(catalog, definition.decider, 'lead')
  if (definition.takeover !== undefined) roles.takeover = bind(catalog, definition.takeover, 'lead')
  for (const [name, reference] of Object.entries(definition.auxiliaries)) roles[`auxiliary:${name}`] = bind(catalog, reference, 'lead')
  return deepFreeze({
    id: definition.id, revision: definition.revision, agentPreset: definition.agentPreset,
    mode: topology.kind === 'single' ? 'single' : 'fusion', runtime: 'quickjs-script', tier: topology.kind, roles, upgrades,
  })
}
