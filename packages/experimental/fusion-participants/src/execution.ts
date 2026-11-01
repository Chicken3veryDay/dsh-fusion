/** Dormant task authority. No production issuer or effect adapter is installed. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionWriterReservation } from '@deepseek-ai/dsh-session-persistence'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { openedSchema, grantedSchema, startedSchema, reconciledSchema } from './execution-state.ts'
import type { ExecutionState, EffectStarted, EffectSettled, ExecutionAttemptId } from './execution-state.ts'

/** Immutable host observation; historical facts never confer execution authority. */
export interface ExecutionSnapshot {
  readonly incarnation: string
  readonly generation: number
  readonly owner: SessionId | null
  readonly phase: 'closed' | 'granted' | 'revoking' | 'blocked' | 'stopped'
  readonly attempts: readonly { readonly attemptId: ExecutionAttemptId; readonly phase: string }[]
  readonly unknown: readonly ExecutionAttemptId[]
  readonly blockers: readonly string[]
}
/** Internal host adapter; production construction supplies an empty set. */
export interface ExecutionAdapter {
  readonly issuer: object
  readonly name: string
  readonly revision: string
  /** Host-owned classification; arbitrary shell/unknown operations must refuse. */
  classify(operation: string): 'read' | 'mutation' | 'infrastructure' | undefined
  /** Independently observe an old external effect; omission refuses reconciliation. */
  reconcile?(start: EffectStarted): Promise<'completed' | 'not-executed'>
  /** Prepare without executing; run must apply the one-shot fence at its final synchronous dispatch. */
  prepare(agent: Agent, operation: string, signal: AbortSignal): Promise<{
    run(finalFence: () => Error | undefined): Promise<'completed' | 'failed' | 'uncertain'>
    cleanup(): Promise<void>
  }>
}
/** Typed refusal; dependent work stays closed and uncertainty never implies rollback. */
export class ExecutionBlockedError extends Error {
  /** Stable host diagnostic category. */
  readonly code = 'fusion/execution-blocked'
  constructor(readonly reason: string, cause?: unknown) { super(`Execution blocked: ${reason}`, { cause }) }
}
interface Run {
  readonly agent: Agent
  readonly adapter: ExecutionAdapter
  readonly signal: AbortSignal
  readonly generation: number
  readonly epoch: number
  readonly runId: string
}
interface Attempt {
  readonly attemptId: ExecutionAttemptId
  readonly abort: AbortController
  readonly done: Promise<void>
  phase: string
  dispatched: boolean
}
/** Owner dependencies retain exact Sessions; projection readers perform no work. */
export interface ExecutionOwnerOptions {
  readonly ctx: Context
  readonly root: Session
  readonly participants: ReadonlyMap<SessionId, Session>
  readonly state: ReadonlyMap<Session, () => ExecutionState>
  readonly signal: AbortSignal
  readonly adapters: readonly ExecutionAdapter[]
  /** Existing transport drain; its caller retains reporting ownership on rejection. */
  readonly drain: () => Promise<void>
}

/** Internal owner; executable capabilities are never returned by PreparedParticipants. */
export class TaskExecutionOwner {
  private readonly incarnation = openedSchema.shape.incarnation.parse(randomUUID())
  private readonly controller = Object.freeze({})
  private readonly runs = new WeakMap<object, Run>()
  private readonly issuers = new Map<object, ExecutionAdapter>()
  private readonly reconciliations = new Map<ExecutionAttemptId, Promise<void>>()
  private readonly attempts = new Map<ExecutionAttemptId, Attempt>()
  private readonly abort = new AbortController()
  private readonly unknown = new Set<ExecutionAttemptId>()
  private readonly failures: unknown[] = []
  private phase: ExecutionSnapshot['phase'] = 'closed'
  private generation = 0
  private epoch = 0
  private owner: SessionId | null = null
  private transition: Promise<void> = Promise.resolve()
  private revoking: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private rootWriter: SessionWriterReservation | undefined
  private readonly lifetimeWriters: SessionWriterReservation[] = []
  private readonly lifetimeStops: (() => void)[] = []
  private opened = false
  private ready = false
  private opening: Promise<void> | undefined

  constructor(private readonly options: ExecutionOwnerOptions) {
    for (const adapter of options.adapters) {
      if (this.issuers.has(adapter.issuer)) throw new ExecutionBlockedError('duplicate-issuer')
      this.issuers.set(adapter.issuer, adapter)
    }
    options.signal.addEventListener('abort', () => { void this.dispose().catch(() => {}) }, { once: true })
  }

