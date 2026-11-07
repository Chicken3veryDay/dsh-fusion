import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { prepareLinuxTerminalScope } from '../src/linux-scope.ts'

it('queries the scope immediately after a signal even when a populated event is pending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-scope-signal-'))
  writeFileSync(join(root, 'cgroup.controllers'), 'pids\n')
  const watcher = new class extends EventEmitter { close(): void {} }()
  let final = false
  let sleeps = 0
  const firstSleep = Promise.withResolvers<undefined>()
  const nextSleep = Promise.withResolvers<undefined>()
  const tick = Promise.withResolvers<undefined>()
  const direct = Promise.withResolvers<undefined>()
  const query = vi.fn(async (_command: string, args: readonly string[]) => ({
    status: 0,
    stdout: `LoadState=loaded\nActiveState=${final ? 'inactive' : 'active'}\nTasksCurrent=1\n${args.includes('--property=ControlGroup') ? 'ControlGroup=/review.scope\n' : ''}`,
    stderr: '',
  }))
  const scope = prepareLinuxTerminalScope({
    argv: ['tool'], cwd: process.cwd(), rows: 24, cols: 80,
    terminalType: 'dumb', graceMs: 5_000,
  }, {}, [], {
    runnerInvocation: [process.execPath, '/unused-runner.js'],
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })) as never,
    cgroupRoot: root,
    watchFile: () => watcher,
    readFile: () => 'populated 1\nfrozen 0\n',
    systemctlQuery: query,
    sleep: () => {
      sleeps += 1
      if (sleeps === 1) firstSleep.resolve(undefined)
      else nextSleep.resolve(undefined)
      return tick.promise
    },
  })
  const owner = scope.bindOwner({ running: () => !final, signal: () => true, settled: direct.promise })
  const waiting = owner.waitForExit()
  try {
    await firstSleep.promise
    watcher.emit('change')
    owner.signal('SIGTERM')
    await nextSleep.promise
    expect(query).toHaveBeenCalledTimes(2)
  } finally {
    final = true
    direct.resolve(undefined)
    tick.resolve(undefined)
    await waiting
    owner.cleanup?.()
    rmSync(root, { recursive: true, force: true })
  }
})
