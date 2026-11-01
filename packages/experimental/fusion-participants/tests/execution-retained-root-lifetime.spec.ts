/** Exact retained root delivery through public Loader withdrawal and real JSONL close. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { JsonlBackendTracker, JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
import { SessionWriteLease } from '../../../session/session-persistence-jsonl/src/lease.ts'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { publicFixture } from './execution-public-harness.ts'
import { gate } from './execution-harness.ts'
import { mount, retainUntilProcessExit } from './harness.ts'
import { sessionDir, generationLogFilename } from '../../../session/session-persistence-jsonl/src/format.ts'

const run = promisify(execFile)
const child = process.env.DSH_RETAINED_LIFETIME_CHILD === '1'
const fault = process.env.DSH_RETAINED_LIFETIME_FAULT
if (!child) {
  it('joins the exact retained root terminal prefix and actual writer close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'retained-root-process-'))
    let sessionRoot: string | undefined
    try {
      const result = await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
        'packages/experimental/fusion-participants/tests/execution-retained-root-lifetime.spec.ts', '--maxWorkers=1'], {
        env: { ...process.env, DSH_RETAINED_LIFETIME_CHILD: '1', DSH_RETAINED_LIFETIME_OUTPUT: directory },
        timeout: 30000, maxBuffer: 200000,
      }).then(output => ({ exit: 0, signal: null, killed: false, ...output }),
        (error: unknown) => {
          if (!(error instanceof Error) || !('code' in error) || !('signal' in error) || !('killed' in error)
            || !('stdout' in error) || !('stderr' in error)) throw error
          return { exit: error.code, signal: error.signal, killed: error.killed,
            stdout: String(error.stdout), stderr: String(error.stderr) }
        })
      expect(result.killed, 'a killed child is not a lifetime verdict').toBe(false)
      expect(result.signal).toBeNull()
      if (process.env.DSH_RETAINED_EVIDENCE !== undefined) {
        await writeFile(process.env.DSH_RETAINED_EVIDENCE + '.child.log', result.stdout + result.stderr)
      }
      const observation = await readFile(join(directory, 'observation.json'), 'utf8')
      sessionRoot = (JSON.parse(observation) as { root: string }).root
      if (process.env.DSH_RETAINED_EVIDENCE !== undefined) {
        await writeFile(process.env.DSH_RETAINED_EVIDENCE, observation)
      }
      expect(result.exit, result.stdout + result.stderr + observation).toBe(0)
    } finally {
      if (sessionRoot !== undefined) await rm(sessionRoot, { recursive: true, force: true })
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)
} else {
  it('observes retained root cleanup in an owned process', async () => {
    const writers = new Set<JsonlSessionHandle>(), trackers = new Set<JsonlBackendTracker>()
    const trace: { op: string; session?: string; seq?: number; error?: string }[] = []
    const closed = new Map<JsonlSessionHandle, string>()
    // oxlint-disable-next-line typescript/unbound-method -- each call retains its original receiver.
    const adopt = JsonlBackendTracker.prototype.adopt
    vi.spyOn(JsonlBackendTracker.prototype, 'adopt').mockImplementation(function (this: JsonlBackendTracker, writer) {
      trackers.add(this)
      if (writer.access === 'write') writers.add(writer)
      return adopt.call(this, writer)
    })
    // oxlint-disable-next-line typescript/unbound-method -- each call retains its original receiver.
    const close = JsonlSessionHandle.prototype.close
    vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementation(function (this: JsonlSessionHandle) {
      trace.push({ op: 'close-call', session: this.id })
      const result = close.call(this)
      void result.then(() => { closed.set(this, 'fulfilled'); trace.push({ op: 'close-fulfilled', session: this.id }) },
        (error: unknown) => { closed.set(this, 'rejected'); trace.push({ op: 'close-rejected', session: this.id, error: String(error) }) })
      return result
    })
    // oxlint-disable-next-line typescript/unbound-method -- each call retains its original receiver.
    const flush = JsonlSessionHandle.prototype.flushRetained
    vi.spyOn(JsonlSessionHandle.prototype, 'flushRetained').mockImplementation(async function (this: JsonlSessionHandle, session, seq) {
      trace.push({ op: 'retained-flush', session: session.id, seq })
      const result = await flush.call(this, session, seq)
      trace.push({ op: result.kind === 'durable' ? 'retained-durable' : 'retained-refused', session: session.id, seq })
      return result
    })
    // oxlint-disable-next-line typescript/unbound-method -- each call retains its original receiver.
    const leaseRelease = SessionWriteLease.prototype.release
    vi.spyOn(SessionWriteLease.prototype, 'release').mockImplementation(async function (this: SessionWriteLease) {
      trace.push({ op: 'lease-release' })
      await leaseRelease.call(this)
      trace.push({ op: 'lease-released' })
    })
    const f = await publicFixture()
    const sessions = f.ctx.sessions, persistence = f.ctx.sessionPersistence
    const inventory = () => ({
      writers: [...writers].map(writer => ({ writer: [...writers].indexOf(writer), session: writer.id, pins: writer['pins'].size,
        uncertain: writer.lifetimeUncertain, close: closed.get(writer) ?? 'pending',
        cursor: writer['state'].cursor, flushed: writer['flushedCursor'], buffered: writer['buffered'].map((event: SessionEvent) => event.seq),
        sameSession: [...trackers].some(tracker => tracker['bindings'].has(writer)
          && tracker['bindings'].get(writer) === sessions.get(writer.id)),
        sameWriter: [...trackers].some(tracker => tracker['writers'].get(writer.id) === writer),
      })),
      trackers: [...trackers].map(tracker => ({ handles: tracker.openHandles.size, claims: tracker['writers'].size,
        routes: tracker['retainedRoutes'].size, bindings: tracker['bindings'].size })),
      hooks: Object.fromEntries(['session/event', 'session/created', 'session/disposed', 'session/flush', 'internal/plugin', 'internal/status']
        .map(name => [name, f.ctx.events['_hooks'][name]?.length ?? 0])),
    })
    const before = inventory()
    const root = sessions.get(f.task.roster.rootSessionId)!, participant = f.adopted.agent.session
    let removalFaults = 0
    const removalCalls: string[] = []
    if (fault === 'listener') {
      const events = f.ctx.events
      const unregister = events['unregister']
      const retained = new Set<unknown>((events['_hooks']['session/event'] ?? [])
        .filter(hook => hook.ctx === f.ctx.root).map(hook => hook.callback))
      expect(retained.size, 'fault must target an existing retained root listener').toBeGreaterThan(0)
      Object.defineProperty(events, 'unregister', { configurable: true,
        value: (...args: Parameters<typeof unregister>) => {
          removalCalls.push(String(args[0]))
          const removed = unregister.apply(events, args)
          if (args[0] === 'session/event' && retained.has(args[1])) {
            removalFaults++
            trace.push({ op: 'listener-removal-failed' })
            throw new Error('seeded retained listener removal failure')
          }
          return removed
        },
      })
    }
    const cleanup = gate()
    f.control.cleanup = cleanup
    await f.grant()
    const run = f.bind(), attempt = f.host.reserve(run, 'edit')
    let rootDisposal: Promise<void> | undefined
    f.control.onRegister = () => {
      rootDisposal = f.ctx.fiber.dispose()
      void rootDisposal.catch(() => {}) // The final retained cleanup owns the visible result.
      expect(() => f.host.reserve(run, 'edit')).toThrow()
    }
    await expect(f.host.register(attempt)).rejects.toThrow()
    await cleanup.entered.promise
    expect(f.control.identities.has(attempt)).toBe(true)
    const atBarrier = inventory()
    cleanup.resume.resolve(undefined)
    const drain = await f.host.dispose().then(() => ({ status: 'fulfilled' }),
      (error: unknown) => ({ status: 'rejected', error: String(error) }))
    const prefixes = []
    const files: { session: string; path: string; jsonl: string }[] = []
    for (const session of [root, participant]) {
      const path = join(sessionDir(f.root, session.header.cwd, session.id), generationLogFilename(SESSION_FORMAT_VERSION, 'none'))
      const jsonl = await readFile(path, 'utf8')
      files.push({ session: session.id, path, jsonl })
      const lines = jsonl.trim().split('\n').map(line => JSON.parse(line) as { seq?: number })
      const committed = lines.filter(line => line.seq !== undefined)
      prefixes.push({ session: session.id, admitted: session.ownEvents(), committed })
    }
    let cleanupState = 'unknown'
    const cleanupErrors: unknown[] = []
    let after: ReturnType<typeof inventory> | undefined
    if (drain.status === 'fulfilled') {
      await rootDisposal?.catch((error: unknown) => { cleanupErrors.push(error) })
      await f.dispose().catch((error: unknown) => { cleanupErrors.push(error) })
      cleanupState = cleanupErrors.length === 0 ? 'fulfilled' : 'rejected'
      after = inventory()
      const next = await mount(f.root)
      for (const session of [root, participant]) await (await next.ctx.sessionPersistence.open(session.id, 'write')).close()
      await next.ctx.fiber.dispose()
    } else {
      await expect(persistence.open(root.id, 'write')).rejects.toThrow()
      retainUntilProcessExit(f.ctx, f.root)
    }
    const observation = { root: f.root, drain, cleanupState, resources: { before, atBarrier, after: after ?? inventory() },
      trace, files, removalFaults, removalCalls, cleanupErrors: cleanupErrors.map(String), prefixes, bodies: f.control.bodies,
      cleanups: f.control.cleanups, requests: f.model.requests.length }
    await writeFile(join(process.env.DSH_RETAINED_LIFETIME_OUTPUT!, 'observation.json'), JSON.stringify(observation, null, 2) + '\n')
    if (fault === 'listener') expect(removalFaults, 'listener fault must execute on the actual retained remover').toBeGreaterThan(0)
    expect(drain, 'terminal durable join must finish before successful retained root cleanup').toEqual({ status: 'fulfilled' })
    for (const prefix of prefixes) expect(prefix.committed, 'admitted terminal prefix must equal real JSONL').toEqual(prefix.admitted)
    expect(observation).toMatchObject({ bodies: 0, cleanups: 1, requests: 0, cleanupState: fault === 'listener' ? 'rejected' : 'fulfilled' })
  })
}
