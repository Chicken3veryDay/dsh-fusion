/** Test helper for mounting the local subprocess runtime without per-spawn systemd scopes. @module @deepseek-ai/dsh-subprocess-testkit */

import type { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/**
 * Make the composition's local subprocess runtime take the process-group path on Linux.
 *
 * On Linux the runtime wraps every spawn in `systemd-run --user --scope` plus a Node bootstrap runner, about 95 ms
 * per spawn from source with a warm tsx cache and 236 ms with a cold one, against about 2 ms on the process-group
 * path macOS ships. A spec that runs hundreds of `git` or `rg` commands for a subject other than process containment
 * pays that per command and can overrun the 5 s case budget under host load. The commands still run as real
 * processes; only the containment selection changes.
 *
 * The runtime's `internals.platform` override is its only containment-selection hook. It also steers the
 * process-group owner: with a non-Linux platform the owner skips the Linux `/proc` group-member probe and decides
 * liveness from signal 0 on the process group alone. Specs that assert how descendants are signalled or when
 * `waitForExit()` settles must keep the real scope and not call this helper.
 *
 * Does nothing on other platforms, which already use the process-group path or a native Windows Job. Existing
 * `internals` fields are preserved.
 * @param ctx - composition that has already mounted `LocalSubprocessRuntime` as `ctx.subprocess`.
 * @throws when the composition mounts a different subprocess provider, which this helper must not reconfigure.
 */
export function useProcessGroupContainment(ctx: Context): void {
  const subprocess = ctx.subprocess
  if (!(subprocess instanceof LocalSubprocessRuntime)) {
    throw new Error('useProcessGroupContainment: the composition does not mount the local subprocess runtime')
  }
  if (process.platform === 'linux') subprocess.internals = { ...subprocess.internals, platform: 'darwin' }
}
