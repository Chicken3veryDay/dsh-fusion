/**
 * Review r1 m1: a binding whose wire id is absent from its provider profile's `models` list is
 * reported as `unsupported-effort`, which points the operator at effort declarations instead of the
 * missing model row.
 */
import { afterEach, expect, it } from 'vitest'
import { configuration, harness } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it('does not report a model missing from the provider profile as an effort problem', async () => {
  const config = configuration('http://127.0.0.1:1')
  const openai = config.providers['omniroute-openai']!
  openai.models = openai.models.filter(row => row.id !== 'cx/gpt-6-astra')
  const app = await harness(config)
  cleanups.push(() => app.dispose())
  const report = await app.ctx.fusionConfig.preflight('test-pair')
  const astra = report.bindings.find(row => row.binding.presetId === 'Astra')
  expect(astra?.structural).toBe('blocked')
  expect(astra?.code).not.toBe('unsupported-effort')
})
