/** Failure transitions with fake writer capabilities; real unknown kernel pins stay in process fixtures. */
import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openedSchema, grantedSchema, revokedSchema, startedSchema } from '../src/execution-state.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionWriterReservation, WriterLifetimeFlush, WriterLifetimeReservation } from '@deepseek-ai/dsh-session-persistence'
import type { ExecutionOwnerOptions } from '../src/execution.ts'
import { fixture, gate } from './execution-harness.ts'

async function fakeFixture(configure?: (options: ExecutionOwnerOptions) => ExecutionOwnerOptions) {
  const writers: { session: Session; pin: SessionWriterReservation }[] = []
  const hooks = {
    reserve: undefined as ((session: Session) => WriterLifetimeReservation | undefined) | undefined,
    flush: undefined as ((session: Session) => Promise<WriterLifetimeFlush>) | undefined,
    release: undefined as ((session: Session) => Promise<WriterLifetimeFlush>) | undefined,
  }
  const f = await fixture({ open: false, configure: (options) => {
    vi.spyOn(options.ctx.sessionPersistence, 'reserveSessionWriter').mockImplementation((session) => {
      const override = hooks.reserve?.(session)
      if (override !== undefined) return override
      const abort = new AbortController()
      const pin: SessionWriterReservation = {
        signal: abort.signal,
        checkDispatch: () => abort.signal.aborted ? { kind: 'refused', reason: 'fenced' } : undefined,
        flushDurably: () => hooks.flush?.(session) ?? Promise.resolve({ kind: 'durable', boundary: session.seq }),
        release: () => { abort.abort(); return hooks.release?.(session) ?? Promise.resolve({ kind: 'durable', boundary: session.seq }) },
      }
      writers.push({ session, pin })
      return { kind: 'reserved', reservation: pin }
    })
    return configure?.(options) ?? options
  } })
  // No real writer was pinned. The retained Session handles remain ordinary unpinned storage.
  const dispose = async () => { await f.owner.dispose().catch(() => {}); await f.disposeResources() }
  return { ...f, hooks, writers, dispose }
}

for (const missing of ['root', 'participant'] as const) {
  it(`rolls back missing ${missing} recovery state without publishing authority`, async () => {
    const f = await fakeFixture(options => ({ ...options, state: new Map([...options.state].filter(([session]) =>
      missing === 'root' ? session !== options.root : session === options.root)) }))
    try {
      await expect(f.owner.open()).rejects.toThrow(`missing-${missing}-state`)
      expect(f.writers.every(row => row.pin.signal.aborted)).toBe(true)
      expect(f.owner.snapshot()).toMatchObject({ owner: null, generation: 0 })
    } finally { await f.dispose() }
  })
}

it('does not acquire or append after an already aborted lifetime', async () => {
  const abort = new AbortController(); abort.abort(new Error('task ended'))
  const f = await fakeFixture(options => ({ ...options, signal: abort.signal }))
  try { await expect(f.owner.open()).rejects.toThrow('task ended'); expect(f.writers).toHaveLength(0) }
  finally { await f.dispose() }
})

it('rolls back provider reentry into disposal without awaiting its own opening', async () => {
  const f = await fakeFixture()
  let disposal: Promise<void> | undefined
  f.hooks.reserve = () => { f.hooks.reserve = undefined; disposal = f.owner.dispose(); return undefined }
  try {
    await expect(f.owner.open()).rejects.toThrow('disposed')
    await disposal
    expect(f.owner.snapshot().phase).toBe('stopped')
    expect(f.writers).toHaveLength(1)
    expect(f.writers[0]?.pin.signal.aborted).toBe(true)
  } finally { await f.dispose() }
})

