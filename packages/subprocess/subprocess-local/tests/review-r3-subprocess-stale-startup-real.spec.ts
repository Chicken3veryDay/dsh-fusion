import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import type { SpawnOptions, SpawnSyncOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { launchLinuxScope, probeLinuxScope } from '../src/linux-scope.ts'
import { targetEnvironment } from '../src/runner-launch.ts'
import { bindManagedProcess } from '../src/spawn.ts'

const options = process.platform === 'linux' ? probeLinuxScope() : undefined

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await sleep(25)
  }
  throw new Error('expected live-systemd state was not reached')
}

function query(command: string, args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(command, [...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 10_000 }, (error, stdout, stderr) => {
    const code = error === null ? 0 : (error as NodeJS.ErrnoException).code
    resolve({ status: typeof code === 'number' ? code : null, stdout, stderr })
  }))
}

it.skipIf(options === undefined).each(['stale', 'fresh'] as const)('keeps a live target owned with a %s creating-scope response delivered after request consumption', async (response) => {
  const root = mkdtempSync(join(tmpdir(), 'review-r3-real-stale-'))
  const gate = `dsh-subprocess-review-r3-gate-${process.pid}-${Date.now()}.service`
  const release = join(root, 'release')
  const ready = join(root, 'ready')
  const pidFile = join(root, 'pid')
  let unit: string | undefined
  let launch: ReturnType<typeof launchLinuxScope> | undefined
  let handle: ReturnType<typeof bindManagedProcess> | undefined
  let waiting: Promise<boolean> | undefined
  let first = true
  let killCalls = 0
  const secondQuery = Promise.withResolvers<undefined>()
  try {
    execFileSync('systemd-run', [
      '--user', '--no-block', '--quiet', '--collect', `--unit=${gate}`, '--property=Type=oneshot',
      '--', '/bin/sh', '-c', 'touch "$1"; while [ ! -f "$2" ]; do sleep 0.05; done', 'sh', ready, release,
    ], { stdio: 'ignore', timeout: 10_000 })
    await until(() => existsSync(ready) ? true : undefined)
    const spec = {
      argv: ['/bin/sh', '-c', 'echo $$ > "$1"; exec sleep 120', 'sh', pidFile], cwd: root,
      stdio: { stdin: 'ignore' as const, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, graceMs: 5_000,
    }
    launch = launchLinuxScope(spec, targetEnvironment(spec), options ?? [], {
      spawn: ((command: string, args: readonly string[], settings: SpawnOptions) => {
        unit = `${args.find(arg => arg.startsWith('--unit='))?.slice('--unit='.length)}.scope`
        return spawn(command, [`--property=After=${gate}`, ...args], settings)
      }) as never,
      spawnSync: ((command: string, args: readonly string[], settings: SpawnSyncOptions) => {
        if (args.includes('kill')) killCalls += 1
        return spawnSync(command, args, settings)
      }) as never,
      systemctlQuery: async (command, args) => {
        if (!first) { secondQuery.resolve(undefined); return query(command, args) }
        first = false
        let snapshot = await query(command, args)
        const deadline = Date.now() + 30_000
        while (!(snapshot.stdout.includes('LoadState=loaded\n') && snapshot.stdout.includes('ActiveState=inactive\n'))) {
          if (Date.now() > deadline) throw new Error(`scope did not queue behind its gate: ${snapshot.stdout}`)
          await sleep(25)
          snapshot = await query(command, args)
        }
        // Keep the real pre-start response in flight while the launcher starts independently.
        writeFileSync(release, '')
        await until(() => existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : undefined)
        return response === 'fresh' ? query(command, args) : snapshot
      },
    })
    handle = bindManagedProcess(spec, launch)
    waiting = handle.waitForExit()
    const state = await Promise.race([
      waiting.then(() => 'empty'), secondQuery.promise.then(() => 'waiting'),
    ])
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    const targetAlive = process.kill(pid, 0)
    handle.terminate()
    launch.owner.terminateForHostExit()
    expect({ state, targetAlive, killCalls }).toEqual({ state: 'waiting', targetAlive: true, killCalls: 2 })
  } finally {
    writeFileSync(release, '')
    for (const owned of [unit, gate]) {
      if (owned === undefined) continue
      try { execFileSync('systemctl', ['--user', 'stop', owned], { stdio: 'ignore', timeout: 10_000 }) }
      catch (_alreadyCollected) { /* Only the test's uniquely named units are stopped. */ }
    }
    if (handle !== undefined) await Promise.allSettled([handle.done, waiting])
    launch?.owner.cleanup?.()
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
