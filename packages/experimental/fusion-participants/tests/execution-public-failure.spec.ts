/** Public fake hosts retain unknown reservations across retries and never replay effects after restart. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { resolveExampleLaunch, resolveExampleMode } from '../../../test-support/loader-smoke/src/index.ts'

const run = promisify(execFile)
const script = fileURLToPath(new URL('./execution-process.ts', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
interface Observation { rootId: string; participantId: string; bodies: number; requests: number }
async function child(mode: string, directory: string, rootId?: string): Promise<Observation> {
  const launch = resolveExampleLaunch({ srcBin: script, libBin: script, tsconfigPath: tsconfig,
    configArgs: [mode, directory, resolveExampleMode(), ...rootId === undefined ? [] : [rootId]],
    env: { DSH_HOME: join(directory, 'home'), DSH_AGENTS_HOME: join(directory, 'agents') } })
  const output = await run(launch.command, launch.args, { env: { ...process.env, ...launch.env }, timeout: 30000, maxBuffer: 100000 })
  return JSON.parse(output.stdout.trim().split('\n').at(-1) ?? '') as Observation
}

for (const phase of ['rollback', 'start', 'allocation-throw', 'cancel', 'cleanup', 'invoke-throw', 'uncertain', 'result'] as const) {
  it(`keeps public ${phase} uncertainty sticky and refuses independent writer acquisition`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `public-${phase}-`))
    try {
      const observed = await child(phase, directory)
      expect(observed).toMatchObject({ bodies: ['rollback', 'start', 'cancel', 'allocation-throw'].includes(phase) ? 0 : 1,
        requests: 0, unknown: phase === 'rollback' ? 0 : 1, blocked: true, independentWriter: 'denied' })
      const ctx = new Context()
      try {
        await ctx.plugin(Sessions)
        await ctx.plugin(Jsonl, { root: directory, compression: 'none' })
        const writer = await ctx.sessionPersistence.open(SessionId(observed.participantId), 'write')
        await writer.close()
      } finally { await ctx.fiber.dispose() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 60000)
}

it('recovers public crash facts into a fresh blocked incarnation with zero replay or inferred cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'public-crash-'))
  try {
    const crashed = await child('crash', directory)
    expect(crashed).toMatchObject({ bodies: 1, requests: 0 })
    const recovered = await child('recover', directory, crashed.rootId)
    expect(recovered).toMatchObject({ bodies: 0, registrations: 0, preparations: 0, requests: 0, unknown: 1, blocked: true })
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)

it('disposes the full public Loader fake-host composition without inference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'public-smoke-'))
  try { expect(await child('smoke', directory)).toMatchObject({ bodies: 1, cleanups: 1, requests: 0, disposed: true }) }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)