for (const stage of ['opening', 'grant', 'revoke', 'start', 'result', 'release', 'setup-release'] as const) {
  it(`retains explicit blocked ownership on fake ${stage} durability failure`, async () => {
    const f = await fakeFixture()
    try {
      if (stage !== 'opening') await f.owner.open()
      if (['start', 'result', 'release', 'setup-release'].includes(stage)) await f.grant()
      if (stage === 'release' || stage === 'setup-release') f.hooks.release = async () => { throw new Error('release failed') }
      else f.hooks.flush = async (session) => {
        const entry = f.projection.stateOf(f.child.session).entries[0]
        const fail = ['opening', 'grant', 'revoke'].includes(stage) || session === f.child.session
          && (stage === 'start' || entry?.settlement !== null)
        return fail ? { kind: 'refused', reason: 'uncertain' } : { kind: 'durable', boundary: session.seq }
      }
      if (stage === 'opening') await expect(f.owner.open()).rejects.toThrow('root-durability')
      else if (stage === 'grant') await expect(f.grant()).rejects.toThrow('root-durability')
      else if (stage === 'revoke') await expect(f.owner.revoke('cancel')).rejects.toThrow('drain-unknown')
      else {
        if (stage === 'setup-release') f.control.classification = undefined
        await expect(f.owner.attempt(f.bind(), 'edit')).rejects.toThrow()
        expect(f.owner.snapshot().unknown).toHaveLength(1)
      }
      expect(f.owner.snapshot()).toMatchObject({ phase: 'blocked', owner: null })
      await expect(f.grant()).rejects.toThrow(stage === 'revoke' ? 'drain-unknown' : 'not-drained')
      await expect(f.owner.dispose()).rejects.toThrow()
    } finally { await f.dispose() }
  })
}

it('does not reuse an aborted grant generation and retains its cause', async () => {
  const f = await fakeFixture()
  try {
    await f.owner.open()
    f.hooks.flush = async () => { throw new Error('grant storage failed') }
    await expect(f.grant()).rejects.toThrow('grant storage failed')
    expect(f.owner.snapshot()).toMatchObject({ generation: 1, owner: null, phase: 'blocked' })
    await expect(f.grant()).rejects.toThrow('not-drained')
    expect(f.owner.snapshot().generation).toBe(1)
  } finally { await f.dispose() }
})

function seedUnknown(f: Awaited<ReturnType<typeof fakeFixture>>) {
  const incarnation = randomUUID()
  f.root.session.append('fusion/execution-opened', openedSchema.parse({ version: 1, rootSessionId: f.root.session.id,
    incarnation, openingId: randomUUID(), previous: null }))
  f.root.session.append('fusion/execution-granted', grantedSchema.parse({ rootSessionId: f.root.session.id,
    incarnation, generation: 1, participantId: f.child.session.id, previousRevoke: null }))
  const start = startedSchema.parse({ rootSessionId: f.root.session.id, participantId: f.child.session.id,
    incarnation, runId: randomUUID(), attemptId: randomUUID(), generation: 1, adapter: 'fake-host', revision: 'fake-1',
    classification: 'mutation', requestHash: 'a'.repeat(64) })
  f.child.session.append('fusion/effect-started', start)
  return start.attemptId
}

for (const mode of ['completed', 'not-executed', 'observe', 'durability', 'release', 'mismatch', 'unsupported'] as const) {
  it(`keeps recovered effects closed and handles independent ${mode} evidence`, async () => {
    const observe = vi.fn(async () => {
      if (mode === 'observe') throw new Error('observation failed')
      return mode === 'not-executed' ? 'not-executed' as const : 'completed' as const
    })
    const f = await fakeFixture(options => ({ ...options, adapters: options.adapters.map(adapter => ({ ...adapter,
      revision: mode === 'mismatch' ? 'wrong' : adapter.revision,
      ...mode === 'unsupported' ? {} : { reconcile: observe },
    })) }))
    try {
      const attempt = seedUnknown(f)
      await f.owner.open()
      expect(f.owner.snapshot()).toMatchObject({ owner: null, phase: 'blocked', unknown: [attempt], generation: 1 })
      expect(f.control.bodies).toBe(0)
      await expect(f.owner.reconcile({}, f.issuer, attempt)).rejects.toThrow('integration-missing')
      await expect(f.owner.reconcile(f.controller, {}, attempt)).rejects.toThrow('integration-missing')
      if (mode === 'durability') f.hooks.flush = async () => ({ kind: 'refused', reason: 'uncertain' })
      if (mode === 'release') f.hooks.release = async () => ({ kind: 'refused', reason: 'uncertain' })
      const work = f.owner.reconcile(f.controller, f.issuer, attempt)
      if (['completed', 'not-executed'].includes(mode)) {
        await work
        expect(observe).toHaveBeenCalledTimes(1)
        const entry = f.projection.stateOf(f.child.session).entries[0]
        expect(entry?.settlement).toBeNull()
        expect(entry?.reconciliation?.disposition).toBe(mode)
        expect(f.owner.snapshot().unknown).toHaveLength(0)
        await expect(f.owner.reconcile(f.controller, f.issuer, attempt)).rejects.toThrow('not-recoverable')
        await f.grant()
        expect(f.owner.snapshot()).toMatchObject({ generation: 2, phase: 'granted' })
      } else {
        await expect(work).rejects.toThrow()
        expect(f.owner.snapshot().unknown).toEqual([attempt])
        await expect(f.owner.dispose()).rejects.toThrow()
      }
      expect(f.control.bodies).toBe(0)
    } finally { await f.dispose() }
  })
}

