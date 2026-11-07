/** Shared fiber admission predicate for the host-declaring fiber and the initiating task caller. */
import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Report whether a fiber may still start new work. A reloading fiber is UNLOADING but keeps its uid, so a
 * uid check alone admits work between the synchronous `internal/status` edge and later cleanup.
 * @param fiber - declaring or initiating fiber whose teardown must fence admission.
 * @returns false once the fiber is unloading or has been disposed (its uid is cleared).
 */
export function fiberAdmits(fiber: Context['fiber']): boolean {
  return fiber.uid !== null && fiber.state !== FiberState.UNLOADING
}
