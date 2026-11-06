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
  '@deepseek-ai/dsh-experimental-context-index',
  '@deepseek-ai/dsh-experimental-context-map',
  '@deepseek-ai/dsh-experimental-context-tree',
]
const PROFILE = '@deepseek-ai/dsh-experimental-context-profile'

describe('Context tree profile bundle', () => {
  it('declares an unlisted parseable layer that mounts the index, the tree, the map and their tools and shrinks the eager core', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      private?: boolean
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string; listedByDefault?: boolean } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.dsh?.bundle).toEqual({ patch: './cordis.patch.yml', listedByDefault: false })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(SERVICES)

    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as {
      id?: string
      config?: { maxBytes?: number }
      insert?: { id?: string; name?: string }[]
    }[]
    const instructions = parsed.find(patch => patch.id === 'agent-instructions')
    expect(instructions?.config?.maxBytes).toBe(4096)
    expect(parsed.flatMap(patch => patch.insert ?? []).map(entry => [entry.id, entry.name])).toEqual([
      ['context-index', SERVICES[0]],
      ['context-tree', SERVICES[2]],
      ['tool-context-tree', `${PROFILE}/context-tree-tools`],
      ['context-map', SERVICES[1]],
      ['tool-context-map', `${PROFILE}/context-map-tools`],
      ['context-curator', `${PROFILE}/context-curator`],
    ])
  })

  it('exports the tools class as the default export the Loader mounts', async () => {
    const module = await import('../src/context-tree-tools.ts')
    expect(module.default.name).toBe('ContextTreeTools')
    expect(Object.keys(module)).toEqual(['default'])
  })

  it('exports the map tools and the default curator as the default exports the Loader mounts', async () => {
    const tools = await import('../src/context-map-tools.ts')
    expect(tools.default.name).toBe('ContextMapTools')
    expect(Object.keys(tools)).toEqual(['default'])
    const curator = await import('../src/context-curator.ts')
    expect(curator.default.name).toBe('DefaultContextCurator')
    expect(Object.keys(curator)).toEqual(['default'])
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
      for (const name of [...SERVICES, PROFILE]) {
        expect(text, `${file} must not mount ${name}`).not.toContain(name)
      }
    }
  })
})
