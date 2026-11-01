import { afterEach, expect, it } from 'vitest'
import { captureSelection, resolveCatalog, shippingCatalog, shippingSelections } from '../src/index.ts'
import { configuration, harness } from './harness.ts'

const catalog = shippingCatalog('KEY')
const ref = (presetId: string) => ({ catalogRevision: 'v1', presetId })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it.each([
  ['top', 'Astra', 'userFacingLead'], ['top-opus', 'Astra', 'userFacingLead'],
  ['middle', 'Astra', 'lead'], ['middle-fable-terra', 'Fable', 'lead'],
  ['low', 'Sol', 'lead'], ['low-opus-luna', 'Opus', 'lead'],
])('captures default authority for %s through the Loader', async (id, presetId, leadRole) => {
  const app = await harness(configuration('http://127.0.0.1:1'))
  cleanups.push(() => app.dispose())
  const selected = app.ctx.fusionConfig.selection(id)
  expect(selected.roles.decider?.presetId).toBe(presetId)
  expect(selected.roles.takeover?.presetId).toBe(presetId)
  expect(selected.authority).toEqual({ decider: leadRole, takeover: leadRole })
  expect(selected.roles[leadRole]).toEqual(selected.roles.decider)
  if (leadRole === 'userFacingLead') expect(selected.roles.otherCoLead?.presetId).toBe('Fable')
})

it.each(['unrelated-takeover', 'custom-upgrade', 'custom-skip'] as const)('rejects %s before publishing Loader services', async (kind) => {
  const config = configuration('http://127.0.0.1:1')
  const selected = config.selections[0]!
  if (kind === 'unrelated-takeover') selected.takeover = { catalogRevision: 'fixture-v1', presetId: 'Haiku' }
  else {
    const custom = { ...structuredClone(config.bindings.find(row => row.presetId === 'Haiku')!),
      catalogRevision: 'another-revision', presetId: 'Custom',
      canonicalModelId: 'custom-anthropic', wireModelId: 'cc/custom-anthropic',
      alias: { kind: 'exact' as const, canonicalModelId: 'custom-anthropic' } }
    config.bindings.push(custom)
    selected.topology = { kind: 'low', lead: { catalogRevision: 'fixture-v1', presetId: 'Sol' },
      executor: { catalogRevision: 'fixture-v1', presetId: 'Haiku' },
      upgrades: kind === 'custom-upgrade'
        ? [{ catalogRevision: custom.catalogRevision, presetId: custom.presetId }]
        : [{ catalogRevision: 'fixture-v1', presetId: 'Opus' }, { catalogRevision: custom.catalogRevision, presetId: custom.presetId }] }
    delete selected.takeover
  }
  const app = await harness(config)
  cleanups.push(() => app.dispose())
  const { ctx, agent } = app
  expect(ctx.get('fusionConfig') === undefined).toBe(true)
  expect(ctx.commands.find(agent, 'fusion_preflight')).toBeUndefined()
  expect(ctx.llm.listProviders()).toEqual([])
})

it('keeps Top work direction, selected co-lead takeover and third-model decisions independent', () => {
  const selected = captureSelection(catalog, {
    id: 'custom-top', revision: 'v2', agentPreset: 'standard', auxiliaries: {},
    topology: { kind: 'top', userFacingLead: ref('Astra'), otherCoLead: ref('Fable'), executor: ref('Sol') },
    takeover: ref('Fable'), decider: ref('Opus'),
  })
  expect(selected.authority).toEqual({ decider: 'decider', takeover: 'otherCoLead' })
  expect(selected.roles.userFacingLead?.presetId).toBe('Astra')
  expect(selected.roles.decider?.presetId).toBe('Opus')
  expect(selected.roles.takeover?.presetId).toBe('Fable')
})

it('retains configured lead identity when the decision route is shared', () => {
  const definition = shippingSelections('standard')[0]!
  const selected = captureSelection(catalog, { ...definition, decider: ref('Fable') })
  expect(selected.authority).toEqual({ decider: 'otherCoLead', takeover: 'userFacingLead' })
  expect(Object.isFrozen(selected.authority)).toBe(true)
})

it('allows custom opposite-family test bindings without inventing upgrade edges', () => {
  const lead = { catalogRevision: 'low-effort-v1', presetId: 'Luna-low' }
  const executor = { catalogRevision: 'low-effort-v1', presetId: 'Haiku-low' }
  const selected = captureSelection(catalog, {
    id: 'test-low', revision: 'test-v1', agentPreset: 'standard', auxiliaries: {},
    topology: { kind: 'low', lead, executor, upgrades: [] },
  })
  expect(selected.roles.decider?.effort).toBe('low')
  expect(selected.roles.takeover?.effort).toBe('low')
  expect(selected.upgrades).toEqual([])
})

it('validates allowed edges after an exact model moves to a custom revision', () => {
  const custom = catalog.filter(row => row.catalogRevision === 'v1').map(row => ({ ...structuredClone(row), catalogRevision: 'custom-v2' }))
  const resolved = resolveCatalog('KEY', custom)
  const selected = captureSelection(resolved, {
    id: 'custom-low', revision: 'v2', agentPreset: 'standard', auxiliaries: {},
    topology: { kind: 'low', lead: { catalogRevision: 'custom-v2', presetId: 'Sol' },
      executor: { catalogRevision: 'custom-v2', presetId: 'Haiku' },
      upgrades: ['Sonnet', 'Opus'].map(presetId => ({ catalogRevision: 'custom-v2', presetId })) },
  })
  expect(selected.upgrades.map(row => row.presetId)).toEqual(['Sonnet', 'Opus'])
})

it('single-agent completion retains the sole participant and rejects a second authority', () => {
  const definition = { id: 'single', revision: 'v1', agentPreset: 'standard', auxiliaries: {},
    topology: { kind: 'single' as const, participant: ref('Astra') } }
  const selected = captureSelection(catalog, definition)
  expect(selected.authority).toEqual({ decider: 'participant', takeover: null })
  expect(selected.roles.decider).toEqual(selected.roles.participant)
  expect(selected.roles.takeover).toBeUndefined()
  expect(() => captureSelection(catalog, { ...definition, decider: ref('Fable') })).toThrow('topology')
  expect(() => captureSelection(catalog, { ...definition, takeover: ref('Astra') })).toThrow('topology')
})
