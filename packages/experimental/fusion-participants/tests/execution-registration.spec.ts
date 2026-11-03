/** Exact public host credentials, dormant held identities and one-shot owner invocation. */
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { publicFixture } from './execution-public-harness.ts'
import { gate } from './execution-harness.ts'
import { read, mount } from './harness.ts'
import type { ExecutionSettlement } from '../src/index.ts'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'

it('joins exact enrollment and register/release retries while observing held counters in the same run', async () => {
  const f = await publicFixture()
  try {
    expect(await f.ctx.fusionParticipants.registerExecutionHost(f.task, f.provider)).toBe(f.host)
    expect(f.task.execution).toMatchObject({ phase: 'closed', owner: null })
    await f.grant()
    const attempt = f.host.reserve(f.bind(), 'edit')
    expect(f.task.execution.attempts).toHaveLength(1)
    const registration = f.host.register(attempt)
    expect(f.host.register(attempt)).toBe(registration)
    await registration
    expect(f.control.identities.has(attempt)).toBe(true)
    expect([f.control.registrations, f.control.preparations, f.control.bodies, f.model.requests.length]).toEqual([1, 0, 0, 0])
    const release = f.host.release(attempt)
    expect(f.host.release(attempt)).toBe(release)
    expect(await release).toEqual({ kind: 'settled', outcome: 'completed' })
    expect([f.control.preparations, f.control.bodies, f.control.cleanups]).toEqual([1, 1, 1])
    const events = await read(f.ctx, f.adopted.agent.session.id)
    expect(events.filter(e => e.type.startsWith('fusion/effect-')).map(e => e.type)).toEqual(['fusion/effect-started', 'fusion/effect-settled'])
    expect((await read(f.ctx, f.task.roster.rootSessionId)).some(e => e.type.startsWith('fusion/effect-'))).toBe(false)
    const another = f.host.reserve(f.bind(), 'edit')
    expect(another).not.toBe(attempt)
    await f.host.register(another)
    await f.host.release(another)
    expect(f.control.bodies).toBe(2)
  } finally { await f.dispose() }
})

it('refuses task, provider, issuer, controller, run and attempt copies and proxies before preparation', async () => {
  const f = await publicFixture(), other = await publicFixture()
  try {
    for (const task of [{ ...f.task }, new Proxy(f.task, {}), other.task]) {
      await expect(f.ctx.fusionParticipants.registerExecutionHost(task, f.provider)).rejects.toThrow('identity')
    }
    for (const provider of [{ ...f.provider }, new Proxy(f.provider, {})]) {
      await expect(f.ctx.fusionParticipants.registerExecutionHost(f.task, provider)).rejects.toThrow('host-replacement')
    }
    for (const issuer of [{ ...f.host.issuer }, new Proxy(f.host.issuer, {}), other.host.issuer]) {
      expect(() => f.host.bindRun(issuer, f.adopted.agent, new AbortController().signal)).toThrow()
    }
    await expect(f.host.grant({ ...f.host.controller }, f.adopted.agent.session.id)).rejects.toThrow()
    await expect(f.host.revoke(new Proxy(f.host.controller, {}), 'cancel')).rejects.toThrow('identity')
    expect(() => f.host.bindRun(f.host.issuer, new Proxy(f.adopted.agent, {}), new AbortController().signal)).toThrow('not-live')
    await f.grant()
    const run = f.bind()
    for (const copy of [{ ...run }, new Proxy(run, {}), other.bind()]) expect(() => f.host.reserve(copy, 'edit')).toThrow('identity')
    const attempt = f.host.reserve(run, 'edit')
    for (const copy of [{ ...attempt }, new Proxy(attempt, {}), other.host.reserve(other.bind(), 'inspect')]) {
      await expect(f.host.register(copy)).rejects.toThrow('identity')
      await expect(f.host.release(copy)).rejects.toThrow('identity')
    }
    await expect(f.host.release(attempt)).rejects.toThrow('not-registered')
    expect(f.control.preparations).toBe(0)
  } finally { await other.dispose(); await f.dispose() }
})

