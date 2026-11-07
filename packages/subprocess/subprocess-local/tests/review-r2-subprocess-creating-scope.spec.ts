import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { launchLinuxScope } from '../src/linux-scope.ts'
import type { LinuxScopeInternals } from '../src/linux-scope.ts'
import { linuxLaunchFilesFromLocator } from '../src/runner-protocol.ts'
import { SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'
import { bindManagedProcess } from '../src/spawn.ts'

class FakeChild extends EventEmitter {
  pid: number | undefined = 321
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdio = [this.stdin, this.stdout, this.stderr]
}

const directories: string[] = []
beforeEach(() => { vi.spyOn(process, 'kill').mockImplementation(() => true) })
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const missingUnit = { status: 1, stdout: '', stderr: 'Unit dsh.scope could not be found.' }
// systemd reports a transient scope this way after StartTransientUnit created it and before its start job ran.
const creatingUnit = { status: 0, stdout: 'LoadState=loaded\nActiveState=inactive\nTasksCurrent=[not set]\nControlGroup=\n', stderr: '' }
const runningUnit = { status: 0, stdout: 'LoadState=loaded\nActiveState=active\nTasksCurrent=1\nControlGroup=/dsh.slice/x.scope\n', stderr: '' }

function idleSleeper() {
  let count = 0
  const pending: Array<() => void> = []
  const reached: Array<{ count: number; resolve: () => void }> = []
  return {
    sleep: (_delayMs: number, signal?: AbortSignal): Promise<void> => {
      count += 1
      for (const waiter of reached) if (waiter.count <= count) waiter.resolve()
      return new Promise<void>((resolve) => {
        pending.push(resolve)
        signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
    reached: (target: number): Promise<void> => new Promise((resolve) => {
      if (count >= target) resolve()
      else reached.push({ count: target, resolve })
    }),
    elapse: (): void => { pending.at(-1)?.() },
  }
}

function creatingScope() {
  const states = [missingUnit, creatingUnit]
  const sleeper = idleSleeper()
  const child = new FakeChild()
  const spawnSync = vi.fn((_command: string, _args: readonly string[]) => ({ status: 0, stdout: '', stderr: '' }))
  let requestPath: string | undefined
  const request = {
    argv: ['tool'],
    cwd: '/target',
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 100,
  } as const
  const internals: LinuxScopeInternals = {
    spawn: ((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      requestPath = options.env[SUBPROCESS_RUNNER_ENV]
      return child
    }) as never,
    spawnSync: spawnSync as never,
    systemctlQuery: async () => states.shift() ?? runningUnit,
    systemdRun: '/bin/systemd-run',
    systemctl: '/bin/systemctl',
    runnerInvocation: ['/usr/bin/node', '/runner.js'],
    sleep: sleeper.sleep,
  }
  const launch = launchLinuxScope(request, {}, ['--expand-environment=no'], internals)
  if (requestPath === undefined) throw new Error('launch did not publish a request locator')
  directories.push(linuxLaunchFilesFromLocator(requestPath).directory)
  const handle = bindManagedProcess(request, launch)
  return { handle, launch, sleeper, spawnSync }
}

const killCalls = (spawnSync: ReturnType<typeof creatingScope>['spawnSync']): number =>
  spawnSync.mock.calls.filter(([, args]) => args.includes('kill')).length

it('keeps waiting when a creating scope reads loaded/inactive while its launcher runs and its request is unconsumed', async () => {
  const { handle, sleeper } = creatingScope()
  const waiting = handle.waitForExit()
  await sleeper.reached(1)
  sleeper.elapse()
  // The target has not been placed yet: the bootstrap still holds its launch request.
  const first = await Promise.race([
    waiting.then(() => 'range reported empty' as const),
    sleeper.reached(2).then(() => 'still waiting' as const),
  ])
  expect(first).toBe('still waiting')
})

it('still terminates the range after a range wait met the creating scope', async () => {
  const { handle, launch, sleeper, spawnSync } = creatingScope()
  void handle.waitForExit()
  await sleeper.reached(1)
  sleeper.elapse()
  await Promise.race([handle.waitForExit(), sleeper.reached(2)])
  handle.terminate()
  expect(killCalls(spawnSync)).toBe(1)
  launch.owner.terminateForHostExit()
  expect(killCalls(spawnSync)).toBe(2)
})
