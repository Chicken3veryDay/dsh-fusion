import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const GROUP = '/dsh.slice/dsh-subprocess-degraded.scope'
// systemd keeps reporting the scope active with a member for the whole test.
const running = { status: 0, stdout: `LoadState=loaded\nActiveState=active\nTasksCurrent=1\nControlGroup=${GROUP}\n`, stderr: '' }

it('observes range exit by polling systemctl only after reporting an unreadable cgroup.events, as the report says', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-review-r4-cgroup-'))
  directories.push(root)
  writeFileSync(join(root, 'cgroup.controllers'), 'pids\n')
  const watchers: FakeWatcher[] = []
  const reports: string[] = []
  let reads = 0
  let sleeps = 0
  const reached: Array<{ count: number; resolve: () => void }> = []
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
    systemctlQuery: async () => running,
    systemdRun: '/bin/systemd-run',
    systemctl: '/bin/systemctl',
    runnerInvocation: ['/usr/bin/node', '/runner.js'],
    cgroupRoot: root,
    watchFile: () => { const watcher = new FakeWatcher(); watchers.push(watcher); return watcher },
    // The first read fails with EACCES (reported as degraded); later reads succeed.
    readFile: () => {
      reads += 1
      if (reads === 1) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return 'populated 0\nfrozen 0\n'
    },
    reportDegraded: (message) => { reports.push(message) },
    sleep: (_delayMs, signal) => {
      sleeps += 1
      for (const waiter of reached) if (waiter.count <= sleeps) waiter.resolve()
      return new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
  })
  if (requestPath === undefined) throw new Error('no request locator')
  directories.push(linuxLaunchFilesFromLocator(requestPath).directory)
  consumeLinuxLaunchRequest(requestPath)

  let state = 'waiting'
  void launch.owner.waitForExit().then(() => { state = 'resolved' }, () => { state = 'rejected' })
  await atSleep(1)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain('range exit is observed by polling systemctl only')

  // After that report the watch should no longer decide anything; systemctl still says active.
  watchers[0]?.emit('change')
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  expect({ state, watcherClosed: watchers[0]?.closed }).toEqual({ state: 'waiting', watcherClosed: 1 })
  launch.owner.terminateForHostExit()
})