it('invalidates every old run across generations, abort and Agent replacement', async () => {
  const f = await publicFixture()
  try {
    const beforeGrant = f.bind()
    await f.grant()
    f.control.classification = 'read'
    expect(() => f.host.reserve(beforeGrant, 'inspect')).toThrow('stale-run')
    const abort = new AbortController(), run = f.bind(abort.signal)
    abort.abort(new Error('run ended'))
    expect(() => f.host.reserve(run, 'inspect')).toThrow('run ended')
    const old = f.bind()
    await f.adopted.dispose()
    const replacement = await f.task.adopt('participant')
    try {
      expect(() => f.host.reserve(old, 'inspect')).toThrow('not-live')
      expect(() => f.host.bindRun(f.host.issuer, f.adopted.agent, new AbortController().signal)).toThrow('not-live')
      const next = f.host.reserve(f.host.bindRun(f.host.issuer, replacement.agent, new AbortController().signal), 'inspect')
      await f.host.register(next); await f.host.release(next)
    } finally { await replacement.dispose() }
  } finally { await f.dispose() }
})

it('publishes registration and release joins before synchronous provider reentry', async () => {
  const f = await publicFixture()
  try {
    await f.grant()
    const attempt = f.host.reserve(f.bind(), 'edit')
    let reentry: Promise<void> | undefined
    f.control.onRegister = (token) => { reentry = f.host.register(token) }
    const registered = f.host.register(attempt)
    expect(reentry).toBe(registered)
    await registered
    let repeated: Promise<ExecutionSettlement> | undefined
    f.control.onInvoke = () => { repeated = f.host.release(attempt) }
    const released = f.host.release(attempt)
    await released
    expect(repeated).toBe(released)
    expect(f.control.bodies).toBe(1)
  } finally { await f.dispose() }
})

for (const phase of ['prepare', 'body', 'cleanup', 'start', 'result'] as const) {
  it(`cuts admission immediately and joins ${phase} before a same-task successor`, async () => {
    const f = await publicFixture(), hold = gate()
    if (phase === 'prepare' || phase === 'body' || phase === 'cleanup') f.control[phase] = hold
    // oxlint-disable-next-line typescript/unbound-method -- called with the exact JSONL handle receiver.
    const flush = JsonlSessionHandle.prototype.flushRetained
    let intercepted = false
    if (phase === 'start' || phase === 'result') {
      vi.spyOn(JsonlSessionHandle.prototype, 'flushRetained').mockImplementation(async function (this: JsonlSessionHandle, session, seq) {
        if (this.id === f.adopted.agent.session.id && !intercepted
          && session.ownEvents().some(e => e.type === (phase === 'start' ? 'fusion/effect-started' : 'fusion/effect-settled'))) {
          intercepted = true; hold.entered.resolve(undefined); await hold.resume.promise
        }
        return flush.call(this, session, seq)
      })
    }
    let work: Promise<ExecutionSettlement> | undefined, revoked: Promise<void> | undefined, successor: Promise<void> | undefined
    try {
      await f.grant()
      const run = f.bind(), attempt = f.host.reserve(run, 'edit')
      await f.host.register(attempt)
      work = f.host.release(attempt)
      await hold.entered.promise
      expect(f.control.bodies).toBe(phase === 'start' || phase === 'prepare' ? 0 : 1)
      revoked = f.host.revoke(f.host.controller, 'handoff')
      expect(f.task.execution.owner).toBeNull()
      expect(f.control.cancellations).toBe(1)
      expect(() => f.host.reserve(run, 'edit')).toThrow()
      let granted = false
      successor = f.grant().then(() => { granted = true })
      await setImmediate()
      expect(granted).toBe(false)
      expect(f.task.execution.attempts).toHaveLength(1)
      if (phase === 'cleanup') expect(f.adopted.agent.session.ownEvents().some(e => e.type === 'fusion/effect-settled')).toBe(false)
      hold.resume.resolve(undefined)
      await work; await revoked; await successor
      expect(f.control.cleanups).toBe(1)
      expect(f.control.bodies).toBe(phase === 'start' || phase === 'prepare' ? 0 : 1)
      expect(f.task.execution.generation).toBe(2)
    } finally {
      hold.resume.resolve(undefined); await Promise.allSettled([work, revoked, successor]); await f.dispose()
    }
  })
}

it('cancels an unreleased held identity and reserved-only token without waiting for release', async () => {
  const f = await publicFixture()
  try {
    await f.grant()
    const attempt = f.host.reserve(f.bind(), 'edit')
    f.host.reserve(f.bind(), 'another')
    await f.host.register(attempt)
    await f.host.revoke(f.host.controller, 'handoff')
    expect([f.control.preparations, f.control.bodies, f.control.cancellations, f.control.cleanups]).toEqual([0, 0, 1, 1])
    expect(await f.host.release(attempt)).toEqual({ kind: 'settled', outcome: 'not-dispatched' })
    expect(f.control.preparations).toBe(0)
    await f.grant()
  } finally { await f.dispose() }
})

