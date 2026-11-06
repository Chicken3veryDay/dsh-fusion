/**
 * Real-composition proof: the layer applied over the shipped headless profile boots through the
 * Cordis Loader in a `dsh` process. A scripted keyless model shows that a hidden tool is absent from
 * the first request, present in the request after `context_load`, and absent again after compaction,
 * and that every catalog, activation, and the stub that replaces it is in the persisted Session log.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const dshBinScript = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const fixtureUrl = (name: string): string => pathToFileURL(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))).href
const scriptPlugin = fixtureUrl('context-script-llm.mjs')
const mapScriptPlugin = fixtureUrl('context-map-script-llm.mjs')
const PROFILE = '@deepseek-ai/dsh-experimental-context-profile'
const BASE = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']

interface MapRequest {
  readonly curator: boolean
  readonly auxiliary: boolean
  readonly model: string
  readonly effort: string | null
  readonly tools: string[]
  readonly bytes: number
  readonly hasNote: boolean
  readonly hasGroupTitle: boolean
  readonly hasCuratorText: boolean
}

interface Request {
  readonly tools: string[]
  readonly hasCatalog: boolean
  readonly catalogIsUpdate: boolean
  readonly hasActivation: boolean
  readonly hasGrant: boolean
  readonly hasStub: boolean
}

interface LogEvent {
  readonly type: string
  readonly data?: { readonly source?: { readonly kind?: string }; readonly op?: { readonly kind?: string } }
}

async function sessionFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await sessionFiles(path))
    else if (entry.name === 'session.v4.jsonl') found.push(path)
  }
  return found
}

/** Launch `dsh --profile headless` with the given bundle list; return the recorded requests and logged source kinds. */
async function run(
  bundles: readonly string[],
  options: { readonly script?: string; readonly prompt?: string; readonly ok?: string } = {},
): Promise<{ requests: Request[]; mapRequests: MapRequest[]; sources: string[]; sessions: LogEvent[][] }> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-context-profile-'))
  try {
    const home = join(cwd, '.dsh')
    const profileDir = join(home, 'profiles', 'headless')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-headless',
      private: true,
      dependencies: Object.fromEntries(bundles.filter(bundle => bundle === PROFILE).map(bundle => [bundle, 'workspace:^'])),
      dsh: { profile: { bundles } },
    }, undefined, 2) + '\n')
    await writeFile(join(profileDir, 'cordis.patch.yml'), [
      '- id: llm-deepseek',
      '  disabled: true',
      '- id: session-persistence-jsonl',
      '  config:',
      `    root: '${join(home, 'sessions')}'`,
      '    compression: none',
      '- id: compaction-basic',
      '  config:',
      '    thresholdRatio: 0.8',
      '    headroomTokens: 1800',
      '    retainTokens: 20',
      '- insert:',
      '    - id: context-script-llm',
      `      name: '${options.script ?? scriptPlugin}'`,
      '',
    ].join('\n'))
    const output = join(cwd, 'requests.json')
    const launch = resolveExampleLaunch({
      srcBin: dshBinScript,
      configArgs: ['--profile', 'headless', options.prompt ?? 'Probe the context tree.'],
      tsconfigPath,
      env: {
        DSH_HOME: home,
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: '',
        CONTEXT_PROBE_OUT: output,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          '--disable-warning=ExperimentalWarning',
          '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        ].filter(Boolean).join(' '),
      },
    })
    const result = await execa(launch.command, launch.args, {
      cwd, env: launch.env, input: '', timeout: 120_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.exitCode, `dsh exited unexpectedly.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain(options.ok ?? 'CONTEXT_PROBE_OK')
    const sources: string[] = []
    const sessions: LogEvent[][] = []
    for (const file of await sessionFiles(join(home, 'sessions'))) {
      const events = (await readFile(file, 'utf8')).split('\n').filter(entry => entry.length > 0).map(line => JSON.parse(line) as LogEvent)
      sessions.push(events)
      for (const event of events) {
        if (event.type === 'user/message' && event.data?.source?.kind !== undefined) sources.push(event.data.source.kind)
      }
    }
    const recorded: unknown = JSON.parse(await readFile(output, 'utf8'))
    return { requests: recorded as Request[], mapRequests: recorded as MapRequest[], sources, sessions }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

const PROBES = ['probe_alpha', 'probe_beta']
const hasProbe = (request: Request): boolean => PROBES.some(tool => request.tools.includes(tool))

describe('Context tree profile layer through the real Loader', () => {
  it('hides a tool until context_load, shows it on the next request, and hides it again after compaction', async () => {
    const { requests, sources } = await run([...BASE, PROFILE])
    const [first, loaded, probed] = requests as [Request, Request, Request]

    expect(hasProbe(first)).toBe(false)
    expect(first.tools).toEqual(expect.arrayContaining(['context_browse', 'context_load', 'read', 'bash']))
    expect(first.hasCatalog).toBe(true)
    expect(first.catalogIsUpdate).toBe(false)

    // The very next request after context_load already declares the tools.
    expect(PROBES.every(tool => loaded.tools.includes(tool))).toBe(true)
    expect(loaded.hasActivation).toBe(true)
    // Activated tools keep the same position on the following request: cache-stable.
    expect(probed.tools).toEqual(loaded.tools)

    // Compaction runs in a pre-step, after that step's tool set is resolved: the request it lands in
    // already has the activation replaced by its stub and the tree republished, and the declarations
    // follow one step later.
    const compacted = requests.findIndex((request, index) => index > 1 && !request.hasActivation)
    expect(compacted).toBeGreaterThan(2)
    expect(requests.slice(2, compacted).every(request => request.hasActivation)).toBe(true)
    expect(requests[compacted]!.hasStub).toBe(true)
    expect(requests[compacted]!.hasCatalog).toBe(true)
    expect(requests[compacted]!.catalogIsUpdate).toBe(true)
    const after = requests.slice(compacted + 1)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every(request => !hasProbe(request) && request.hasStub)).toBe(true)
    expect(after[0]!.tools).toEqual(first.tools)

    expect(sources).toEqual(expect.arrayContaining(['context-tree-catalog', 'context-activation']))
  }, 180_000)

  it('keeps map curation out of the conversation: the Session logs the map edits, the curator transcript stays in its own Session', async () => {
    const { mapRequests: requests, sessions } = await run([...BASE, PROFILE], {
      script: mapScriptPlugin, prompt: 'Probe the project map.', ok: 'MAP_PROBE_OK',
    })
    const main = requests.filter(request => !request.curator && !request.auxiliary)
    const curator = requests.filter(request => request.curator)

    // The working agent sees the one bounded note tool and none of the curator tools.
    expect(main).toHaveLength(4)
    for (const request of main) {
      expect(request.tools).toContain('context_note')
      expect(request.tools.filter(tool => tool.startsWith('map_'))).toEqual([])
      expect(request.hasCuratorText).toBe(false)
      expect(request.model).not.toBe('curator-small')
    }
    // The curator ran on the smaller route at its least effort, with the curator tools only it holds.
    expect(curator.length).toBeGreaterThanOrEqual(3)
    for (const request of curator) {
      expect(request.model).toBe('curator-small')
      expect(request.effort).toBe('low')
      expect(request.tools).toEqual(expect.arrayContaining(['map_view', 'map_group', 'map_note', 'map_core']))
    }

    // The main context grows by the exchanged tool calls and results only: the curator's own
    // conversation (its prompt, map_view results, edits) is several times larger and never joins it.
    const growth = main[3]!.bytes - main[0]!.bytes
    expect(growth).toBeLessThan(1500)
    expect(main.every(request => request.bytes < curator[0]!.bytes)).toBe(true)

    // Durable: the main Session carries the logged map edits and no curator conversation.
    const logs = sessions.map(events => ({ events, edits: events.filter(event => event.type === 'context-map/state') }))
    const mainLog = logs.filter(log => log.edits.length > 0)
    expect(mainLog).toHaveLength(1)
    const ops = mainLog[0]!.edits.map(event => event.data?.op?.kind)
    expect(ops).toEqual(expect.arrayContaining(['note-pending', 'claim', 'group-set', 'note-file']))
    expect(JSON.stringify(mainLog[0]!.events)).not.toContain('project map curator')
    const curatorLog = logs.filter(log => log !== mainLog[0] && JSON.stringify(log.events).includes('project map curator'))
    expect(curatorLog).toHaveLength(1)
    expect(curatorLog[0]!.edits).toEqual([])
  }, 180_000)

  it('negative control: without the layer every tool is visible from the first request', async () => {
    const { requests, sources } = await run(BASE)
    expect(PROBES.every(tool => requests[0]!.tools.includes(tool))).toBe(true)
    expect(requests[0]!.tools).not.toContain('context_load')
    expect(requests[0]!.hasCatalog).toBe(false)
    expect(sources).not.toContain('context-tree-catalog')
  }, 180_000)
})
