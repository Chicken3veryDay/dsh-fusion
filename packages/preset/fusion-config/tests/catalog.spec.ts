import { describe, expect, it } from 'vitest'
import { bind, shippingCatalog, resolveCatalog, shippingSelections, captureSelection } from '../src/index.ts'
import type { ModelDefinition, SelectionDefinition } from '../src/index.ts'

const catalog = shippingCatalog('HOST_OMNIROUTE_KEY')
const reference = (presetId: string) => ({ catalogRevision: 'v1', presetId })
const base = shippingSelections('standard')[2]!

it('preserves all eight exact shipping identities and materializes both low-effort records', () => {
  expect(catalog.map(row => [
    row.catalogRevision, row.presetId, row.family, row.canonicalModelId,
    row.providerId, row.wireModelId, row.leadEffort, row.executorEffort,
  ])).toEqual([
    ['v1', 'Fable', 'Anthropic', 'claude-fable-5-1', 'omniroute-anthropic', 'cc/claude-fable-5-1', 'high', 'high'],
    ['v1', 'Astra', 'OpenAI', 'gpt-6-astra', 'omniroute-openai', 'cx/gpt-6-astra', 'high', 'high'],
    ['v1', 'Sol', 'OpenAI', 'gpt-6.1-sol', 'omniroute-openai', 'cx/gpt-6.1-sol', 'high', 'medium'],
    ['v1', 'Terra', 'OpenAI', 'gpt-6.1-terra', 'omniroute-openai', 'cx/gpt-6.1-terra', 'high', 'medium'],
    ['v1', 'Luna', 'OpenAI', 'gpt-6-luna', 'omniroute-openai', 'cx/gpt-6-luna', 'high', 'medium'],
    ['v1', 'Opus', 'Anthropic', 'claude-opus-5-5', 'omniroute-anthropic', 'cc/claude-opus-5-5', 'high', 'medium'],
    ['v1', 'Sonnet', 'Anthropic', 'claude-sonnet-5-5', 'omniroute-anthropic', 'cc/claude-sonnet-5-5', 'high', 'high'],
    ['v1', 'Haiku', 'Anthropic', 'claude-haiku-5-5', 'omniroute-anthropic', 'cc/claude-haiku-5-5', 'high', 'high'],
    ['low-effort-v1', 'Luna-low', 'OpenAI', 'gpt-6-luna', 'omniroute-openai', 'cx/gpt-6-luna', 'low', 'low'],
    ['low-effort-v1', 'Haiku-low', 'Anthropic', 'claude-haiku-5-5', 'omniroute-anthropic', 'cc/claude-haiku-5-5', 'low', 'low'],
  ])
  for (const row of catalog) {
    expect(row.adapterId).toBe('llm-pi-ai')
    expect(row.credentialRef).toBe('HOST_OMNIROUTE_KEY')
    expect(row.baseURL).toBe(row.family === 'OpenAI' ? 'http://127.0.0.1:20128/v1' : 'http://127.0.0.1:20128')
    expect(row.transport).toBe(row.family === 'OpenAI' ? 'openai-responses' : 'anthropic-messages')
    expect(Object.isFrozen(row)).toBe(true)
  }
  const low = bind(catalog, { catalogRevision: 'low-effort-v1', presetId: 'Haiku-low' }, 'lead')
  expect(low.effort).toBe('low')
  expect(Object.isFrozen(low)).toBe(true)
})