it('registers reconciliation before its observer callback and memoizes concurrent joins through revocation', async () => {
  const hold = gate()
  const f = await fakeFixture(options => ({ ...options, adapters: options.adapters.map(adapter => ({ ...adapter,
    reconcile: async () => { hold.entered.resolve(undefined); await hold.resume.promise; return 'completed' },
  })) }))
  let work: Promise<void> | undefined, revoked: Promise<void> | undefined
  try {
    const attempt = seedUnknown(f)
    await f.owner.open()
    work = f.owner.reconcile(f.controller, f.issuer, attempt)
    expect(f.writers).toHaveLength(3)
    expect(f.owner.reconcile(f.controller, f.issuer, attempt)).toBe(work)
    await hold.entered.promise
    revoked = f.owner.revoke('handoff')
    hold.resume.resolve(undefined)
    await work; await revoked
    expect(f.projection.stateOf(f.child.session).entries[0]?.settlement).toBeNull()
  } finally { hold.resume.resolve(undefined); await Promise.allSettled([work, revoked]); await f.dispose() }
})

it('denies grants before initialization without advancing generation', async () => {
  const f = await fakeFixture()
  try {
    await expect(f.grant()).rejects.toThrow('not-drained')
    expect(f.owner.snapshot().generation).toBe(0)
    await f.owner.open()
    await f.grant()
    expect(f.owner.snapshot().generation).toBe(1)
  } finally { await f.dispose() }
})

it('contains a duplicate final dispatch and refuses its second synchronous invocation', async () => {
  const decisions: (Error | undefined)[] = []
  const f = await fakeFixture(options => ({ ...options, adapters: options.adapters.map(adapter => ({ ...adapter,
    prepare: async () => ({ run: async (fence) => {
      decisions.push(fence(), fence())
      return 'completed'
    }, cleanup: async () => {} }),
  })) }))
  try {
    await f.owner.open(); await f.grant()
    await f.owner.attempt(f.bind(), 'edit')
    expect(decisions[0]).toBeUndefined()
    expect(decisions[1]?.message).toContain('dispatch-fenced')
  } finally { await f.dispose() }
})

for (const phase of ['prepare', 'body', 'cleanup', 'release-refusal'] as const) {
  it(`contains ${phase} failure without granting a successor or replaying`, async () => {
    const f = await fakeFixture(options => ({ ...options, adapters: options.adapters.map(adapter => ({ ...adapter,
      prepare: async () => {
        if (phase === 'prepare') throw new Error('prepare failed')
        return { run: async (fence) => {
          if (fence() !== undefined) return 'failed'
          if (phase === 'body') throw new Error('body outcome unknown')
          return 'completed'
        }, cleanup: async () => { if (phase === 'cleanup') throw new Error('cleanup unknown') } }
      },
    })) }))
    try {
      await f.owner.open(); await f.grant()
      if (phase === 'release-refusal') f.hooks.release = async () => ({ kind: 'refused', reason: 'uncertain' })
      const work = f.owner.attempt(f.bind(), 'edit')
      if (phase === 'prepare') {
        await work
        expect(f.owner.snapshot().attempts).toHaveLength(0)
      } else {
        await expect(work).rejects.toThrow()
        expect(f.owner.snapshot().unknown).toHaveLength(1)
      }
      await expect(f.grant()).rejects.toThrow('not-drained')
    } finally { await f.dispose() }
  })
}

it('retains failed initialization rollback and transport drain ownership', async () => {
  const f = await fakeFixture()
  f.hooks.reserve = session => session === f.child.session ? { kind: 'refused', reason: 'missing-writer' } : undefined
  f.hooks.release = async () => { throw new Error('rollback unknown') }
  try {
    await expect(f.owner.open()).rejects.toThrow('initialization-cleanup')
    expect(f.owner.snapshot().phase).toBe('blocked')
    await expect(f.owner.dispose()).rejects.toThrow('cleanup-unknown')
  } finally { await f.dispose() }
})