  /** Persist a fresh closed incarnation after all retained Sessions have recovered. */
  open(): Promise<void> {
    if (this.opening !== undefined) return this.opening
    const completion = Promise.withResolvers<void>()
    this.opening = completion.promise
    void this.initialize().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private async initialize(): Promise<void> {
    for (const session of [this.options.root, ...this.options.participants.values()]) {
      const reserved = this.options.ctx.sessionPersistence.reserveSessionWriter(session)
      if (reserved.kind !== 'reserved') throw new ExecutionBlockedError(reserved.reason)
      this.lifetimeWriters.push(reserved.reservation)
      if (session === this.options.root) this.rootWriter = reserved.reservation
      const stop = (): void => { void this.dispose().catch(() => {}) }
      reserved.reservation.signal.addEventListener('abort', stop, { once: true })
      this.lifetimeStops.push(() => { reserved.reservation.signal.removeEventListener('abort', stop) })
    }
    const rootState = this.options.state.get(this.options.root)?.()
    if (rootState === undefined) throw new ExecutionBlockedError('missing-root-state')
    this.generation = rootState.lastGeneration ?? 0
    for (const session of this.options.participants.values()) {
      if (!this.options.state.has(session)) throw new ExecutionBlockedError('missing-participant-state')
    }
    for (const [session, read] of this.options.state) {
      const state = read()
      for (const entry of state.entries) {
        if (entry.start.rootSessionId !== this.options.root.id || entry.start.participantId !== session.id
          || !this.options.participants.has(session.id)
          || !rootState.history.some(row => row.type === 'opened' && row.data.incarnation === entry.start.incarnation)
          || entry.start.classification === 'mutation' && !rootState.history.some(row => row.type === 'granted'
            && row.data.incarnation === entry.start.incarnation && row.data.generation === entry.start.generation && row.data.participantId === session.id)) throw new ExecutionBlockedError('conflicting-task-history')
        if (entry.reconciliation === null && (entry.settlement === null || entry.settlement.outcome === 'uncertain')) this.unknown.add(entry.start.attemptId)
      }
    }
    await this.recordRoot(() => { this.options.root.append('fusion/execution-opened', {
      version: 1, rootSessionId: this.options.root.id, incarnation: this.incarnation,
      bootId: randomUUID(), previous: rootState.opened?.incarnation ?? null,
    }); this.opened = true })
    if (this.unknown.size > 0) this.phase = 'blocked'
    if (this.issuers.size === 0 && this.unknown.size === 0) {
      for (const stop of this.lifetimeStops.splice(0)) stop()
      for (const writer of [...this.lifetimeWriters].reverse()) {
        const released = await writer.release()
        if (released.kind !== 'durable') { this.block(released); throw new ExecutionBlockedError('initialization-release', released) }
      }
    }
    this.abort.signal.throwIfAborted()
    this.ready = true
  }

  /**
   * Return immutable facts only, with no callable model authority.
   * @returns frozen current facts without execution capabilities.
   */
  snapshot(): ExecutionSnapshot {
    return deepFreeze({ incarnation: this.incarnation, generation: this.generation, owner: this.owner, phase: this.phase,
      attempts: [...this.attempts.values()].map(row => ({ attemptId: row.attemptId, phase: row.phase })),
      unknown: [...this.unknown], blockers: [...this.issuers.size === 0 ? ['integration-missing'] : [], ...this.failures.length > 0 ? ['durability-or-cleanup-unknown'] : []] })
  }

  /**
   * Internal controller identity, retained only by the acquisition owner and fake host harness.
   * @returns exact opaque controller, never a serializable credential.
   */
  controllerCapability(): object { return this.controller }

  /**
   * Authenticate a host issuer and exact retained Agent; missing production integration refuses.
   * @param issuer - registered host object, never serialized.
   * @param agent - exact live registry Agent.
   * @param signal - originating run lifetime.
   * @returns opaque run identity; fields supplied by a caller cannot substitute for it.
   */
  bindRun(issuer: object, agent: Agent, signal: AbortSignal): object {
    const adapter = this.issuers.get(issuer)
    if (adapter === undefined) throw new ExecutionBlockedError('integration-missing')
    this.checkLive(agent)
    signal.throwIfAborted()
    const capability = Object.freeze({})
    this.runs.set(capability, { agent, adapter, signal, generation: this.generation, epoch: this.epoch, runId: randomUUID() })
    return capability
  }

  /**
   * Reserve a generation transition. Production has no adapters and always refuses.
   * @param controller - exact task cleanup controller.
   * @param target - retained participant receiving mutation ownership.
   * @returns join after durable grant and previous cleanup, or a blocking rejection.
   */
  grant(controller: object, target: SessionId): Promise<void> {
    if (controller !== this.controller || this.issuers.size === 0) return Promise.reject(new ExecutionBlockedError('integration-missing'))
    const work = async (): Promise<void> => {
      if (this.abort.signal.aborted || this.options.signal.aborted || this.phase !== 'closed' || this.owner !== null
        || this.attempts.size > 0 || this.reconciliations.size > 0 || this.unknown.size > 0 || !this.options.participants.has(target)) throw new ExecutionBlockedError('not-drained')
      const grant = grantedSchema.parse({ rootSessionId: this.options.root.id, incarnation: this.incarnation,
        generation: ++this.generation, participantId: target,
        previousRevoke: this.options.state.get(this.options.root)?.().revoke?.generation ?? null })
      await this.recordRoot(() => this.options.root.append('fusion/execution-granted', grant))
      if (isAborted(this.abort.signal) || this.snapshot().phase !== 'closed' || isAborted(this.options.signal)) throw new ExecutionBlockedError('revoked-during-grant')
      this.owner = target
      this.phase = 'granted'
    }
    const previousRevoke = this.revoking
    const operation = Promise.all([this.transition, previousRevoke]).then(work)
    this.transition = operation.catch(() => {})
    return operation
  }

  /**
   * Reserve an attempt and its writer synchronously before any adapter work or await.
   * @param capability - exact run object minted by this owner.
   * @param operation - host-classified operation identity.
   * @returns owned settlement join; rejected outcomes retain uncertainty and ownership.
   */
  attempt(capability: object, operation: string): Promise<void> {
    const run = this.runs.get(capability)
    if (run === undefined) return Promise.reject(new ExecutionBlockedError('integration-missing'))
    const abort = new AbortController()
    const done = Promise.withResolvers<void>()
    const attemptId = startedSchema.shape.attemptId.parse(randomUUID())
    const row: Attempt = { attemptId, abort, done: done.promise, phase: 'reserved', dispatched: false }
    this.attempts.set(attemptId, row)
    let writer: SessionWriterReservation | undefined
    try {
      this.checkLive(run.agent)
      const reserved = this.options.ctx.sessionPersistence.reserveSessionWriter(run.agent.session)
      if (reserved.kind !== 'reserved') throw new ExecutionBlockedError(reserved.reason)
      writer = reserved.reservation
      const classification = run.adapter.classify(operation)
      if (classification === undefined) throw new ExecutionBlockedError('unclassified')
      // Classification is host code and may synchronously revoke or dispose this owner.
      this.checkRun(run, classification)
      const start = startedSchema.parse({ rootSessionId: this.options.root.id, participantId: run.agent.session.id,
        incarnation: this.incarnation, runId: run.runId, attemptId,
        generation: classification === 'mutation' ? this.generation : null,
        adapter: run.adapter.name, revision: run.adapter.revision, classification,
        requestHash: createHash('sha256').update(JSON.stringify([operation, run.agent.session.id])).digest('hex') })
      const signal = AbortSignal.any([abort.signal, run.signal, writer.signal, this.abort.signal, this.options.signal])
      void this.perform(row, start, run, operation, writer, signal).then(done.resolve, done.reject)
    } catch (error: unknown) {
      const reserved = writer
      void (async () => {
        if (reserved !== undefined) {
          const released = await reserved.release()
          if (released.kind !== 'durable') { this.block(released); throw new ExecutionBlockedError('setup-release', released) }
        }
        this.attempts.delete(attemptId)
        throw error
      })().then(done.resolve, done.reject)
    }
    return done.promise
  }

  private async perform(
    row: Attempt, start: EffectStarted, run: Run, operation: string, writer: SessionWriterReservation, signal: AbortSignal,
  ): Promise<void> {
    let prepared: Awaited<ReturnType<ExecutionAdapter['prepare']>> | undefined
    let started = false
    let outcome: EffectSettled['outcome'] = 'not-dispatched'
    try {
      row.phase = 'preparing'
      prepared = await run.adapter.prepare(run.agent, operation, signal)
      run.agent.session.append('fusion/effect-started', start)
      started = true
      row.phase = 'start-pending'
      const flushed = await writer.flushDurably()
      if (flushed.kind !== 'durable') throw new ExecutionBlockedError('start-durability', flushed)
      row.phase = 'start-durable'
      if (!signal.aborted) {
        outcome = await prepared.run(() => {
          try {
            const classification = run.adapter.classify(operation)
            this.checkRun(run, classification)
            if (classification !== start.classification) throw new ExecutionBlockedError('classification-changed')
            if (row.dispatched || signal.aborted || writer.checkDispatch() !== undefined) throw new ExecutionBlockedError('dispatch-fenced')
            row.dispatched = true
            row.phase = 'dispatching'
            return undefined
          } catch (error: unknown) { return error instanceof Error ? error : new ExecutionBlockedError('dispatch-fenced', error) }
        })
        if (!row.dispatched) outcome = 'not-dispatched'
      }
    } catch (error: unknown) {
      if (row.dispatched) outcome = 'uncertain'
      this.block(error)
    }
    row.phase = 'settling'
    try { await prepared?.cleanup() } catch (error: unknown) { outcome = 'uncertain'; this.block(error) }
    try {
      if (started) {
        const { rootSessionId, participantId, incarnation, runId, attemptId, generation } = start
        run.agent.session.append('fusion/effect-settled', { rootSessionId, participantId, incarnation, runId, attemptId, generation, outcome })
        const flushed = await writer.flushDurably()
        if (flushed.kind !== 'durable') throw new ExecutionBlockedError('result-durability', flushed)
      }
      if (outcome === 'uncertain') throw new ExecutionBlockedError('outcome-unknown')
      const released = await writer.release()
      if (released.kind !== 'durable') throw new ExecutionBlockedError('release-durability', released)
      this.attempts.delete(row.attemptId)
    } catch (error: unknown) {
      row.phase = 'unknown'
      this.unknown.add(row.attemptId)
      this.block(error)
      throw error
    }
  }

  /**
   * Record independent host evidence without rerunning or settling the original producer.
   * @param controller - exact task cleanup controller.
   * @param issuer - registered host evidence provider.
   * @param attemptId - historical attempt identity, never execution authority.
   * @returns durable reconciliation join; missing evidence stays blocked.
   */
  reconcile(controller: object, issuer: object, attemptId: ExecutionAttemptId): Promise<void> {
    const adapter = this.issuers.get(issuer)
    if (controller !== this.controller || adapter?.reconcile === undefined) return Promise.reject(new ExecutionBlockedError('integration-missing'))
    const observe = adapter.reconcile.bind(adapter)
    const previous = this.reconciliations.get(attemptId)
    if (previous !== undefined) return previous
    if (!this.unknown.has(attemptId) || this.abort.signal.aborted) return Promise.reject(new ExecutionBlockedError('not-recoverable'))
    const completion = Promise.withResolvers<void>()
    this.reconciliations.set(attemptId, completion.promise)
    let source: { session: Session; start: EffectStarted } | undefined
    for (const [session, read] of this.options.state) {
      const entry = read().entries.find(row => row.start.attemptId === attemptId)
      if (entry !== undefined) source = { session, start: entry.start }
    }
    const work = async (): Promise<void> => {
      if (source === undefined || source.start.adapter !== adapter.name || source.start.revision !== adapter.revision) throw new ExecutionBlockedError('evidence-source-mismatch')
      const reserved = this.options.ctx.sessionPersistence.reserveSessionWriter(source.session)
      if (reserved.kind !== 'reserved') throw new ExecutionBlockedError(reserved.reason)
      const disposition = await observe(source.start)
      const { rootSessionId, participantId, incarnation, runId, generation } = source.start
      const record = reconciledSchema.parse({ rootSessionId, participantId, incarnation, runId, attemptId, generation,
        evidenceId: randomUUID(), source: adapter.name, disposition })
      source.session.append('fusion/effect-reconciled', record)
      const flushed = await reserved.reservation.flushDurably()
      if (flushed.kind !== 'durable') throw new ExecutionBlockedError('reconciliation-durability', flushed)
      const released = await reserved.reservation.release()
      if (released.kind !== 'durable') throw new ExecutionBlockedError('reconciliation-release', released)
      this.unknown.delete(attemptId)
      this.reconciliations.delete(attemptId)
      if (this.unknown.size === 0 && this.failures.length === 0 && !this.abort.signal.aborted) this.phase = 'closed'
    }
    void work().then(completion.resolve, (error: unknown) => { this.block(error); completion.reject(error) })
    return completion.promise
  }

  /**
   * Cut admission synchronously, persist revoke, then join effects outside the root journal lane.
   * @param reason - host control reason.
   * @returns memoized drain join; failures remain closed and retain all writers.
   */
  revoke(reason: 'handoff' | 'stop' | 'cancel'): Promise<void> {
    if (this.revoking !== undefined) return this.revoking
    const completion = Promise.withResolvers<void>()
    this.revoking = completion.promise
    this.epoch++
    this.phase = 'revoking'
    this.owner = null
    const admitted = [...this.attempts.values()]
    for (const row of admitted) row.abort.abort(new ExecutionBlockedError('revoked'))
    const persist = this.transition.then(() => this.recordRoot(() => this.options.root.append('fusion/execution-revoked', {
      rootSessionId: this.options.root.id, incarnation: this.incarnation,
      generation: this.options.state.get(this.options.root)?.().grant?.generation ?? null, reason, stopped: reason === 'stop',
    })))
    this.transition = persist.catch((error: unknown) => { this.block(error) })
    void (async () => {
      const results = await Promise.allSettled([persist, ...admitted.map(row => row.done.catch((error: unknown) => {
        if (this.attempts.has(row.attemptId)) throw error
      })), ...this.reconciliations.values()])
      const errors = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length > 0 || this.failures.length > 0 || this.unknown.size > 0) throw new ExecutionBlockedError('drain-unknown', new AggregateError([...errors, ...this.failures]))
      this.phase = reason === 'stop' ? 'stopped' : 'closed'
      if (reason !== 'stop') this.revoking = undefined
    })().then(completion.resolve, (error: unknown) => { this.block(error); completion.reject(error) })
    return completion.promise
  }

