/** Failure-safe cleanup for tests that hold barriers, Contexts, or unhandled-rejection listeners. */

import type { BridgeHarness } from './harness.ts'

/** A deterministic barrier whose release is registered for cleanup when it is created. */
export interface HeldBarrier {
  /** Resolves when the held code reaches the barrier. */
  readonly reached: Promise<undefined>
  /** Resolves when the barrier is released; awaited by the held code. */
  readonly released: Promise<undefined>
  /** Called by the held code when it reaches the barrier. */
  reach(): void
  /** Lets the held code continue; calling it again is harmless. */
  release(): void
}

/** Cleanup order: stop running work, then let held code continue, then dispose owners. */
type CleanupPhase = 'abort' | 'release' | 'dispose'
const PHASES: readonly CleanupPhase[] = ['abort', 'release', 'dispose']

/**
 * Cleanup registered at acquisition and always run to completion. An assertion failure between
 * acquiring a resource and the end of the test therefore still cancels running Agents, releases
 * barriers, disposes Contexts, and removes listeners, in that phase order and newest first within a phase.
 */
export class TestCleanup {
  private readonly tasks = new Map<CleanupPhase, (() => void | Promise<void>)[]>(PHASES.map(phase => [phase, []]))

  /**
   * Register a task to run on {@link run}; call it immediately after acquiring the resource.
   * @param task - release or disposal work for one resource.
   * @param phase - when the task runs; disposal by default.
   */
  defer(task: () => void | Promise<void>, phase: CleanupPhase = 'dispose'): void {
    this.tasks.get(phase)!.push(task)
  }

  /**
   * Create a barrier whose release is already registered.
   * @returns a held barrier.
   */
  barrier(): HeldBarrier {
    const reached = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const barrier: HeldBarrier = {
      reached: reached.promise,
      released: released.promise,
      reach: () => { reached.resolve(undefined) },
      release: () => { released.resolve(undefined) },
    }
    this.defer(() => { barrier.release() }, 'release')
    return barrier
  }

  /**
   * Adopt a bridge harness for disposal.
   * @param harness - a started bridge harness.
   * @returns the same harness.
   */
  adopt(harness: BridgeHarness): BridgeHarness {
    // A held request must not dispatch once released, so running turns are cancelled first.
    this.defer(() => { for (const agent of harness.ctx.agents.list()) agent.cancel({ kind: 'user' }) }, 'abort')
    this.defer(() => harness.dispose())
    return harness
  }

  /**
   * Observe `unhandledRejection` until cleanup, so a test can assert none was raised.
   * @returns the rejection reasons seen so far, as a live list.
   */
  trackUnhandledRejections(): readonly unknown[] {
    const seen: unknown[] = []
    const listener = (reason: unknown): void => { seen.push(reason) }
    process.on('unhandledRejection', listener)
    this.defer(() => { process.off('unhandledRejection', listener) })
    return seen
  }

  /**
   * Run every registered task newest first, continuing after a failure.
   * @throws {AggregateError} when one or more tasks failed, after all have run.
   */
  async run(): Promise<void> {
    const failures: unknown[] = []
    for (const phase of PHASES) {
      for (const task of this.tasks.get(phase)!.splice(0).reverse()) {
        try {
          await task()
        } catch (error: unknown) {
          failures.push(error)
        }
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'test cleanup failed')
  }
}

/**
 * Let every promise continuation and the process' pending unhandled-rejection report run.
 * Node reports an unhandled rejection after the microtask queue drains and before the next macrotask.
 */
export function settleRejections(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}
