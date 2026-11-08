/** Catalog metadata supports embedding callers without deployment normalization. */
import { expect, it } from 'vitest'
import { assessControls, assessControlsEarly, catalogModelInfo } from '../src/model-info.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { PUBLIC_BASE_URL, resolveAdapterOptions } from '../src/index.ts'

it('advertises a minimal model declaration as text input with its ID as the label', () => {
  expect(catalogModelInfo('deepseek-official', { id: 'embedded-model' })).toEqual({
    provider: 'deepseek-official', id: 'embedded-model', name: 'embedded-model', inputModalities: ['text'],
  })
})

it('advertises a listed badge beside the catalog entry', () => {
  const badge = { text: '1017', tone: 'info' } as const
  expect(catalogModelInfo('deepseek-official', { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, badge)).toEqual({
    provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', inputModalities: ['text'], badge,
  })
})

const OFFICIAL = resolveAdapterOptions({ baseURL: PUBLIC_BASE_URL })
const CUSTOM = resolveAdapterOptions({ baseURL: 'https://gateway.example.test/anthropic' })

it('assesses every supplied control and nothing else', () => {
  // Rationale for the changed expectation: this assertion once expected `temperature` supported beside
  // `reasoningEffort: high` on the default (official) connection. The official service ignores temperature
  // with thinking, so that verdict is now `unsupported`; the supported cases below keep the other controls
  // and the off-reasoning temperature covered.
  expect(assessControls(OFFICIAL, { reasoningEffort: ReasoningEffortId('off'), temperature: 0, maxTokens: 9, stop: ['END'] }).fields).toEqual({
    reasoningEffort: { kind: 'supported' },
    temperature: { kind: 'supported' },
    maxTokens: { kind: 'supported' },
    stop: { kind: 'supported' },
  })
  expect(assessControls(OFFICIAL, { reasoningEffort: ReasoningEffortId('high'), maxTokens: 9, stop: ['END'] }).fields).toEqual({
    reasoningEffort: { kind: 'supported' },
    maxTokens: { kind: 'supported' },
    stop: { kind: 'supported' },
  })
  expect(assessControls(OFFICIAL, {}).fields).toEqual({})
})

it.each(['low', 'high', 'max'])('refuses an official temperature with %s reasoning as reasoning-active', (effort) => {
  expect(assessControls(OFFICIAL, { reasoningEffort: ReasoningEffortId(effort), temperature: 0 }).fields).toEqual({
    reasoningEffort: { kind: 'supported' },
    temperature: { kind: 'unsupported', reason: 'reasoning-active' },
  })
})

it('falls back to the connection default reasoning when the call carries no effort', () => {
  expect(assessControls(OFFICIAL, { temperature: 0.5 }).fields.temperature).toEqual({ kind: 'unsupported', reason: 'reasoning-active' })
  expect(assessControls(resolveAdapterOptions({ reasoningEffort: 'off' }), { temperature: 0.5 }).fields.temperature).toEqual({ kind: 'supported' })
  expect(assessControls(resolveAdapterOptions({ thinking: 'disabled' }), { temperature: 0.5 }).fields.temperature).toEqual({ kind: 'supported' })
  expect(assessControls(resolveAdapterOptions({ reasoningEffort: 'max' }), { temperature: 0.5 }).fields.temperature)
    .toEqual({ kind: 'unsupported', reason: 'reasoning-active' })
})

it('reports a non-official origin as unverified with reasoning and supported without it', () => {
  expect(assessControls(CUSTOM, { reasoningEffort: ReasoningEffortId('high'), temperature: 0 }).fields.temperature)
    .toEqual({ kind: 'unverified', reason: 'protocol-unverified' })
  expect(assessControls(CUSTOM, { reasoningEffort: ReasoningEffortId('off'), temperature: 0 }).fields.temperature)
    .toEqual({ kind: 'supported' })
})

it.each([
  ['the default effort', {}, undefined],
  ['an explicit enabled effort', {}, 'high'],
  ['the maximum effort', { reasoningEffort: 'max' as const }, undefined],
])('refuses a temperature early on the official origin by %s', (_name, config, effort) => {
  const connection = resolveAdapterOptions({ baseURL: PUBLIC_BASE_URL, ...config })
  const controls = { temperature: 0.2, ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) } }
  expect(assessControlsEarly(connection, controls)?.fields.temperature).toEqual({ kind: 'unsupported', reason: 'reasoning-active' })
})

it('reads the connection default effort exactly as model resolution does', () => {
  const off = resolveAdapterOptions({ baseURL: PUBLIC_BASE_URL, reasoningEffort: 'off' })
  expect(assessControlsEarly(off, { temperature: 0.2 })?.fields.temperature).toEqual({ kind: 'supported' })
  const disabled = resolveAdapterOptions({ baseURL: PUBLIC_BASE_URL, thinking: 'disabled' })
  expect(assessControlsEarly(disabled, { temperature: 0.2 })?.fields.temperature).toEqual({ kind: 'supported' })
  expect(assessControlsEarly(OFFICIAL, { temperature: 0.2, reasoningEffort: ReasoningEffortId('off') })?.fields.temperature)
    .toEqual({ kind: 'supported' })
})

it('leaves an effort the connection does not offer to model resolution', () => {
  const disabled = resolveAdapterOptions({ baseURL: PUBLIC_BASE_URL, thinking: 'disabled' })
  expect(assessControlsEarly(disabled, { temperature: 0.2, reasoningEffort: ReasoningEffortId('high') })).toBeUndefined()
  expect(assessControlsEarly(OFFICIAL, { temperature: 0.2, reasoningEffort: ReasoningEffortId('ultra') })).toBeUndefined()
})

it('reports a custom origin as unverified, never as an early refusal', () => {
  const custom = resolveAdapterOptions({ baseURL: 'https://gateway.example.test/anthropic' })
  expect(assessControlsEarly(custom, { temperature: 0.2 })?.fields.temperature).toEqual({ kind: 'unverified', reason: 'protocol-unverified' })
})

it('assesses only the supplied controls', () => {
  expect(assessControlsEarly(OFFICIAL, {})?.fields).toEqual({})
  expect(assessControlsEarly(OFFICIAL, { maxTokens: 9, stop: ['END'] })?.fields).toEqual({ maxTokens: { kind: 'supported' }, stop: { kind: 'supported' } })
})
