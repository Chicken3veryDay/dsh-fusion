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

/**
 * Collect every lifetime a fiber's work depends on: its ancestors and, transitively, the provider fibers
 * (with their ancestors) of each service implementation the fiber and those lifetimes committed to.
 * A provider's teardown withdraws its implementation and unloads dependents only after its own status edge.
 * @param fiber - lifetime whose work is admitted.
 * @returns dependency closure, read from Cordis `committed` implementations at call time.
 */
export function dependencyClosure(fiber: Fiber): ReadonlySet<Fiber> {
  const closure = new Set<Fiber>()
  const pending = [fiber]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (let current = next; !closure.has(current); current = current.parent.fiber) {
      closure.add(current)
      for (const impl of Object.values(current.committed ?? {})) pending.push(impl.ctx.fiber)
    }
  }
  return closure
}

/** Admission view consumed by the task owners; construction and closure belong to the acquisition owner. */
export interface Admission {
  /** Synchronous conjunction of every lifetime that fences new task work. */
  admits(): boolean
  /** Close admission permanently; release, cancellation and cleanup of admitted work stay available. */
  close(): void
}

/**
 * Task admission lifetime: the dependency closures of the owner fiber, the initiating caller and every enrolled
 * host-declaring fiber, the task signal, and the owners' disposing state. The first failed conjunct closes
 * admission permanently, even if its fiber later reloads to ACTIVE.
 */
export class TaskAdmission implements Admission {
  private readonly fibers = new Set<Fiber>()
  private closed = false

  /**
   * @param lifetimes - owner and initiating caller fibers; each contributes its dependency closure.
   * @param signal - task cancellation.
   */
  constructor(lifetimes: Iterable<Fiber>, private readonly signal: AbortSignal) {
    for (const fiber of lifetimes) this.bind(fiber)
  }

  /**
   * Add a host-declaring lifetime before enrollment can mint capabilities; its teardown closes task admission.
   * @param fiber - declaring fiber; its dependency closure is bound.
   */
  bind(fiber: Fiber): void {
    for (const dependency of dependencyClosure(fiber)) this.fibers.add(dependency)
  }

  admits(): boolean {
    if (!this.closed && (this.signal.aborted || ![...this.fibers].every(fiberAdmits))) this.closed = true
    return !this.closed
  }

  close(): void { this.closed = true }
}
