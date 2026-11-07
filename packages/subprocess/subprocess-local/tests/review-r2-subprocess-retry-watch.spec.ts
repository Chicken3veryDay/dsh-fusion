import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { launchLinuxScope } from '../src/linux-scope.ts'
import { consumeLinuxLaunchRequest, linuxLaunchFilesFromLocator } from '../src/runner-protocol.ts'
import { SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'

class FakeChild extends EventEmitter {
  pid: number | undefined = 321
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdio = [this.stdin, this.stdout, this.stderr]
}

class FakeWatcher extends EventEmitter {
  closed = 0
  close(): void { this.closed += 1 }
}

const directories: string[] = []
beforeEach(() => { vi.spyOn(process, 'kill').mockImplementation(() => true) })
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const GROUP = '/dsh.slice/dsh-subprocess-retry.scope'
const running = { status: 0, stdout: `LoadState=loaded\nActiveState=active\nTasksCurrent=1\nControlGroup=${GROUP}\n`, stderr: '' }
// A transient manager failure (for example a 5 s systemctl timeout under load) rejects one observation.
const managerFailure = { status: 1, stdout: '', stderr: 'Failed to connect to bus: Connection timed out' }

it('re-attaches or reports the cgroup watch when a range wait is retried after a failed observation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-review-cgroup-'))
  directories.push(root)
  writeFileSync(join(root, 'cgroup.controllers'), 'pids\n')
  mkdirSync(join(root, GROUP), { recursive: true })
  writeFileSync(join(root, GROUP, 'cgroup.events'), 'populated 1\nfrozen 0\n')
  const states = [running, managerFailure]
  const watchers: FakeWatcher[] = []
  const reports: string[] = []
  let sleeps = 0
  const reached: Array<{ count: number; resolve: () => void }> = []
  const pending: Array<() => void> = []
  const atSleep = (count: number): Promise<void> => new Promise((resolve) => {
    if (sleeps >= count) resolve()
    else reached.push({ count, resolve })
  })
  let requestPath: string | undefined
  const launch = launchLinuxScope({
    argv: ['tool'], cwd: '/target', stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100,
  }, {}, ['--expand-environment=no'], {
    spawn: ((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      requestPath = options.env[SUBPROCESS_RUNNER_ENV]
      return new FakeChild()
    }) as never,
    spawnSync: (() => ({ status: 0, stdout: '', stderr: '' })) as never,
    systemctlQuery: async () => states.shift() ?? running,
    systemdRun: '/bin/systemd-run',
    systemctl: '/bin/systemctl',
    runnerInvocation: ['/usr/bin/node', '/runner.js'],
    cgroupRoot: root,
    watchFile: () => { const watcher = new FakeWatcher(); watchers.push(watcher); return watcher },
    reportDegraded: (message) => { reports.push(message) },
    sleep: (_delayMs, signal) => {
      sleeps += 1
      for (const waiter of reached) if (waiter.count <= sleeps) waiter.resolve()
      return new Promise<void>((resolve) => {
        pending.push(resolve)
        signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
  })
  if (requestPath === undefined) throw new Error('no request locator')
  directories.push(linuxLaunchFilesFromLocator(requestPath).directory)
  consumeLinuxLaunchRequest(requestPath)

  const first = launch.owner.waitForExit()
  await atSleep(1)
  expect(watchers).toHaveLength(1)
  pending.at(-1)?.()
  await expect(first).rejects.toThrow('could not read')
  expect(watchers[0]?.closed).toBe(1)

  // The handle retries (spawn.ts before settlement, terminal.ts closeManagedRange after a failure).
  void launch.owner.waitForExit().catch(() => {})
  await atSleep(2)
  // The retried observation must either watch the scope again or report that it no longer does.
  expect({ watchers: watchers.length, reports: reports.length }).not.toEqual({ watchers: 1, reports: 0 })
  launch.owner.terminateForHostExit()
})
