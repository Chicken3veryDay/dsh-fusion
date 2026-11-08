/** Catalog metadata supports embedding callers without deployment normalization. */
import { expect, it } from 'vitest'
import { assessControls, catalogModelInfo } from '../src/model-info.ts'
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