it('joins independently available cleanup after preparation allocated and rejected', async () => {
  const f = await publicFixture(), hold = gate()
  f.control.prepareError = new Error('allocated before failure')
  f.control.cleanup = hold
  try {
    await f.grant()
    const attempt = f.host.reserve(f.bind(), 'edit')
    await f.host.register(attempt)
    const release = f.host.release(attempt)
    await hold.entered.promise
    let settled = false
    void release.then(() => { settled = true })
    await setImmediate()
    expect(settled).toBe(false)
    expect(f.control.bodies).toBe(0)
    hold.resume.resolve(undefined)
    expect(await release).toEqual({ kind: 'settled', outcome: 'not-dispatched' })
    expect(f.control.cleanups).toBe(1)
  } finally { hold.resume.resolve(undefined); await f.dispose() }
})

for (const race of ['classification', 'revoke-in-classification', 'run-abort', 'detach'] as const) {
  it(`rechecks actual authority after asynchronous preparation: ${race}`, async () => {
    const f = await publicFixture(), hold = gate()
    f.control.prepare = hold
    try {
      await f.grant()
      const abort = new AbortController(), attempt = f.host.reserve(f.bind(abort.signal), 'edit')
      await f.host.register(attempt)
      const work = f.host.release(attempt)
      await hold.entered.promise
      let revoke: Promise<void> | undefined
      if (race === 'classification') f.control.classification = 'read'
      if (race === 'revoke-in-classification') f.control.onClassify = () => {
        f.control.onClassify = undefined; revoke = f.host.revoke(f.host.controller, 'handoff')
      }
      if (race === 'run-abort') abort.abort()
      if (race === 'detach') await f.adopted.dispose()
      hold.resume.resolve(undefined)
      expect(await work).toEqual({ kind: 'settled', outcome: 'not-dispatched' })
      await revoke
      expect(f.control.bodies).toBe(0)
      expect(f.control.cleanups).toBe(1)
    } finally { hold.resume.resolve(undefined); await f.dispose() }
  })
}

it('rechecks a synchronous registration callback that revokes before returning its anchor', async () => {
  const f = await publicFixture()
  let revoke: Promise<void> | undefined
  try {
    await f.grant()
    const attempt = f.host.reserve(f.bind(), 'edit')
    f.control.onRegister = () => { revoke = f.host.revoke(f.host.controller, 'handoff') }
    await expect(f.host.register(attempt)).rejects.toThrow()
    await revoke
    expect([f.control.cancellations, f.control.cleanups, f.control.preparations, f.control.bodies]).toEqual([1, 1, 0, 0])
  } finally { await f.dispose() }
})

