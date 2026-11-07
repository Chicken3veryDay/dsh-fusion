import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { launchLinuxScope, probeLinuxScope } from '../src/linux-scope.ts'
import { targetEnvironment } from '../src/runner-launch.ts'
import { bindManagedProcess } from '../src/spawn.ts'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-review-creating-scope-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })
const literalArgv = process.platform === 'linux' ? probeLinuxScope() : undefined

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch { /* not written yet */ }
    await sleepMs(20)
  }
  throw new Error(`pid file ${path} was not written`)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3))
  } catch {
    return false
  }
}

describe.skipIf(literalArgv === undefined)('range wait issued at spawn against real systemd', () => {
  it('never reports an empty range while the target runs, and terminate still reaches it', async () => {
    const early: string[] = []
    for (let attempt = 0; attempt < Number(process.env.REVIEW_ATTEMPTS ?? 25) && early.length === 0; attempt++) {
      const pidFile = join(scratch, `target-${attempt}.pid`)
      const request: SubprocessSpawnSpec = {
        argv: ['sh', '-c', 'echo $$ > "$1"; trap "" TERM; exec sleep 30', 'sh', pidFile],
        cwd: scratch,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1_024 }, stderr: { maxBytes: 1_024 } },
        graceMs: 100,
      }
      // Only the poll cadence changes (1 ms instead of 50 ms) so more attempts sample systemd's
      // creation interval; every state decision is the production one.
      // REVIEW_PRODUCTION_CADENCE=1 keeps the production 50 ms establishment poll.
      const handle = bindManagedProcess(request, launchLinuxScope(request, targetEnvironment(request), literalArgv ?? [],
        process.env.REVIEW_PRODUCTION_CADENCE === '1' ? {} : { sleep: (_delayMs, signal) => sleepMs(1, undefined, { signal }) }))
      let resolved = false
      const waiting = handle.waitForExit().then((empty) => { resolved = empty })
      const pid = await waitForPid(pidFile)
      await new Promise<void>(resolve => setImmediate(resolve))
      if (resolved && alive(pid)) {
        handle.terminate()
        await sleepMs(2_000)
        early.push(`attempt ${attempt}: waitForExit() resolved true while target ${pid} ran; after terminate() and 2 s it is ${alive(pid) ? 'still alive' : 'gone'}`)
        try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
      } else {
        handle.terminate()
      }
      await Promise.allSettled([handle.done, waiting])
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
    expect(early).toEqual([])
  }, 120_000)
})
