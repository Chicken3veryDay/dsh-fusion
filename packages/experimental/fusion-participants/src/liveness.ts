/** One task admission lifetime shared by every delivery and execution admission entry. */
import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

type Fiber = Context['fiber']

/**
 * Report whether a fiber may still start new work. A reloading fiber is UNLOADING but keeps its uid, so a
 * uid check alone admits work between the synchronous `internal/status` edge and later cleanup.
 * @param fiber - lifetime whose teardown must fence admission.
 * @returns false once the fiber is unloading or has been disposed (its uid is cleared).
 */
export function fiberAdmits(fiber: Fiber): boolean {
  return fiber.uid !== null && fiber.state !== FiberState.UNLOADING
}

/**
 * Collect a fiber and every ancestor; an ancestor's teardown disposes its descendants after the status edge.
 * @param fiber - innermost lifetime.
 * @returns the fiber through the root, whose parent is itself.
 */
export function fiberChain(fiber: Fiber): ReadonlySet<Fiber> {
  const chain = new Set<Fiber>()
  for (let current = fiber; !chain.has(current); current = current.parent.fiber) chain.add(current)
  return chain
}

/** Admission view consumed by the task owners; construction and closure belong to the acquisition owner. */
export interface Admission {
  /** Synchronous conjunction of every lifetime that fences new task work. */
  admits(): boolean
  /** Close admission permanently; release, cancellation and cleanup of admitted work stay available. */
  close(): void
}

/**
 * Task admission lifetime: the owner and initiating caller chains, the task signal, every enrolled
 * host-declaring chain, and the owners' disposing state. A closed or failed conjunct never reopens.
 */
export class TaskAdmission implements Admission {
  private readonly fibers = new Set<Fiber>()
  private closed = false

  /**
   * @param chains - owner and initiating caller lifetimes, including their ancestors.
   * @param signal - task cancellation.
   */
  constructor(chains: Iterable<ReadonlySet<Fiber>>, private readonly signal: AbortSignal) {
    for (const chain of chains) this.bind(chain)
  }

  /**
   * Add a host-declaring chain before enrollment can mint capabilities; its teardown closes task admission.
   * @param chain - declaring fiber and its ancestors.
   */
  bind(chain: ReadonlySet<Fiber>): void {
    for (const fiber of chain) this.fibers.add(fiber)
  }

  admits(): boolean {
    return !this.closed && !this.signal.aborted && [...this.fibers].every(fiberAdmits)
  }

  close(): void { this.closed = true }
}
