/** cgroup v2 `cgroup.events` observation that wakes a Linux scope's range-quiescence wait. */

import { existsSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'

/** Mount point of the unified cgroup v2 hierarchy on systemd hosts. */
const UNIFIED_CGROUP_ROOT = '/sys/fs/cgroup'
const POPULATED_LINE = /^populated ([01])$/mu

/** The part of an `fs.FSWatcher` the observer uses. */
export interface CgroupFileWatcher {
  on(event: 'change', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  close(): void
}

/** Test seams for the cgroup filesystem. */
export interface CgroupEventSeams {
  /** Unified cgroup v2 mount; defaults to /sys/fs/cgroup. */
  cgroupRoot?: string
  /** Start a non-persistent watch on one file; defaults to `fs.watch`. */
  watchFile?: (path: string) => CgroupFileWatcher
  /** Read one small file as UTF-8; defaults to `fs.readFileSync`. */
  readFile?: (path: string) => string
}

/** Kernel view of one scope's cgroup: `unreadable` means the file could not be read or parsed. */
export type CgroupPopulation = 'populated' | 'empty' | 'unreadable'

function defaultWatchFile(path: string): CgroupFileWatcher {
  return watch(path, { persistent: false })
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * One scope's `cgroup.events` watch. The kernel changes the file when the cgroup's `populated`
 * flag flips, so an event is a wake-up and {@link CgroupEventsWatch.population} is the proof.
 * Hosts without the unified hierarchy and scopes that vanish before the watch starts stay
 * silent because the caller's systemctl poll already covers them; every other failure goes to
 * `report` once and leaves the poll as the only observer.
 */
export class CgroupEventsWatch {
  private watcher: CgroupFileWatcher | undefined
  private path: string | undefined
  private attempted = false
  private pending = false
  private reported = false

  /**
   * @param seams - optional cgroup filesystem seams used by tests.
   * @param wake - called on every event or watcher failure so the waiting loop re-evaluates.
   * @param report - receives the description of a degraded observation, at most once.
   */
  constructor(
    private readonly seams: CgroupEventSeams,
    private readonly wake: () => void,
    private readonly report: (message: string) => void,
  ) {}

  /**
   * Start watching the scope's `cgroup.events` once its cgroup path is known.
   * @param controlGroup - the scope's `ControlGroup` property, relative to the hierarchy root.
   * @returns whether this call attached the watcher, so the caller can re-check emptiness for a
   *   transition that happened before the watch existed.
   */
  attach(controlGroup: string | undefined): boolean {
    if (this.attempted || controlGroup === undefined) return false
    this.attempted = true
    const root = this.seams.cgroupRoot ?? UNIFIED_CGROUP_ROOT
    if (!existsSync(join(root, 'cgroup.controllers'))) return false
    this.path = join(root, controlGroup, 'cgroup.events')
    let watcher: CgroupFileWatcher
    try {
      watcher = (this.seams.watchFile ?? defaultWatchFile)(this.path)
    } catch (error) {
      if (!isMissing(error)) this.degrade('could not be watched', error)
      return false
    }
    watcher.on('change', () => {
      this.pending = true
      this.wake()
    })
    watcher.on('error', (error) => {
      this.close()
      this.degrade('watcher failed', error)
      this.wake()
    })
    this.watcher = watcher
    return true
  }

  /**
   * Take the pending change notification, clearing it.
   * @returns whether an event arrived since the last call.
   */
  consumeEvent(): boolean {
    const pending = this.pending
    this.pending = false
    return pending
  }

  /**
   * Peek at the pending change notification without clearing it.
   * @returns whether an event is waiting to be consumed.
   */
  hasEvent(): boolean {
    return this.pending
  }

  /**
   * Read the kernel's populated flag for the watched cgroup.
   * @returns `unreadable` when the file is gone (scope collected), unreadable, or unparsable.
   */
  population(): CgroupPopulation {
    if (this.path === undefined) return 'unreadable'
    let text: string
    try {
      text = (this.seams.readFile ?? defaultReadFile)(this.path)
    } catch (error) {
      if (!isMissing(error)) this.degrade('could not be read', error)
      return 'unreadable'
    }
    const populated = POPULATED_LINE.exec(text)?.[1]
    if (populated === undefined) {
      this.degrade('has no populated flag', new Error(JSON.stringify(text.slice(0, 80))))
      return 'unreadable'
    }
    return populated === '1' ? 'populated' : 'empty'
  }

  /**
   * Release the watch at the end of one observation. A watch that was healthy may be attached again
   * by a later observation of the same scope; a silent or degraded one stays as it was.
   */
  detach(): void {
    const healthy = this.watcher !== undefined
    this.close()
    if (healthy) this.attempted = false
  }

  /** Stop watching for good. Safe to repeat. */
  close(): void {
    const watcher = this.watcher
    this.watcher = undefined
    this.pending = false
    watcher?.close()
  }

  private degrade(what: string, error: unknown): void {
    if (this.reported) return
    this.reported = true
    this.report(`cgroup.events ${what} at ${String(this.path)} (${(error as Error).message}); range exit is observed by polling systemctl only`)
  }
}
