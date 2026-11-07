import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { prepareLinuxTerminalScope } from '../src/linux-scope.ts'
import { consumeLinuxLaunchRequest } from '../src/runner-protocol.ts'
import { SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'

it.each(['inactive', 'not-found', 'active'] as const)(
  'does not treat a stale %s query as proof of exit when the launcher consumes its request during the query',
  async (initial) => {
    const root = mkdtempSync(join(tmpdir(), 'review-r3-stale-query-'))
    const firstQuery = Promise.withResolvers<{ status: number; stdout: string; stderr: string }>()
    const sleeping = Promise.withResolvers<undefined>()
    const tick = Promise.withResolvers<undefined>()
    const direct = Promise.withResolvers<undefined>()
    let queries = 0
    let final = false
    const systemctl = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }))
    const scope = prepareLinuxTerminalScope({
      argv: ['tool'], cwd: process.cwd(), rows: 24, cols: 80,
      terminalType: 'dumb', graceMs: 5_000,
    }, {}, [], {
      runnerInvocation: [process.execPath, '/unused-runner.js'],
      spawnSync: systemctl as never,
      cgroupRoot: root,
      systemctlQuery: () => {
        queries += 1
        if (queries === 1) return firstQuery.promise
        return Promise.resolve({
          status: 0, stdout: `LoadState=loaded\nActiveState=${final ? 'inactive' : 'active'}\nTasksCurrent=${final ? '0' : '1'}\n`, stderr: '',
        })
      },
      sleep: () => { sleeping.resolve(undefined); return tick.promise },
    })
    const owner = scope.bindOwner({ running: () => !final, signal: () => true, settled: direct.promise })
    const waiting = owner.waitForExit()
    try {
      expect(queries).toBe(1)
      // systemctl captured this response before the launcher entered the scope.
      const snapshot = {
        status: 0,
        stdout: `LoadState=${initial === 'not-found' ? 'not-found' : 'loaded'}\nActiveState=${initial === 'active' ? 'active' : 'inactive'}\nTasksCurrent=${initial === 'active' ? '1' : '[not set]'}\n`,
        stderr: '',
      }
      const locator = scope.env[SUBPROCESS_RUNNER_ENV]
      if (locator === undefined) throw new Error('no launch request')
      consumeLinuxLaunchRequest(locator)
      // Delivery of the captured response follows request consumption, just as execFile's
      // callback may follow the manager's observation while the independently running launcher starts.
      firstQuery.resolve(snapshot)
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
      rmSync(root, { recursive: true, force: true })
    }
  },
)