it('does not release lifetime capabilities on transport drain failure', async () => {
  const f = await fakeFixture(options => ({ ...options, drain: async () => { throw new Error('transport failed') } }))
  const released: Session[] = []
  f.hooks.release = async (session) => { released.push(session); return { kind: 'durable', boundary: session.seq } }
  try {
    await f.owner.open()
    await expect(f.owner.dispose()).rejects.toThrow('transport failed')
    expect(released).toHaveLength(0)
    expect(f.owner.snapshot().phase).toBe('blocked')
  } finally { await f.dispose() }
})

it('refuses setup acquisition and retains a refused setup release', async () => {
  const f = await fakeFixture()
  try {
    await f.owner.open(); await f.grant()
    f.hooks.reserve = () => ({ kind: 'refused', reason: 'fenced' })
    await expect(f.owner.attempt(f.bind(), 'edit')).rejects.toThrow('fenced')
    expect(f.owner.snapshot().attempts).toHaveLength(0)
    f.hooks.reserve = undefined
    f.control.classification = undefined
    f.hooks.release = async () => ({ kind: 'refused', reason: 'uncertain' })
    await expect(f.owner.attempt(f.bind(), 'edit')).rejects.toThrow('setup-cleanup')
    expect(f.owner.snapshot().unknown).toHaveLength(1)
  } finally { await f.dispose() }
})

it('releases dormant lifetime capabilities only after their durable result', async () => {
  const f = await fakeFixture(options => ({ ...options, adapters: [] }))
  f.hooks.release = async () => ({ kind: 'refused', reason: 'uncertain' })
  try {
    await expect(f.owner.open()).rejects.toThrow('writer-release')
    await expect(f.owner.dispose()).rejects.toThrow('cleanup-unknown')
  } finally { await f.dispose() }
})

it('contains cancellation callbacks and memoizes the resulting disposal', async () => {
  const signal = new AbortController()
  const f = await fakeFixture(options => ({ ...options, signal: signal.signal }))
  try {
    await f.owner.open()
    signal.abort()
    const done = f.owner.dispose()
    expect(f.owner.dispose()).toBe(done)
    await done
    expect(f.owner.snapshot().phase).toBe('stopped')
  } finally { await f.dispose() }
})

for (const fault of ['session', 'membership', 'participant-history', 'root', 'participant', 'attempt', 'run', 'incarnation', 'grant', 'absent-grant'] as const) {
  it(`starts closed on conflicting cross-session ${fault} history`, async () => {
    const f = await fakeFixture(options => ({ ...options, state: new Map([...options.state].map(([session, read]) => [session, () => {
      const state = read()
      if (session === options.root) {
        return fault === 'absent-grant' ? { ...state, history: state.history.map(row => row.type === 'granted'
          ? { ...row, data: { ...row.data, participantId: options.root.id } } : row) } : state
      }
      if (fault === 'absent-grant') return { ...state, entries: [] }
      if (fault === 'session') return { ...state, sessionId: options.root.id }
      if (fault === 'membership' && options.participants instanceof Map) options.participants.delete(session.id)
      if (fault === 'participant-history') return { ...state, history: options.state.get(options.root)!().history }
      return { ...state, entries: state.entries.flatMap((entry) => {
        if (fault === 'root') return [{ ...entry, start: { ...entry.start, rootSessionId: session.id } }]
        if (fault === 'participant') return [{ ...entry, start: { ...entry.start, participantId: options.root.id } }]
        if (fault === 'attempt') return [entry, entry]
        if (fault === 'run') return [entry, { ...entry, start: { ...entry.start,
          attemptId: startedSchema.shape.attemptId.parse(randomUUID()), revision: 'foreign' } }]
        if (fault === 'incarnation') return [{ ...entry, start: { ...entry.start, incarnation: startedSchema.shape.incarnation.parse(randomUUID()) } }]
        if (fault === 'grant') return [{ ...entry, start: { ...entry.start, generation: grantedSchema.shape.generation.parse(2) } }]
        return [entry]
      }) }
    }])) }))
    try {
      seedUnknown(f)
      await expect(f.owner.open()).rejects.toThrow('conflicting-task-history')
      expect(f.owner.snapshot()).toMatchObject({ phase: 'blocked', owner: null })
      expect(f.control.bodies).toBe(0)
      await expect(f.owner.dispose()).rejects.toThrow('cleanup-unknown')
    } finally { await f.dispose() }
  })
}

