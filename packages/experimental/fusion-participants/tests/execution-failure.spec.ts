/** Sticky uncertainty is confined to child processes, with real post-exit lock recovery. */
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
const script = fileURLToPath(new URL('./fixtures/execution-failure.mjs', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
async function child(mode: string, root: string) {
  const plane = resolveExampleMode()
  const launch = resolveExampleLaunch({ srcBin: script, libBin: script, tsconfigPath: tsconfig,
    configArgs: [mode, join(root, 'sessions'), plane], env: { HOME: root, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents') } })
  const output = await run(launch.command, launch.args, { env: { ...process.env, ...launch.env }, timeout: 20000, maxBuffer: 100000 })
  return JSON.parse(output.stdout.trim().split('\n').at(-1) ?? '') as object
}

for (const mode of ['start', 'result', 'cleanup', 'detach', 'setup-release'] as const) {
  it(`retains an uncertain ${mode} writer until its process exits, then admits a fresh independent writer`, async () => {
    const root = await mkdtemp(join(tmpdir(), `fusion-failure-${mode}-`))
    const ctx = new Context()
    try {
      expect(await child(mode, root)).toEqual({ bodies: ['start', 'detach', 'setup-release'].includes(mode) ? 0 : 1, unknown: 1,
        blocked: true, independentWriter: 'denied', close: 'pending' })
      await ctx.plugin(Sessions)
      await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
      const writer = await ctx.sessionPersistence.open(SessionId('failure-child'), 'write')
      try { expect((await writer.read()).events.some(event => event.type === 'fusion/effect-started')).toBe(mode !== 'setup-release') }
      finally { await writer.close() }
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 30000)
}

it('recovers a cross-session start after a crash without replay and reconciles only independent evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-effect-crash-'))
  try {
    expect(await child('crash-effect', root)).toEqual({ bodies: 1, phase: 'after-effect', settlement: null })
    expect(await child('recover', root)).toEqual({ bodies: 0, observations: 0, unknown: 1, producer: null })
    expect(await child('reconcile', root)).toEqual({ bodies: 0, observations: 1, unknown: 0, producer: null })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)

for (const mode of ['reconcile-failure', 'reconcile-mismatch', 'reconcile-durability'] as const) {
  it(`retains failed ${mode} ownership and joins without retrying observation`, async () => {
    const root = await mkdtemp(join(tmpdir(), `fusion-${mode}-`))
    try {
      expect(await child('crash-effect', root)).toEqual({ bodies: 1, phase: 'after-effect', settlement: null })
      expect(await child(mode, root)).toEqual({ bodies: 0, observations: mode === 'reconcile-mismatch' ? 0 : 1,
        unknown: 1, producer: null, independentWriter: 'denied' })
      const ctx = new Context()
      try {
        await ctx.plugin(Sessions)
        await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
        const writer = await ctx.sessionPersistence.open(SessionId('failure-child'), 'write')
        await writer.close()
      } finally { await ctx.fiber.dispose() }
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60000)
}

it('retains task writers when transport drain fails with execution ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-drain-failure-'))
  try { expect(await child('drain', root)).toEqual({ bodies: 1, unknown: 0, blocked: true, independentWriter: 'denied' }) }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

for (const mode of ['history-root', 'history-grant', 'history-participant', 'history-missing-grant', 'history-run', 'history-attempt'] as const) {
  it(`blocks all writers on conflicting cross-session ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `fusion-${mode}-`))
    const ctx = new Context()
    try {
      expect(await child(mode, root)).toEqual({ bodies: 0, blocked: true, independentWriter: 'denied' })
      await ctx.plugin(Sessions)
      await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
      const writer = await ctx.sessionPersistence.open(SessionId('failure-child'), 'write')
      await writer.close()
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 30000)
}