it('keeps defaults closed without registering or preparing a provider', async () => {
  const { ctx, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  try {
    expect(task.execution).toMatchObject({ phase: 'closed', owner: null, blockers: ['integration-missing'] })
    expect(adapter.requests).toHaveLength(0)
    expect(Object.values(task.execution).some(value => typeof value === 'function')).toBe(false)
  } finally { await task.dispose() }
})

it('owns host withdrawal in the declaring fiber and joins held cleanup before withdrawal completes', async () => {
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  let caller: ReturnType<typeof createScope> | undefined
  const f = await publicFixture((ctx, task, provider) => {
    caller = createScope(ctx, {})
    return caller.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
  })
  const hold = gate()
  f.control.cleanup = hold
  try {
    await expect(f.ctx.fusionParticipants.registerExecutionHost(f.task, f.provider)).rejects.toThrow('host-replacement')
    await f.grant()
    const attempt = f.host.reserve(f.bind(), 'edit')
    await f.host.register(attempt)
    let disposed = false
    const disposal = caller!.dispose().then(() => { disposed = true })
    expect(() => f.host.reserve(f.bind(), 'edit')).toThrow()
    await hold.entered.promise
    expect(disposed).toBe(false)
    expect(f.control.bodies).toBe(0)
    hold.resume.resolve(undefined)
    await disposal
    expect(disposed).toBe(true)
    await expect(f.ctx.fusionParticipants.registerExecutionHost(f.task, f.provider)).rejects.toThrow()
  } finally { hold.resume.resolve(undefined); await f.dispose() }
})

it('re-pins the exact retained root then sorted participant writers after empty-open release', async () => {
  const { ctx } = await mount()
  const reserve = ctx.sessionPersistence.reserveSessionWriter.bind(ctx.sessionPersistence)
  const observed: { session: Parameters<typeof reserve>[0]; released: boolean }[] = []
  vi.spyOn(ctx.sessionPersistence, 'reserveSessionWriter').mockImplementation((session) => {
    const result = reserve(session)
    if (result.kind !== 'reserved') return result
    const row = { session, released: false }
    observed.push(row)
    const release = result.reservation.release.bind(result.reservation)
    return { kind: 'reserved', reservation: { ...result.reservation, release: async () => { row.released = true; return release() } } }
  })
  const task = await ctx.fusionParticipants.prepare('top')
  const initial = observed.slice()
  const retainedCount = task.roster.participants.length + 1
  const emptyOpen = initial.slice(retainedCount)
  expect(emptyOpen.every(row => row.released)).toBe(true)
  const host = await ctx.fusionParticipants.registerExecutionHost(task, {
    name: 'pins', revision: '1', classify: () => 'read', registerHeld() { throw new Error('must stay dormant') },
  })
  try {
    expect(observed.slice(initial.length).map(row => row.session)).toEqual(emptyOpen.map(row => row.session))
    expect(observed.slice(initial.length).every(row => !row.released)).toBe(true)
    expect(observed[initial.length]?.session.id).toBe(task.roster.rootSessionId)
    await host.revoke(host.controller, 'handoff')
    expect(observed.slice(initial.length).every(row => !row.released)).toBe(true)
  } finally { await host.dispose(); await task.dispose() }
})

it('rolls back partial enrollment in reverse order and refuses replacement after failure', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('top')
  const reserve = ctx.sessionPersistence.reserveSessionWriter.bind(ctx.sessionPersistence)
  const released: string[] = []
  vi.spyOn(ctx.sessionPersistence, 'reserveSessionWriter').mockImplementation((session) => {
    if (session.id === task.roster.participants.at(-1)?.id) return { kind: 'refused', reason: 'missing-writer' }
    const result = reserve(session)
    if (result.kind !== 'reserved') return result
    const release = result.reservation.release.bind(result.reservation)
    return { kind: 'reserved', reservation: { ...result.reservation, release: async () => { released.push(session.id); return release() } } }
  })
  const provider = { name: 'partial', revision: '1', classify: () => undefined, registerHeld() { throw new Error('unreachable') } }
  try {
    const registration = ctx.fusionParticipants.registerExecutionHost(task, provider)
    expect(ctx.fusionParticipants.registerExecutionHost(task, provider)).toBe(registration)
    await expect(registration).rejects.toThrow('missing-writer')
    expect(released).toEqual([...task.roster.participants.slice(0, -1).map(row => row.id).reverse(), task.roster.rootSessionId])
    await expect(ctx.fusionParticipants.registerExecutionHost(task, { ...provider })).rejects.toThrow('host-replacement')
    expect(task.execution.blockers).toEqual(['integration-missing'])
  } finally { await task.dispose() }
})

it('refuses unclassified registration before held allocation and does not prepare nonowner mutations', async () => {
  const f = await publicFixture()
  try {
    f.control.classification = undefined
    const unknown = f.host.reserve(f.bind(), 'unknown')
    await expect(f.host.register(unknown)).rejects.toThrow()
    f.control.classification = 'mutation'
    const mutation = f.host.reserve(f.bind(), 'edit')
    await expect(f.host.register(mutation)).rejects.toThrow('not-owner')
    expect([f.control.registrations, f.control.preparations, f.control.bodies]).toEqual([0, 0, 0])
  } finally { await f.dispose() }
})

it('keeps exact host capabilities out of Remote markers, tool schemas and real SDK wire requests', async () => {
  const { PassThrough } = await import('node:stream')
  const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')
  const { JsonRpcLineTransport } = await import('@deepseek-ai/dsh-sdk-protocol')
  const { HarnessSdkJsonRpcServer } = await import('../../../sdk/server/src/server.ts')
  const f = await publicFixture()
  const input = new PassThrough(), output = new PassThrough()
  const wire = new JsonRpcLineTransport(input, output), client = new JsonRpcLineTransport(output, input)
  const server = new HarnessSdkJsonRpcServer(f.ctx, wire)
  wire.onRequest((method, params) => server.handleRequest(method, params))
  wire.start(); client.start()
  try {
    expect(remoteMethods(f.ctx.fusionParticipants)).toEqual([])
    const schemas = JSON.stringify(f.ctx.tools.schemas(f.adopted.agent))
    for (const name of ['registerExecutionHost', 'ExecutionIssuer', 'HeldAttempt', 'writer', 'registerHeld']) expect(schemas).not.toContain(name)
    const forged = { taskId: f.task.roster.rootSessionId, incarnation: f.task.execution.incarnation,
      generation: f.task.execution.generation, issuer: {}, controller: {}, run: {}, attempt: {} }
    for (const method of ['fusionParticipants.registerExecutionHost', 'fusion/execute', 'fusion/release']) {
      await expect(client.request(method, forged)).rejects.toThrow('unknown DeepSeek Harness SDK runtime method')
    }
    expect([f.control.registrations, f.control.preparations, f.control.bodies, f.model.requests.length]).toEqual([0, 0, 0, 0])
  } finally {
    await server.shutdown(); wire.close(); client.close(); input.destroy(); output.destroy(); await f.dispose()
  }
})

