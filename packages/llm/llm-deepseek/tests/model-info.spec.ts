/** Catalog metadata supports embedding callers without deployment normalization. */
import { expect, it } from 'vitest'
import { assessControls, catalogModelInfo } from '../src/model-info.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

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

it('assesses every supplied control as supported and nothing else', () => {
  expect(assessControls({ reasoningEffort: ReasoningEffortId('high'), temperature: 0, maxTokens: 9, stop: ['END'] }).fields).toEqual({
    reasoningEffort: { kind: 'supported' },
    temperature: { kind: 'supported' },
    maxTokens: { kind: 'supported' },
    stop: { kind: 'supported' },
  })
  expect(assessControls({}).fields).toEqual({})
})
