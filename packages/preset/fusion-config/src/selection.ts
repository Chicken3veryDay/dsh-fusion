/** Named, revisioned selections; capturing configuration does not admit a task. */
import { z } from 'zod'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { bind, FusionConfigError, referenceSchema } from './catalog.ts'
import type { Binding, BindingReference, ModelDefinition } from './catalog.ts'

const topologySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('top'), userFacingLead: referenceSchema, otherCoLead: referenceSchema, executor: referenceSchema }),
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
  /** Role links preserve context reuse; checkpoint admission still enforces implementation separation. */
  readonly authority: Readonly<{
    decider: 'userFacingLead' | 'otherCoLead' | 'lead' | 'participant' | 'decider'
    takeover: 'userFacingLead' | 'otherCoLead' | 'lead' | null
  }>
  readonly upgrades: readonly Binding[]
}
type LeadRole = Exclude<Selection['authority']['decider'], 'decider'>

const ref = (presetId: string): BindingReference => ({ catalogRevision: 'v1', presetId })

/**
 * Build shipping tier choices with their specified pairs and upgrade chains.
 * @param agentPreset - existing DSH capability composition used by these choices.
 * @returns named opt-in declarations; no choice becomes the application's default.
 */
export function shippingSelections(agentPreset: string): readonly SelectionDefinition[] {
  const common = { revision: 'v1', agentPreset, auxiliaries: {} }
  return deepFreeze([
    { ...common, id: 'top', topology: { kind: 'top', userFacingLead: ref('Astra'), otherCoLead: ref('Fable'), executor: ref('Sol') } },
    { ...common, id: 'top-opus', topology: { kind: 'top', userFacingLead: ref('Astra'), otherCoLead: ref('Fable'), executor: ref('Opus') } },
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
  const leads: [LeadRole, Binding][] = []
  let defaultAuthority: Binding
  switch (topology.kind) {
    case 'top': {
      const first = bind(catalog, topology.userFacingLead, 'lead')
      const second = bind(catalog, topology.otherCoLead, 'lead')
      if (first.family === second.family) throw new FusionConfigError('topology')
      roles.userFacingLead = first
      roles.otherCoLead = second
      roles.executor = bind(catalog, topology.executor, 'executor')
      leads.push(['userFacingLead', first], ['otherCoLead', second])
      defaultAuthority = first
      break
    }
    case 'middle':
    case 'low': {
      const lead = bind(catalog, topology.lead, 'lead')
      const executor = bind(catalog, topology.executor, 'executor')
      roles.lead = lead
      roles.executor = executor
      leads.push(['lead', lead])
      defaultAuthority = lead
      const seen = new Set([executor.canonicalModelId])
      for (const next of [executor, ...topology.upgrades.map(row => bind(catalog, row, 'executor'))]) {
        if (next.family === lead.family || (next !== executor && seen.has(next.canonicalModelId))) {
          throw new FusionConfigError('topology')
        }
        seen.add(next.canonicalModelId)
        if (next !== executor) upgrades.push(next)
      }
      // Edges belong to canonical models; changing a route revision cannot add or skip one.
      const chain = [executor, ...upgrades]
      const allowed = topology.kind === 'middle'
        ? [['Sonnet', 'Opus'], ['Terra', 'Sol']]
        : [['Haiku', 'Sonnet', 'Opus'], ['Luna', 'Terra', 'Sol']]
      if (upgrades.length > 0 && !allowed.some((path) => {
        const canonicalPath = path.map(id => catalog.find(row => row.catalogRevision === 'v1' && row.presetId === id)?.canonicalModelId)
        const start = canonicalPath.indexOf(executor.canonicalModelId)
        return start >= 0 && chain.every((row, index) => canonicalPath[start + index] === row.canonicalModelId)
      })) throw new FusionConfigError('topology')
      break
    }
    case 'single':
      roles.participant = bind(catalog, topology.participant, 'lead')
      leads.push(['participant', roles.participant])
      defaultAuthority = roles.participant
      break
  }
  const leadRole = (binding: Binding) => leads.find(([, candidate]) => JSON.stringify(candidate) === JSON.stringify(binding))?.[0]
  roles.decider = definition.decider === undefined ? defaultAuthority : bind(catalog, definition.decider, 'lead')
  const decider = leadRole(roles.decider) ?? 'decider'
  let takeover: Selection['authority']['takeover'] = null
  if (topology.kind === 'single') {
    if (decider !== 'participant' || definition.takeover !== undefined) throw new FusionConfigError('topology')
  } else {
    roles.takeover = definition.takeover === undefined ? defaultAuthority : bind(catalog, definition.takeover, 'lead')
    const role = leadRole(roles.takeover)
    if (role === undefined || role === 'participant') throw new FusionConfigError('topology')
    takeover = role
  }
  for (const [name, reference] of Object.entries(definition.auxiliaries)) roles[`auxiliary:${name}`] = bind(catalog, reference, 'lead')
  return deepFreeze({
    id: definition.id, revision: definition.revision, agentPreset: definition.agentPreset,
    mode: topology.kind === 'single' ? 'single' : 'fusion', runtime: 'quickjs-script', tier: topology.kind, roles, authority: { decider, takeover }, upgrades,
  })
}