it('enters the final leaf in the classification stack before a queued run revocation', async () => {
  const f = await publicFixture(), abort = new AbortController()
  const trace: string[] = []
  let classifications = 0, abortedAtLeaf: boolean | undefined
  try {
    await f.grant()
    const attempt = f.host.reserve(f.bind(abort.signal), 'edit')
    f.control.onClassify = () => {
      if (++classifications !== 3) return
      trace.push('final-classification')
      queueMicrotask(() => { trace.push('run-abort'); abort.abort() })
    }
    f.control.onInvoke = () => {
      trace.push('leaf')
      abortedAtLeaf = abort.signal.aborted
    }
    await f.host.register(attempt)
    expect(await f.host.release(attempt)).toEqual({ kind: 'settled', outcome: 'completed' })
    expect(abortedAtLeaf).toBe(false)
    expect(trace).toEqual(['final-classification', 'leaf', 'run-abort'])
    expect([f.control.bodies, f.control.cleanups]).toEqual([1, 1])
  } finally { await f.dispose() }
})

it('refuses exchanged task controllers and runs on both live hosts without affecting their own work', async () => {
  const f = await publicFixture(), other = await publicFixture()
  try {
    for (const [target, foreign] of [[f, other], [other, f]] as const) {
      await expect(target.host.grant(foreign.host.controller, target.adopted.agent.session.id)).rejects.toThrow()
      await expect(target.host.revoke(foreign.host.controller, 'stop')).rejects.toThrow('identity')
      expect(() => target.host.bindRun(foreign.host.issuer, target.adopted.agent, new AbortController().signal)).toThrow()
      expect(() => target.host.bindRun(target.host.issuer, foreign.adopted.agent, new AbortController().signal)).toThrow('not-live')
      expect(() => target.host.reserve(foreign.bind(), 'inspect')).toThrow('identity')
      await target.grant()
      const attempt = target.host.reserve(target.bind(), 'edit')
      await expect(foreign.host.register(attempt)).rejects.toThrow('identity')
      await expect(foreign.host.release(attempt)).rejects.toThrow('identity')
      await target.host.register(attempt)
      expect([target.control.registrations, target.control.preparations, target.control.bodies]).toEqual([1, 0, 0])
      expect(await target.host.release(attempt)).toEqual({ kind: 'settled', outcome: 'completed' })
    }
  } finally { await other.dispose(); await f.dispose() }
})

it('rechecks the original attempt writer after host classification refuses its dispatch', async () => {
  const f = await publicFixture()
  const reserve = f.ctx.sessionPersistence.reserveSessionWriter.bind(f.ctx.sessionPersistence)
  let refuse = false, classifications = 0, checkedRefusal = 0
  vi.spyOn(f.ctx.sessionPersistence, 'reserveSessionWriter').mockImplementation((session) => {
    const result = reserve(session)
    if (result.kind !== 'reserved') return result
    return { kind: 'reserved', reservation: { ...result.reservation, checkDispatch() {
      if (refuse) { checkedRefusal++; return { kind: 'refused', reason: 'fenced' } }
      return result.reservation.checkDispatch()
    } } }
  })
  try {
    await f.grant()
    const attempt = f.host.reserve(f.bind(), 'edit')
    f.control.onClassify = () => { if (++classifications === 3) refuse = true }
    await f.host.register(attempt)
    expect(await f.host.release(attempt)).toEqual({ kind: 'settled', outcome: 'not-dispatched' })
    expect(checkedRefusal).toBe(1)
    expect([f.control.preparations, f.control.bodies, f.control.cleanups]).toEqual([1, 0, 1])
    expect(f.task.execution.unknown).toEqual([])
  } finally { refuse = false; await f.dispose() }
})
