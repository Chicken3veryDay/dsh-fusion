/**
 * Real-composition proof: the layer applied over the shipped headless profile boots through the
 * Cordis Loader in a `dsh` process, mounts the three services, and exposes their model tools.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const dshBinScript = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const probePlugin = pathToFileURL(fileURLToPath(new URL('./fixtures/tool-probe-llm.mjs', import.meta.url))).href
const PROFILE = '@deepseek-ai/dsh-experimental-workstream-profile'

/** Every model tool the three packages register; the oracle is each package's `defineTool` names. */
const TICKET_TOOLS = [
  'ticket_acknowledge_attention', 'ticket_answer', 'ticket_ask', 'ticket_assign', 'ticket_attention', 'ticket_block',
  'ticket_cancel', 'ticket_claim', 'ticket_close_question', 'ticket_complete', 'ticket_create', 'ticket_fail',
  'ticket_get', 'ticket_handoff', 'ticket_list', 'ticket_release', 'ticket_report', 'ticket_resolve_attention',
]
const WORKSTREAM_TOOLS = [
  'workstream_acknowledge', 'workstream_add_member', 'workstream_assign_ticket', 'workstream_create_ticket',
  'workstream_end_ticket', 'workstream_get', 'workstream_handoff', 'workstream_interrupt', 'workstream_list',
  'workstream_open', 'workstream_send', 'workstream_stop', 'workstream_wait',
]
const EVIDENCE_TOOLS = [
  'workstream_evidence_aggregate_prs', 'workstream_evidence_list', 'workstream_evidence_publish', 'workstream_evidence_read',
]
const EXPECTED_TOOLS = [...TICKET_TOOLS, ...WORKSTREAM_TOOLS, ...EVIDENCE_TOOLS]

interface Probe {
  readonly tools: string[]
  readonly mounted: Record<string, boolean>
}

/** Launch `dsh --profile headless` with the given bundle list and return what the model request carried. */
async function probe(bundles: readonly string[]): Promise<Probe> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-workstream-profile-'))
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
      '- insert:',
      '    - id: workstream-probe-llm',
      `      name: '${probePlugin}'`,
      '',
    ].join('\n'))
    const output = join(cwd, 'probe.json')
    const launch = resolveExampleLaunch({
      srcBin: dshBinScript,
      configArgs: ['--profile', 'headless', 'Report your tools.'],
      tsconfigPath,
      env: {
        DSH_HOME: home,
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: '',
        WORKSTREAM_PROBE_OUT: output,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          '--disable-warning=ExperimentalWarning',
          '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        ].filter(Boolean).join(' '),
      },
    })
    const result = await execa(launch.command, launch.args, {
      cwd, env: launch.env, input: '', timeout: 90_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.exitCode, `dsh exited unexpectedly.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('WORKSTREAM_PROBE_OK')
    return JSON.parse(await readFile(output, 'utf8')) as Probe
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

/** The assertion the layer must satisfy; the negative control proves it can fail. */
function expectWorkstreamLayer(seen: Probe): void {
  expect(seen.mounted).toMatchObject({ tickets: true, workstreams: true, workstreamEvidence: true })
  const visible = seen.tools.filter(tool => /^(ticket|workstream)_/u.test(tool)).sort()
  expect(visible).toEqual([...EXPECTED_TOOLS].sort())
}

describe('Workstream profile layer through the real Loader', () => {
  const base = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']

  it('mounts Ticket, Workstream, and Evidence services and shows their tools to the model', async () => {
    const seen = await probe([...base, PROFILE])
    expectWorkstreamLayer(seen)
    expect(seen.mounted.agentTeams).toBe(false)
    expect(seen.tools).not.toContain('spawn_teammate')
    expect(seen.tools.some(tool => tool.startsWith('team_task_'))).toBe(false)
  }, 120_000)

  it('negative control: the same probe without the layer fails the layer assertion', async () => {
    const seen = await probe(base)
    expect(seen.mounted).toEqual({ tickets: false, workstreams: false, workstreamEvidence: false, agentTeams: false })
    expect(seen.tools.filter(tool => /^(ticket|workstream)_/u.test(tool))).toEqual([])
    expect(() => { expectWorkstreamLayer(seen) }).toThrow()
  }, 120_000)
})
