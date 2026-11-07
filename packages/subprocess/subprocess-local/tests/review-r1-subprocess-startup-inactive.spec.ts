import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { prepareLinuxTerminalScope } from '../src/linux-scope.ts'
import { SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'

describe('review: a loaded unit before its start job runs', () => {
  it.each(['active', 'inactive'] as const)('keeps ownership while an unconsumed launcher is running and the first state is %s', async (initialState) => {
    let final = false
    const sleeping = Promise.withResolvers<undefined>()
    const tick = Promise.withResolvers<undefined>()
    const direct = Promise.withResolvers<undefined>()
    const signal = vi.fn(() => true)
    const systemctl = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
    const scope = prepareLinuxTerminalScope({
      argv: ['tool'], cwd: process.cwd(), rows: 24, cols: 80,
      terminalType: 'dumb', graceMs: 5_000,
    }, {}, [], {
      runnerInvocation: [process.execPath, '/unused-runner.js'],
      spawnSync: systemctl as never,
      systemctlQuery: async () => ({
        status: 0,
        stdout: `LoadState=loaded\nActiveState=${final ? 'inactive' : initialState}\nTasksCurrent=[not set]\n`,
        stderr: '',
      }),
      sleep: () => { sleeping.resolve(undefined); return tick.promise },
    })
    const owner = scope.bindOwner({ running: () => !final, signal, settled: direct.promise })
    const waiting = owner.waitForExit()
    try {
      const locator = scope.env[SUBPROCESS_RUNNER_ENV]
      expect(locator).toBeDefined()
      expect(existsSync(locator!)).toBe(true)
      // The owned launcher has not consumed the request and can still enter its scope.
      const state = await Promise.race([
        waiting.then(() => 'empty'),
        sleeping.promise.then(() => 'waiting'),
      ])
      owner.signal('SIGTERM')
      expect({ state, deliveredSignals: systemctl.mock.calls.length }).toEqual({ state: 'waiting', deliveredSignals: 1 })
    } finally {
      final = true
      direct.resolve(undefined)
      tick.resolve(undefined)
      await waiting
      owner.cleanup?.()
    }
  })
})
