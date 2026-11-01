/** Exact retained root delivery through public Loader withdrawal and real JSONL close. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
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
const route = process.env.DSH_RETAINED_ROUTE ?? 'root'
const phase = process.env.DSH_RETAINED_PHASE ?? 'register'
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
      trace.push({ op: 'lease-release', session: this['path'] })
      if (fault === 'physical') throw new Error('seeded physical release failure')
      await leaseRelease.call(this)
      trace.push({ op: 'lease-released' })
    })
    let providerContext: Context | undefined
    // oxlint-disable-next-line typescript/unbound-method -- called with the exact tracker receiver.
    const install = JsonlBackendTracker.prototype.install
    vi.spyOn(JsonlBackendTracker.prototype, 'install').mockImplementation(function (this: JsonlBackendTracker, ctx) {
      providerContext = ctx
      return install.call(this, ctx)
    })
    let scope: ReturnType<typeof createScope> | undefined
    const f = await publicFixture(route === 'enclosing' ? async (ctx, task, provider) => {
      scope = createScope(ctx, {})
      return scope.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
    } : undefined, process.env.DSH_RETAINED_CACHE !== '0')
    const cacheEnabled = Boolean(f.ctx.get('sessionProjectionCache'))
    expect(cacheEnabled).toBe(process.env.DSH_RETAINED_CACHE !== '0')
    const sessions = f.ctx.sessions, persistence = f.ctx.sessionPersistence
    const inventory = () => ({
      writers: [...writers].map(writer => ({ writer: [...writers].indexOf(writer), session: writer.id, pins: writer['pins'].size,
        uncertain: writer.lifetimeUncertain, close: closed.get(writer) ?? 'pending',
        generation: writer.durabilityGeneration, receipt: [...trackers].find(tracker => tracker['writers'].get(writer.id) === writer)?.['flushReceipts'].get(writer) ?? 0,
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
    if (fault === 'listener' || fault === 'listener-before') {
      const events = f.ctx.events
      const unregister = events['unregister']
      const retained = new Set<unknown>((events['_hooks']['session/event'] ?? [])
        .filter(hook => hook.ctx === f.ctx.root).map(hook => hook.callback))
      expect(retained.size, 'fault must target an existing retained root listener').toBeGreaterThan(0)
      Object.defineProperty(events, 'unregister', { configurable: true,
        value: (...args: Parameters<typeof unregister>) => {
          removalCalls.push(String(args[0]))
          if (fault === 'listener-before' && args[0] === 'session/event' && retained.has(args[1])) {
            removalFaults++
            trace.push({ op: 'listener-removal-failed-before' })
            throw new Error('seeded retained listener removal failure')
          }
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
    const cleanup = gate(), hold = gate()
    if (phase !== 'result-flush') f.control.cleanup = cleanup
    if (phase === 'body') f.control.body = hold
    if (phase === 'start-flush' || phase === 'result-flush') {
      let intercepted = false
      vi.spyOn(JsonlSessionHandle.prototype, 'flushRetained').mockImplementation(async function (this: JsonlSessionHandle, session, seq) {
        const terminal = phase === 'start-flush' ? 'fusion/effect-started' : 'fusion/effect-settled'
        if (!intercepted && this.id === participant.id && session.ownEvents().some(event => event.type === terminal)) {
          intercepted = true
          hold.entered.resolve(undefined)
          await hold.resume.promise
        }
        return flush.call(this, session, seq)
      })
    }
    await f.grant()
    const run = f.bind(), attempt = f.host.reserve(run, 'edit')
    let rootDisposal: Promise<void> | undefined
    let rawDisposal: { status: string; error?: string } | undefined
    const withdraw = () => {
      const disposal = route === 'provider' ? providerContext!.fiber.dispose()
        : route === 'host' ? f.host.dispose()
          : route === 'enclosing' ? scope!.dispose()
            : route === 'session' ? f.task.dispose() : f.ctx.fiber.dispose()
      rootDisposal = disposal
      void disposal.then(() => { rawDisposal = { status: 'fulfilled' } },
        (error: unknown) => { rawDisposal = { status: 'rejected', error: String(error) } })
      expect(() => f.host.reserve(run, 'edit')).toThrow()
    }
    let work: ReturnType<typeof f.host.release> | undefined
    if (phase === 'register') f.control.onRegister = withdraw
    if (phase === 'reservation') withdraw()
    const registration = f.host.register(attempt)
    if (phase === 'register' || phase === 'reservation') await expect(registration).rejects.toThrow()
    else {
      await registration
      if (phase !== 'held') {
        work = f.host.release(attempt)
        // Observe rejection immediately; the original promise remains the final result.
        void work.catch(() => {})
        await (phase === 'cleanup' ? cleanup : hold).entered.promise
      }
      withdraw()
    }
    hold.resume.resolve(undefined)
    if (phase !== 'result-flush' && phase !== 'reservation') {
      await cleanup.entered.promise
      expect(f.control.identities.has(attempt)).toBe(true)
    }
    const atBarrier = inventory()
    cleanup.resume.resolve(undefined)
    await work
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
    const leaseProbes: { session: string; status: string }[] = []
    let finalRawRoot: { status: string; error?: string } | undefined
    let after: ReturnType<typeof inventory> | undefined
    if (drain.status === 'fulfilled') {
      await rootDisposal?.catch((error: unknown) => { cleanupErrors.push(error) })
      await f.dispose().catch((error: unknown) => { cleanupErrors.push(error) })
      cleanupState = cleanupErrors.length === 0 ? 'fulfilled' : 'rejected'
      after = inventory()
      finalRawRoot = await f.ctx.fiber.dispose().then(() => ({ status: 'fulfilled' }),
        (error: unknown) => ({ status: 'rejected', error: String(error) }))
      const next = await mount(f.root)
      for (const session of [root, participant]) {
        const opened = await next.ctx.sessionPersistence.open(session.id, 'write').then(handle => ({ handle }),
          (error: unknown) => ({ error }))
        if ('handle' in opened) {
          leaseProbes.push({ session: session.id, status: 'acquired' })
          await opened.handle.close()
        } else leaseProbes.push({ session: session.id, status: 'refused' })
        expect(leaseProbes.at(-1)?.status).toBe(fault === 'physical' ? 'refused' : 'acquired')
      }
      await next.ctx.fiber.dispose()
    } else {
      await expect(persistence.open(root.id, 'write')).rejects.toThrow()
      retainUntilProcessExit(f.ctx, f.root)
    }
    const observation = { root: f.root, route, phase, cacheEnabled,  rawDisposal, finalRawRoot, leaseProbes, drain, cleanupState,
      resources: { before, atBarrier, after: after ?? inventory() },
      trace, files, removalFaults, removalCalls, cleanupErrors: cleanupErrors.map(String), prefixes, bodies: f.control.bodies,
      cleanups: f.control.cleanups, requests: f.model.requests.length }
    await writeFile(join(process.env.DSH_RETAINED_LIFETIME_OUTPUT!, 'observation.json'), JSON.stringify(observation, null, 2) + '\n')
    if (fault === 'listener') expect(removalFaults, 'listener fault must execute on the actual retained remover').toBeGreaterThan(0)
    expect(drain, 'terminal durable join must finish before successful retained root cleanup').toEqual({ status: 'fulfilled' })
    for (const prefix of prefixes) expect(prefix.committed, 'admitted terminal prefix must equal real JSONL').toEqual(prefix.admitted)
    expect(observation).toMatchObject({
      bodies: ['body', 'cleanup', 'result-flush'].includes(phase) ? 1 : 0,
      cleanups: phase === 'reservation' ? 0 : 1, requests: 0, cleanupState: fault !== undefined ? 'rejected' : 'fulfilled' })
  })
}
