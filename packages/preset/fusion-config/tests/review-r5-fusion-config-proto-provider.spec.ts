/** A provider declared under the `__proto__` record key bypasses the strict provider schema. */
import { dump, load } from 'js-yaml'
import { expect, it, onTestFinished } from 'vitest'
import FusionConfig from '../src/index.ts'
import { configuration, harness } from './harness.ts'

/** Same document with an extra provider whose body violates every provider rule. */
function protoDocument() {
  const config = configuration('http://127.0.0.1:1')
  const providers = JSON.parse(JSON.stringify(config.providers)) as Record<string, unknown>
  Object.defineProperty(providers, '__proto__', {
    value: { api: 'openai-completions', transport: 'auto', headers: { 'x-review': 'excluded' }, apiKey: 'inline' },
    enumerable: true, configurable: true, writable: true,
  })
  return { ...config, providers }
}

it('control: the same invalid provider body under an ordinary key is refused', async () => {
  const app = await harness()
  onTestFinished(() => app.dispose())
  const config = configuration('http://127.0.0.1:1')
  const document = { ...config, providers: { ...config.providers, extra: protoDocument().providers.__proto__ } }
  expect(Object.keys(protoDocument().providers)).toContain('__proto__')
  expect(() => new FusionConfig(app.ctx, { document })).toThrow('invalid-configuration')
})

it('constructor refuses an invalid provider declared under __proto__', async () => {
  const app = await harness()
  onTestFinished(() => app.dispose())
  let refused = ''
  try { new FusionConfig(app.ctx, { document: protoDocument() }) } catch (error) { refused = String(error) }
  expect(refused).toContain('invalid-configuration')
})

it('Loader YAML refuses an invalid provider declared under __proto__', async () => {
  const app = await harness()
  onTestFinished(() => app.dispose())
  const yaml = dump(protoDocument())
  expect(yaml).toContain('__proto__')
  const document = load(yaml)
  expect(Object.keys(document as object)).toContain('providers')
  const entry: Parameters<typeof app.ctx.loader.create>[0] & { id: string } = { name: 'cordis:fusion', id: 'fusion', config: { document } }
  await app.ctx.loader.create(entry)
  await app.ctx.loader.await()
  expect(app.ctx.get('fusionConfig') === undefined).toBe(true)
})