it('recovers settled and independently reconciled entries without effect replay', async () => {
  const f = await fakeFixture()
  try {
    const attempt = seedUnknown(f)
    const first = f.projection.stateOf(f.child.session).entries[0]!
    const { rootSessionId, participantId, incarnation, runId, generation } = first.start
    f.child.session.append('fusion/effect-settled', { rootSessionId, participantId, incarnation, runId, generation, attemptId: attempt, outcome: 'completed' })
    const second = { ...first.start, attemptId: startedSchema.shape.attemptId.parse(randomUUID()) }
    f.child.session.append('fusion/effect-started', second)
    f.child.session.append('fusion/effect-reconciled', { rootSessionId, participantId, incarnation, runId, generation,
      attemptId: second.attemptId, evidenceId: randomUUID(), source: 'fake-host', disposition: 'not-executed' })
    await f.owner.open()
    expect(f.owner.snapshot()).toMatchObject({ phase: 'closed', unknown: [] })
    expect(f.control.bodies).toBe(0)
  } finally { await f.dispose() }
})

it('does not promote recovery when one of several unknown effects is reconciled', async () => {
  const f = await fakeFixture(options => ({ ...options, adapters: options.adapters.map(adapter => ({ ...adapter,
    reconcile: async () => 'completed',
  })) }))
  try {
    const attempt = seedUnknown(f)
    const first = f.projection.stateOf(f.child.session).entries[0]!
    f.child.session.append('fusion/effect-started', { ...first.start, attemptId: startedSchema.shape.attemptId.parse(randomUUID()) })
    await f.owner.open()
    await f.owner.reconcile(f.controller, f.issuer, attempt)
    expect(f.owner.snapshot().unknown).toHaveLength(1)
    expect(f.owner.snapshot().phase).toBe('blocked')
  } finally { await f.dispose() }
})

it('retains recovery ownership when a new reconciliation writer cannot be reserved', async () => {
  const f = await fakeFixture(options => ({ ...options, adapters: options.adapters.map(adapter => ({ ...adapter,
    reconcile: async () => 'completed',
  })) }))
  try {
    const attempt = seedUnknown(f)
    await f.owner.open()
    f.hooks.reserve = () => ({ kind: 'refused', reason: 'missing-writer' })
    await expect(f.owner.reconcile(f.controller, f.issuer, attempt)).rejects.toThrow('missing-writer')
    expect(f.owner.snapshot().unknown).toEqual([attempt])
  } finally { await f.dispose() }
})

it('joins a pending handoff before recording stop during reentrant disposal', async () => {
  const f = await fakeFixture()
  const hold = gate()
  try {
    await f.owner.open(); await f.grant()
    f.hooks.flush = async (session) => {
      if (session === f.root.session) { hold.entered.resolve(undefined); await hold.resume.promise }
      return { kind: 'durable', boundary: session.seq }
    }
    const handoff = f.owner.revoke('handoff')
    await hold.entered.promise
    const disposal = f.owner.dispose()
    hold.resume.resolve(undefined)
    await handoff; await disposal
    expect(f.owner.snapshot().phase).toBe('stopped')
    expect(f.projection.stateOf(f.root.session).revoke?.reason).toBe('stop')
  } finally { hold.resume.resolve(undefined); await f.dispose() }
})

it('contains a non-Error host classification failure at final dispatch', async () => {
  let calls = 0
  const f = await fakeFixture(options => ({ ...options, adapters: options.adapters.map(adapter => ({ ...adapter,
    classify: () => { if (++calls === 2) throw 'classification unavailable'; return 'mutation' },
  })) }))
  try {
    await f.owner.open(); await f.grant()
    await f.owner.attempt(f.bind(), 'edit')
    expect(f.control.bodies).toBe(0)
    expect(f.projection.stateOf(f.child.session).entries[0]?.settlement?.outcome).toBe('not-dispatched')
  } finally { await f.dispose() }
})

it('refuses duplicate issuer identities without attaching a task listener', async () => {
  let called = false
  await expect(fakeFixture((options) => {
    called = true
    return { ...options, adapters: [...options.adapters, ...options.adapters] }
  })).rejects.toThrow('duplicate-issuer')
  expect(called).toBe(true)
})

