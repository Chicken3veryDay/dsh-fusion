import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CgroupEventsWatch } from '../src/cgroup-events.ts'
import type { CgroupFileWatcher } from '../src/cgroup-events.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Count the kernel watches this process holds across all of its inotify descriptors. */
function inotifyWatchCount(): number {
  let count = 0
  for (const fd of readdirSync('/proc/self/fd')) {
    let info: string
    try {
      info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
    } catch {
      continue
    }
    if (info.includes('inotify wd:')) count += info.split('\n').filter(line => line.startsWith('inotify wd:')).length
  }
  return count
}

function realTree() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cgroup-events-'))
  directories.push(root)
  writeFileSync(join(root, 'cgroup.controllers'), 'pids\n')
  mkdirSync(join(root, 'a.slice', 'b.scope'), { recursive: true })
  const events = join(root, 'a.slice', 'b.scope', 'cgroup.events')
  writeFileSync(events, 'populated 1\nfrozen 0\n')
  return { root, events, group: '/a.slice/b.scope' }
}

describe('CgroupEventsWatch on the real filesystem', () => {
  it('wakes on a file change through fs.watch, reads the flag, and releases its kernel watch', async () => {
    const tree = realTree()
    const baseline = inotifyWatchCount()
    const woke = Promise.withResolvers<undefined>()
    const reports: string[] = []
    const watch = new CgroupEventsWatch(
      { cgroupRoot: tree.root },
      () => { woke.resolve(undefined) },
      (message) => { reports.push(message) },
    )
    expect(watch.population()).toBe('unreadable')
    expect(watch.attach(undefined)).toBe(false)
    expect(watch.attach(tree.group)).toBe(true)
    expect(inotifyWatchCount()).toBe(baseline + 1)
    expect(watch.attach(tree.group)).toBe(false)
    expect(watch.population()).toBe('populated')
    expect(watch.hasEvent()).toBe(false)
    writeFileSync(tree.events, 'populated 0\nfrozen 0\n')
    await woke.promise
    expect(watch.hasEvent()).toBe(true)
    expect(watch.consumeEvent()).toBe(true)
    expect(watch.consumeEvent()).toBe(false)
    expect(watch.population()).toBe('empty')
    watch.close()
    watch.close()
    // libuv removes the kernel watch one loop turn after a close that follows a delivered event.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(inotifyWatchCount()).toBe(baseline)
    expect(reports).toEqual([])
  })

  it('stays silent on a host without the unified hierarchy and on a vanished scope', () => {
    const tree = realTree()
    const reports: string[] = []
    const report = (message: string): void => { reports.push(message) }
    const v1 = new CgroupEventsWatch({ cgroupRoot: join(tree.root, 'a.slice') }, vi.fn(), report)
    expect(v1.attach(tree.group)).toBe(false)
    const gone = new CgroupEventsWatch({ cgroupRoot: tree.root }, vi.fn(), report)
    expect(gone.attach('/a.slice/missing.scope')).toBe(false)
    expect(gone.population()).toBe('unreadable')
    expect(reports).toEqual([])
  })

  it('reports an unparsable flag once', () => {
    const tree = realTree()
    writeFileSync(tree.events, 'populated maybe\n')
    const reports: string[] = []
    const watch = new CgroupEventsWatch({ cgroupRoot: tree.root }, vi.fn(), (message) => { reports.push(message) })
    expect(watch.attach(tree.group)).toBe(true)
    expect(watch.population()).toBe('unreadable')
    expect(watch.population()).toBe('unreadable')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('has no populated flag')
    watch.close()
  })

  it('attaches again after a healthy detach but never after close', () => {
    const tree = realTree()
    const closed: string[] = []
    const watchFile = vi.fn((path: string) => ({ on: () => undefined, close: () => { closed.push(path) } }))
    const watch = new CgroupEventsWatch({ cgroupRoot: tree.root, watchFile }, vi.fn(), vi.fn())
    expect(watch.attach(tree.group)).toBe(true)
    watch.detach()
    expect(watch.attach(tree.group)).toBe(true)
    watch.close()
    expect(watch.attach(tree.group)).toBe(false)
    watch.detach()
    expect(watch.attach(tree.group)).toBe(false)
    const unused = new CgroupEventsWatch({ cgroupRoot: tree.root, watchFile }, vi.fn(), vi.fn())
    unused.close()
    expect(unused.attach(tree.group)).toBe(false)
    expect(watchFile).toHaveBeenCalledTimes(2)
    expect(closed).toEqual([tree.events, tree.events])
  })

  it('ignores events and errors from a watcher it already released', () => {
    const tree = realTree()
    const watchers: Array<{ listeners: Map<string, (error: Error) => void>; closed: number }> = []
    const watchFile = (): CgroupFileWatcher => {
      const watcher = { listeners: new Map<string, (error: Error) => void>(), closed: 0 }
      watchers.push(watcher)
      return {
        on(event: string, listener: (error: Error) => void) { watcher.listeners.set(event, listener) },
        close() { watcher.closed += 1 },
      }
    }
    const wake = vi.fn()
    const report = vi.fn()
    const watch = new CgroupEventsWatch({ cgroupRoot: tree.root, watchFile }, wake, report)
    expect(watch.attach(tree.group)).toBe(true)
    watch.detach()
    expect(watch.attach(tree.group)).toBe(true)
    watchers[0]?.listeners.get('change')?.(new Error('change listeners take no argument'))
    watchers[0]?.listeners.get('error')?.(new Error('late'))
    expect({ event: watch.hasEvent(), wakes: wake.mock.calls.length, reports: report.mock.calls.length })
      .toEqual({ event: false, wakes: 0, reports: 0 })
    expect(watchers.map(watcher => watcher.closed)).toEqual([1, 0])
    watch.close()
  })
})
