/**
 * Warm the tsx transform cache of the local subprocess runner once per Vitest run.
 *
 * On Linux every spawned command through `LocalSubprocessRuntime` first starts the runner entry, and a source
 * checkout starts it through `node --import tsx/esm`. With a cold tsx cache each of those starts transforms the
 * runner's module graph again, about 236 ms against about 95 ms warm. Suites that keep real systemd scopes
 * (containment, shell, terminal) then pay the cold cost on their first spawns inside the 5 s case budget. This
 * global setup starts the runner once without a launch request, which loads the same module graph and exits with
 * the runner's "no selection" status, so those suites start warm.
 *
 * The invocation mirrors `spawnRunnerInvocation` and `runnerEnvironment` in `subprocess-local/src/runner-launch.ts`;
 * that module cannot be imported here because Vitest's module runner does not support its `import.meta.resolve`.
 *
 * The warm-up is an optimization only: any failure to start it is reported on stderr and never fails the run.
 * It writes only to the tsx cache.
 * @module
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const SUBPROCESS_LOCAL = new URL('../packages/subprocess/subprocess-local/', import.meta.url)

/** Upper bound for the warm-up process; a cold transform of the runner graph takes well under a second. */
const WARM_UP_TIMEOUT_MS = 10_000

/** Exit status the runner entry reports when it starts without a private selector. */
const NO_SELECTION_STATUS = 127

/** Why the warm-up did not run to completion. */
class RunnerWarmUpSkipped extends Error {
  override readonly name = 'RunnerWarmUpSkipped'
}

/** The runner's bootstrap-safe environment: ambient variables without Node and tsx controls, plus the workspace tsconfig. */
function runnerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    const prefix = name.toUpperCase()
    if (!prefix.startsWith('NODE_') && !prefix.startsWith('TSX_')) env[name] = value
  }
  env.TSX_TSCONFIG_PATH = new URL('../../../tsconfig.base.json', SUBPROCESS_LOCAL).pathname
  env.SYSTEMD_LOG_TARGET = 'null'
  return env
}

function warmRunner(): void {
  let tsxLoader: string
  try {
    tsxLoader = pathToFileURL(createRequire(new URL('package.json', SUBPROCESS_LOCAL)).resolve('tsx/esm')).href
  } catch (error) {
    throw new RunnerWarmUpSkipped(`tsx is not resolvable from subprocess-local: ${(error as Error).message}`)
  }
  const entry = new URL('src/bin.ts', SUBPROCESS_LOCAL).pathname
  const result = spawnSync(process.execPath, ['--import', tsxLoader, entry], {
    env: runnerEnv(),
    stdio: 'ignore',
    timeout: WARM_UP_TIMEOUT_MS,
  })
  if (result.error !== undefined) throw new RunnerWarmUpSkipped(`the runner could not start: ${result.error.message}`)
  if (result.status !== NO_SELECTION_STATUS) {
    throw new RunnerWarmUpSkipped(`the runner exited with status ${String(result.status)} and signal ${String(result.signal)}`)
  }
}

/** Vitest global setup: warm the runner's tsx cache, tolerating hosts where it cannot start. */
export default function setup(): void {
  if (process.platform !== 'linux') return
  try {
    warmRunner()
  } catch (error) {
    if (!(error instanceof RunnerWarmUpSkipped)) throw error
    process.stderr.write(`subprocess runner warm-up skipped: ${error.message}\n`)
  }
}
