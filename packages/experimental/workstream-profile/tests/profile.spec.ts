/** The layer must be one parseable opt-in patch that no shipped default composition mounts. */

import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const root = fileURLToPath(new URL('..', import.meta.url))
const repo = resolve(root, '../../..')
const SERVICES = [
  '@deepseek-ai/dsh-experimental-ticket',
  '@deepseek-ai/dsh-experimental-workstream',
  '@deepseek-ai/dsh-experimental-workstream-evidence',
]

describe('Workstream profile bundle', () => {
  it('declares an unlisted parseable layer without Agent Team', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string; listedByDefault?: boolean } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.dsh?.bundle).toEqual({ patch: './cordis.patch.yml', listedByDefault: false })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(SERVICES)

    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    const inserted = (parsed as { insert?: { id?: string; name?: string }[] }[]).flatMap(patch => patch.insert ?? [])
    expect(inserted.map(entry => [entry.id, entry.name])).toEqual([
      ['tickets', SERVICES[0]],
      ['workstreams', SERVICES[1]],
      ['workstream-evidence', SERVICES[2]],
      ['tool-ticket', '@deepseek-ai/dsh-experimental-workstream-profile/ticket-tools'],
      ['tool-workstream', '@deepseek-ai/dsh-experimental-workstream-profile/workstream-tools'],
      ['tool-workstream-evidence', '@deepseek-ai/dsh-experimental-workstream-profile/workstream-evidence-tools'],
    ])
    expect(JSON.stringify(parsed)).not.toContain('agent-team')
  })

  it('exports each tool class as the default export the Loader mounts', async () => {
    const modules = await Promise.all([
      import('../src/ticket-tools.ts'),
      import('../src/workstream-tools.ts'),
      import('../src/workstream-evidence-tools.ts'),
    ])
    expect(modules.map(module => module.default.name)).toEqual(['TicketTools', 'WorkstreamTools', 'WorkstreamEvidenceTools'])
    for (const module of modules) expect(Object.keys(module)).toEqual(['default'])
  })

  it('stays out of every shipped bundle, preset, and CLI example composition', () => {
    const shipped = globSync([
      'packages/bundle/*/cordis.patch.yml',
      'packages/bundle/*/presets/*.yml',
      'apps/cli/config/**/*.yml',
    ], { cwd: repo })
    expect(shipped.length).toBeGreaterThan(0)
    for (const file of shipped) {
      const text = readFileSync(resolve(repo, file), 'utf8')
      for (const name of [...SERVICES, '@deepseek-ai/dsh-experimental-workstream-profile']) {
        expect(text, `${file} must not mount ${name}`).not.toContain(name)
      }
    }
  })
})