it('resolves defaults, alternatives, upgrades and unrestricted same-family decider roles', () => {
  const selections = shippingSelections('standard').map(row => captureSelection(catalog, row))
  expect(selections.map(row => [row.id, Object.fromEntries(Object.entries(row.roles).map(([role, binding]) => [role, `${binding.presetId}:${binding.effort}`])), row.upgrades.map(role => `${role.presetId}:${role.effort}`)])).toEqual([
    ['top', { userFacingLead: 'Astra:high', otherCoLead: 'Fable:high', executor: 'Sol:medium', decider: 'Astra:high', takeover: 'Astra:high' }, []],
    ['top-opus', { userFacingLead: 'Astra:high', otherCoLead: 'Fable:high', executor: 'Opus:medium', decider: 'Astra:high', takeover: 'Astra:high' }, []],
    ['middle', { lead: 'Astra:high', executor: 'Sonnet:high', decider: 'Astra:high', takeover: 'Astra:high' }, ['Opus:medium']],
    ['middle-fable-terra', { lead: 'Fable:high', executor: 'Terra:medium', decider: 'Fable:high', takeover: 'Fable:high' }, ['Sol:medium']],
    ['low', { lead: 'Sol:high', executor: 'Haiku:high', decider: 'Sol:high', takeover: 'Sol:high' }, ['Sonnet:high', 'Opus:medium']],
    ['low-opus-luna', { lead: 'Opus:high', executor: 'Luna:medium', decider: 'Opus:high', takeover: 'Opus:high' }, ['Terra:medium', 'Sol:medium']],
  ])
  const captured = captureSelection(catalog, { ...base, decider: reference('Sol'), takeover: reference('Astra'), auxiliaries: { title: reference('Haiku') } })
  expect(captured.roles.decider?.family).toBe(captured.roles.lead?.family)
  expect(captured.roles.takeover?.presetId).toBe('Astra')
  expect(Object.isFrozen(captured.roles)).toBe(true)
  expect(() => { Object.assign(captured.upgrades, { 0: captured.roles.executor }) }).toThrow()
})

describe('configuration admission guards', () => {
  it.each(['pair', 'upgrade', 'top', 'cycle', 'downgrade'] as const)('rejects invalid %s without provider-based family guesses', (which) => {
    const invalid: SelectionDefinition = structuredClone(base)
    if (which === 'top') invalid.topology = { kind: 'top', userFacingLead: reference('Astra'), otherCoLead: reference('Sol'), executor: reference('Haiku') }
    else invalid.topology = {
      kind: 'middle', lead: reference('Astra'), executor: reference(which === 'pair' ? 'Sol' : which === 'downgrade' ? 'Opus' : 'Sonnet'),
      upgrades: which === 'pair' ? [] : [reference(which === 'upgrade' ? 'Terra' : which === 'cycle' ? 'Sonnet' : which === 'downgrade' ? 'Sonnet' : 'Opus')],
    }
    expect(() => captureSelection(catalog, invalid)).toThrow('topology')
  })
  it('rejects missing identity and explicit effort substitution', () => {
    expect(() => bind(catalog, reference('Unknown'), 'lead')).toThrow('not-found')
    expect(() => bind(catalog, { ...reference('Sol'), effort: 'high' }, 'executor')).toThrow('effort')
  })
  it.each(['family', 'alias', 'reserved', 'opaque', 'duplicate'] as const)('rejects forged %s declarations', (which) => {
    const row: ModelDefinition = { ...structuredClone(catalog[0]!), catalogRevision: 'custom-v1' }
    if (which === 'family') row.family = 'OpenAI'
    if (which === 'alias') row.alias.canonicalModelId = 'gpt-6-astra'
    if (which === 'reserved') row.catalogRevision = 'v1'
    if (which === 'opaque') row.wireModelId = 'auto/fallback'
    expect(() => resolveCatalog('KEY', which === 'duplicate' ? [row, row] : [row])).toThrow('identity')
  })
  it('keeps family independent of gateway and captures custom revisions by value', () => {
    const row = { ...structuredClone(catalog[0]!), catalogRevision: 'custom-v1', providerId: 'an-openai-labelled-gateway' }
    const custom = resolveCatalog('KEY', [row])
    const result = bind(custom, { catalogRevision: 'custom-v1', presetId: 'Fable' }, 'lead')
    row.baseURL = 'http://changed.example'
    expect(result.family).toBe('Anthropic')
    expect(result.baseURL).toBe('http://127.0.0.1:20128')
  })
})

it('rejects a known-model downgrade after moving the bindings to a custom route revision', () => {
  const custom = catalog.filter(row => row.catalogRevision === 'v1').map(row => ({ ...structuredClone(row), catalogRevision: 'route-v2' }))
  const resolved = resolveCatalog('KEY', custom)
  expect(() => captureSelection(resolved, {
    id: 'bad-upgrade', revision: 'selection-v2', agentPreset: 'standard', auxiliaries: {},
    topology: { kind: 'middle', lead: { catalogRevision: 'route-v2', presetId: 'Astra' },
      executor: { catalogRevision: 'route-v2', presetId: 'Opus' }, upgrades: [{ catalogRevision: 'route-v2', presetId: 'Sonnet' }] },
  })).toThrow('topology')
})
