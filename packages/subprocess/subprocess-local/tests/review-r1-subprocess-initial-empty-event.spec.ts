import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { prepareLinuxTerminalScope } from '../src/linux-scope.ts'

it.each([
  { name: 'frozen-only event before any payload', initial: '0', after: '0', frozen: '1' },
  { name: 'setup helper exit before payload attachment', initial: '1', after: '0', frozen: '0' },
  { name: 'frozen-only event with a populated group (control)', initial: '1', after: '1', frozen: '1' },
] as const)('keeps startup ownership after $name', async ({ initial, after, frozen }) => {
  const root = mkdtempSync(join(tmpdir(), 'review-scope-empty-'))
  const group = '/review.scope'
  mkdirSync(join(root, group))
  writeFileSync(join(root, 'cgroup.controllers'), 'pids\n')
  const eventsPath = join(root, group, 'cgroup.events')
  writeFileSync(eventsPath, `populated ${initial}\nfrozen 0\n`)
  let final = false
  let count = 0
  const firstSleep = Promise.withResolvers<undefined>()
  const nextSleep = Promise.withResolvers<undefined>()
  const tick = Promise.withResolvers<undefined>()
  const direct = Promise.withResolvers<undefined>()
  const systemctl = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
  const scope = prepareLinuxTerminalScope({
    argv: ['tool'], cwd: process.cwd(), rows: 24, cols: 80,
    terminalType: 'dumb', graceMs: 5_000,
  }, {}, [], {
    runnerInvocation: [process.execPath, '/unused-runner.js'],
    spawnSync: systemctl as never,
    cgroupRoot: root,
    systemctlQuery: async () => ({
      status: 0,
      stdout: `LoadState=loaded\nActiveState=${final ? 'inactive' : 'activating'}\nTasksCurrent=${initial}\nControlGroup=${group}\n`,
      stderr: '',
    }),
    sleep: () => {
      count += 1
      if (count === 1) firstSleep.resolve(undefined)
      else nextSleep.resolve(undefined)
      return tick.promise
    },
  })
  const owner = scope.bindOwner({ running: () => !final, signal: () => true, settled: direct.promise })
  const waiting = owner.waitForExit()
  try {
    await firstSleep.promise
    // A delegated scope's setup helper enters the cgroup before the final launcher does.
    // cgroup.events also notifies when only the frozen field changes.
    writeFileSync(eventsPath, `populated ${after}\nfrozen ${frozen}\n`)
    const state = await Promise.race([
      waiting.then(() => 'empty'),
      nextSleep.promise.then(() => 'waiting'),
    ])
    owner.signal('SIGTERM')
    expect({ state, deliveredSignals: systemctl.mock.calls.length }).toEqual({ state: 'waiting', deliveredSignals: 1 })
  } finally {
    final = true
    direct.resolve(undefined)
    tick.resolve(undefined)
    await waiting
    owner.cleanup?.()
    rmSync(root, { recursive: true, force: true })
  }
})