  /** Fence synchronously and join all work before the acquisition owner closes retained writers. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    const completion = Promise.withResolvers<void>()
    this.disposal = completion.promise
    this.abort.abort(new ExecutionBlockedError('disposed'))
    this.owner = null
    this.phase = 'revoking'
    void (async () => {
      await Promise.allSettled([this.opening])
      if (this.opened && this.issuers.size > 0) {
        await this.revoke('stop')
        if (this.phase !== 'stopped') await this.revoke('stop')
      }
      if (this.failures.length > 0 || this.unknown.size > 0) throw new ExecutionBlockedError('cleanup-unknown')
      this.phase = 'stopped'
      await Promise.allSettled([this.options.drain()])
      for (const writer of [...this.lifetimeWriters].reverse()) {
        const released = await writer.release()
        if (released.kind === 'refused') throw new ExecutionBlockedError('writer-release', released)
      }
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }

  private checkLive(agent: Agent): void {
    if (!this.ready || this.abort.signal.aborted || this.options.signal.aborted || this.phase === 'revoking' || this.phase === 'blocked'
      || this.phase === 'stopped' || this.options.ctx.agents.get(agent.id) !== agent
      || this.options.participants.get(agent.session.id) !== agent.session
      || this.options.ctx.sessions.get(agent.session.id) !== agent.session) throw new ExecutionBlockedError('not-live')
  }
  private checkRun(run: Run, classification: ReturnType<ExecutionAdapter['classify']>): void {
    this.checkLive(run.agent)
    run.signal.throwIfAborted()
    if (run.epoch !== this.epoch) throw new ExecutionBlockedError('stale-run')
    if (classification === undefined || classification === 'mutation' && (this.owner !== run.agent.session.id || run.generation !== this.generation)) throw new ExecutionBlockedError('not-owner')
  }
  private block(error: unknown): void { this.failures.push(error); this.phase = 'blocked'; this.owner = null }
  private async recordRoot(append: () => void): Promise<void> {
    const writer = this.rootWriter
    if (writer === undefined) throw new ExecutionBlockedError('missing-root-writer')
    try {
      append()
      const flushed = await writer.flushDurably()
      if (flushed.kind !== 'durable') throw new ExecutionBlockedError('root-durability', flushed)
    } catch (error: unknown) { this.block(error); throw error }
  }
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted }
