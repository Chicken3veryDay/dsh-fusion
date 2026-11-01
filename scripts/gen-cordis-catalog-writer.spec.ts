/** Writer reservation signatures link to their owning persistence reference. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { renderPageRegion } from '@deepseek-ai/dsh-typert-generator'
import { CORDIS_CATALOG_POLICY } from './gen-cordis-catalog.ts'

it('renders linked reservation/result/reason types with existing reference targets', () => {
  const types = ['WriterLifetimeReservation', 'SessionWriterReservation', 'WriterLifetimeFlush', 'WriterLifetimeReason']
  const rendered = renderPageRegion('core.md', [{
    key: 'writerFixture', type: 'Fixture', abstract: true, doc: '', source: 'fixture.ts:1',
    methods: types.map(type => ({ signature: `read(): ${type}`, jsDoc: '' })),
  }], [], CORDIS_CATALOG_POLICY)
  const reference = readFileSync(new URL('../docs/subsystems/persistence.md', import.meta.url), 'utf8')
  for (const type of types) {
    expect(rendered).toContain(`[${type}](persistence.md)`)
    expect(reference).toContain(`id="${type.toLowerCase()}"`)
  }
})