it('refuses a revoke without initialization instead of journaling without an exact writer', async () => {
  const f = await fakeFixture()
  try {
    await expect(f.owner.revoke('stop')).rejects.toThrow('drain-unknown')
    expect(f.projection.stateOf(f.root.session).history).toHaveLength(0)
    expect(f.owner.snapshot().phase).toBe('blocked')
  } finally { await f.dispose() }
})


it('denies missing production integration even with the exact private controller and live Agent', async () => {
  const f = await fakeFixture(options => ({ ...options, adapters: [] }))
  try {
    await f.owner.open()
    await expect(f.grant()).rejects.toThrow('integration-missing')
    expect(() => f.bind()).toThrow('integration-missing')
    expect(f.owner.snapshot()).toMatchObject({ owner: null, phase: 'closed', blockers: ['integration-missing'] })
    expect(f.control.bodies).toBe(0)
  } finally { await f.dispose() }
})

for (const observation of ['drain', 'successor'] as const) {
  it(`retains ${observation} ownership after revoke durability while cleanup is held`, async () => {
    const f = await fakeFixture()
    const cleanup = gate(), durable = Promise.withResolvers<undefined>()
    let work: Promise<unknown> | undefined, revoked: Promise<void> | undefined, successor: Promise<void> | undefined
    let joined = false, granted = false
    try {
      await f.owner.open(); await f.grant()
      f.control.cleanup = cleanup
      work = f.owner.attempt(f.bind(), 'edit')
      await cleanup.entered.promise
      f.hooks.flush = async (session) => {
        if (session === f.root.session && f.projection.stateOf(session).revoke !== null) durable.resolve(undefined)
        return { kind: 'durable', boundary: session.seq }
      }
      revoked = f.owner.revoke('handoff')
      void revoked.then(() => { joined = true }, () => {})
      await durable.promise
      // Instant fake durable barriers remove filesystem latency as an alternative explanation.
      await new Promise<void>(resolve => setImmediate(resolve))
      if (observation === 'drain') expect(joined).toBe(false)
      else {
        successor = f.grant()
        void successor.then(() => { granted = true }, () => {})
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(granted).toBe(false)
        expect(f.owner.snapshot().generation).toBe(1)
      }
      cleanup.resume.resolve(undefined)
      await work; await revoked; await successor
    } finally {
      cleanup.resume.resolve(undefined)
      await Promise.allSettled([work, revoked, successor])
      await f.dispose()
    }
  })
}

it('rejects a recovered run identity reused across grant generations', async () => {
  const f = await fakeFixture()
  try {
    seedUnknown(f)
    const first = f.projection.stateOf(f.child.session).entries[0]!
    const { rootSessionId, incarnation } = first.start
    f.root.session.append('fusion/execution-revoked', revokedSchema.parse({
      rootSessionId, incarnation, generation: 1, reason: 'handoff', stopped: false }))
    f.root.session.append('fusion/execution-granted', grantedSchema.parse({
      rootSessionId, incarnation, generation: 2, participantId: f.child.session.id, previousRevoke: 1 }))
    f.child.session.append('fusion/effect-started', startedSchema.parse({ ...first.start, generation: 2, attemptId: randomUUID() }))
    await expect(f.owner.open()).rejects.toThrow('conflicting-task-history')
    expect(f.writers.every(row => !row.pin.signal.aborted)).toBe(true)
    await expect(f.owner.dispose()).rejects.toThrow('cleanup-unknown')
  } finally { await f.dispose() }
})


it('recovers mixed read and mutation attempts without treating read scope as a grant generation', async () => {
  const f = await fakeFixture()
  try {
    seedUnknown(f)
    const start = f.projection.stateOf(f.child.session).entries[0]!.start
    const anotherRun = randomUUID()
    for (const [runId, classification] of [
      [start.runId, 'read'], [start.runId, 'mutation'], [anotherRun, 'read'], [anotherRun, 'mutation'],
    ] as const) f.child.session.append('fusion/effect-started', startedSchema.parse({ ...start, runId, classification,
      generation: classification === 'mutation' ? 1 : null, attemptId: randomUUID() }))
    await f.owner.open()
    expect(f.owner.snapshot()).toMatchObject({ phase: 'blocked', owner: null })
    expect(f.owner.snapshot().unknown).toHaveLength(5)
    expect(f.control.bodies).toBe(0)
  } finally { await f.dispose() }
})
