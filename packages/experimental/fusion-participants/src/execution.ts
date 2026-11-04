/** Dormant task authority. No production issuer or effect adapter is installed. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionWriterReservation } from '@deepseek-ai/dsh-session-persistence'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ExecutionHostProvider, TaskExecutionHost, ExecutionIssuer, ExecutionController, ExecutionRun, HeldAttempt, HeldProducer, ExecutionSettlement } from './execution-host.ts'
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
interface HeldRequest extends Attempt {
  readonly token: HeldAttempt
  readonly run: Run
  readonly operation: string
  readonly writer: SessionWriterReservation
  readonly signal: AbortSignal
  readonly completion: PromiseWithResolvers<void>
  producer?: HeldProducer
  registration?: Promise<void>
  registered: boolean
  release?: Promise<ExecutionSettlement>
  finishing?: Promise<ExecutionSettlement>
  cancellation?: 'handoff' | 'stop' | 'cancel'
  failure?: { readonly reason: 'cleanup-unknown' | 'outcome-unknown' | 'durability'; readonly cause: unknown }
  cancelSent?: boolean
  stop?: () => void
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
  /** Synchronously stop transport admission and return its actual cleanup join. */
  readonly drain: () => Promise<void>
}

/** Internal owner; executable capabilities are never returned by PreparedParticipants. */
export class TaskExecutionOwner {
  private readonly incarnation = openedSchema.shape.incarnation.parse(randomUUID())
  private readonly controller = Object.freeze({})
  private enrollment: { provider: ExecutionHostProvider; current: () => void; done: Promise<TaskExecutionHost> } | undefined
  private readonly held = new WeakMap<HeldAttempt, HeldRequest>()
  private readonly runs = new WeakMap<object, Run>()
  private readonly issuers = new Map<object, ExecutionAdapter>()
  private readonly reconciliations = new Map<ExecutionAttemptId, { done: Promise<void>; writer?: SessionWriterReservation }>()
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
  private readonly withdrawalStops: (() => void)[] = []
  private opened = false
  private ready = false
  private opening: Promise<void> | undefined
  private readonly stop = (): void => { void this.dispose().catch(() => {}) }

  constructor(private readonly options: ExecutionOwnerOptions) {
    for (const adapter of options.adapters) {
      if (this.issuers.has(adapter.issuer)) throw new ExecutionBlockedError('duplicate-issuer')
      this.issuers.set(adapter.issuer, adapter)
    }
    try {
      for (const session of [options.root, ...options.participants.values()]) {
        this.withdrawalStops.push(options.ctx.sessions.registerWithdrawal(session, () => this.dispose()))
      }
    } catch (error: unknown) {
      for (const stop of this.withdrawalStops.splice(0)) stop()
      throw error
    }
    options.signal.addEventListener('abort', this.stop, { once: true })
  }

  /** Persist a fresh closed incarnation after all retained Sessions have recovered. */
  open(): Promise<void> {
    if (this.opening !== undefined) return this.opening
    const completion = Promise.withResolvers<void>()
    this.opening = completion.promise
    void this.initialize().then(completion.resolve, async (error: unknown) => {
      try {
        if (!this.opened && this.failures.length === 0 && this.unknown.size === 0) await this.releaseLifetime()
      } catch (cleanup: unknown) {
        this.block(cleanup)
        completion.reject(new ExecutionBlockedError('initialization-cleanup', new AggregateError([error, cleanup])))
        return
      }
      completion.reject(error)
    })
    return completion.promise
  }

  private async initialize(): Promise<void> {
    this.abort.signal.throwIfAborted()
    this.options.signal.throwIfAborted()
    this.pinLifetime()
    const rootState = this.options.state.get(this.options.root)?.()
    if (rootState === undefined) throw new ExecutionBlockedError('missing-root-state')
    this.generation = rootState.lastGeneration ?? 0
    for (const session of this.options.participants.values()) {
      if (!this.options.state.has(session)) throw new ExecutionBlockedError('missing-participant-state')
    }
    const attemptIds = new Set<ExecutionAttemptId>()
    const runs = new Map<string, EffectStarted>()
    for (const [session, read] of this.options.state) {
      const state = read()
      if (state.sessionId !== session.id || session !== this.options.root && this.options.participants.get(session.id) !== session
        || session !== this.options.root && state.history.length > 0) {
        const error = new ExecutionBlockedError('conflicting-task-history')
        this.block(error)
        throw error
      }
      for (const entry of state.entries) {
        const priorRun = runs.get(entry.start.runId)
        if (entry.start.rootSessionId !== this.options.root.id || entry.start.participantId !== session.id
          || this.options.participants.get(session.id) !== session || attemptIds.has(entry.start.attemptId)
          || priorRun !== undefined && (priorRun.participantId !== session.id || priorRun.incarnation !== entry.start.incarnation
            || priorRun.adapter !== entry.start.adapter || priorRun.revision !== entry.start.revision
            || priorRun.generation !== null && entry.start.generation !== null && priorRun.generation !== entry.start.generation)
          || !rootState.history.some(row => row.type === 'opened' && row.data.incarnation === entry.start.incarnation)
          || entry.start.classification === 'mutation' && !rootState.history.some(row => row.type === 'granted'
            && row.data.incarnation === entry.start.incarnation && row.data.generation === entry.start.generation
            && row.data.participantId === session.id)) {
          const error = new ExecutionBlockedError('conflicting-task-history')
          this.block(error)
          throw error
        }
        attemptIds.add(entry.start.attemptId)
        if (priorRun === undefined || entry.start.generation !== null) runs.set(entry.start.runId, entry.start)
        if (entry.reconciliation === null && (entry.settlement === null || entry.settlement.outcome === 'uncertain')) this.unknown.add(entry.start.attemptId)
      }
    }
    if (rootState.history.some(row => row.type === 'granted' && !this.options.participants.has(row.data.participantId))) {
      const error = new ExecutionBlockedError('conflicting-task-history')
      this.block(error)
      throw error
    }
    await this.recordRoot(() => { this.options.root.append('fusion/execution-opened', {
      version: 1, rootSessionId: this.options.root.id, incarnation: this.incarnation,
      openingId: randomUUID(), previous: rootState.opened?.incarnation ?? null,
    }); this.opened = true })
    if (this.unknown.size > 0) this.phase = 'blocked'
    this.abort.signal.throwIfAborted()
    this.ready = true
    // Opening a dormant task must not hold writer reservations before a host
    // provider enrolls. Enrollment re-pins the exact same writers atomically.
    if (this.issuers.size === 0) await this.releaseLifetime()
  }

  /**
   * Enroll one exact host provider and re-pin released empty-open reservations before minting credentials.
   * @param provider - trusted inert held producer provider, fixed for this incarnation.
   * @param current - declaring fiber lifetime check, including withdrawal before effect cleanup runs.
   * @returns memoized exact-provider enrollment; failed enrollment cannot be replaced.
   */
  enroll(provider: ExecutionHostProvider, current: () => void): Promise<TaskExecutionHost> {
    if (this.disposal !== undefined || this.abort.signal.aborted || this.options.signal.aborted) return Promise.reject(new ExecutionBlockedError('not-live'))
    if (this.enrollment !== undefined) return this.enrollment.provider === provider
      ? this.enrollment.done : Promise.reject(new ExecutionBlockedError('host-replacement'))
    const completion = Promise.withResolvers<TaskExecutionHost>()
    this.enrollment = { provider, current, done: completion.promise }
    void (async () => {
      if (!this.ready || this.abort.signal.aborted || this.options.signal.aborted || this.disposal !== undefined
        || this.phase === 'revoking' || this.phase === 'stopped') throw new ExecutionBlockedError('not-live')
      current()
      startedSchema.shape.adapter.parse(provider.name)
      startedSchema.shape.revision.parse(provider.revision)
      const acquiring = this.lifetimeWriters.length === 0
      try {
        if (acquiring) this.pinLifetime()
        this.checkWriters()
        this.abort.signal.throwIfAborted()
        this.options.signal.throwIfAborted()
      } catch (error: unknown) {
        try { if (acquiring) await this.releaseLifetime() } catch (cleanup: unknown) {
          this.block(cleanup)
          throw new ExecutionBlockedError('enrollment-cleanup', new AggregateError([error, cleanup]))
        }
        throw error
      }
      current()
      const issuer = Object.freeze({}) as ExecutionIssuer
      // Legacy adapters remain internal. The public path never calls their callback-fence protocol.
      const adapter: ExecutionAdapter = { issuer, name: provider.name, revision: provider.revision,
        classify: operation => provider.classify(operation),
        prepare: () => Promise.reject(new ExecutionBlockedError('held-only')) }
      this.issuers.set(issuer, adapter)
      const controller = this.controller as ExecutionController
      const host: TaskExecutionHost = Object.freeze({
        issuer, controller,
        bindRun: (key: ExecutionIssuer, agent: Agent, signal: AbortSignal) => this.bindRun(key, agent, signal) as ExecutionRun,
        reserve: (run: ExecutionRun, operation: string) => this.reserveHeld(run, operation),
        register: (attempt: HeldAttempt) => this.registerHeld(attempt, provider),
        release: (attempt: HeldAttempt) => this.releaseHeld(attempt),
        grant: (key: ExecutionController, target: SessionId) => this.grant(key, target),
        revoke: (key: ExecutionController, reason: 'handoff' | 'stop' | 'cancel') => key === controller
          ? this.revoke(reason) : Promise.reject(new ExecutionBlockedError('identity')),
        dispose: () => this.dispose(),
      })
      completion.resolve(host)
    })().catch(completion.reject)
    return completion.promise
  }

  private pinLifetime(): void {
    for (const session of [this.options.root, ...this.options.participants.values()]) {
      const reserved = this.options.ctx.sessionPersistence.reserveSessionWriter(session)
      if (reserved.kind !== 'reserved') throw new ExecutionBlockedError(reserved.reason, reserved)
      this.lifetimeWriters.push(reserved.reservation)
      if (session === this.options.root) this.rootWriter = reserved.reservation
      reserved.reservation.signal.addEventListener('abort', this.stop, { once: true })
      this.lifetimeStops.push(() => { reserved.reservation.signal.removeEventListener('abort', this.stop) })
      this.abort.signal.throwIfAborted()
      this.options.signal.throwIfAborted()
    }
  }

  private checkWriters(): void {
    if (this.lifetimeWriters.length !== this.options.participants.size + 1) throw new ExecutionBlockedError('writer')
    for (const writer of this.lifetimeWriters) {
      const refusal = writer.checkDispatch()
      if (refusal !== undefined) throw new ExecutionBlockedError('writer', refusal)
    }
  }

  private checkHeldRun(run: Run): void {
    this.checkLive(run.agent)
    run.signal.throwIfAborted()
    if (this.issuers.get(run.adapter.issuer) !== run.adapter || run.generation !== this.generation || run.epoch !== this.epoch) {
      throw new ExecutionBlockedError('stale-run')
    }
    this.checkWriters()
  }

  private reserveHeld(capability: ExecutionRun, operation: string): HeldAttempt {
    const run = this.runs.get(capability)
    if (run === undefined) throw new ExecutionBlockedError('identity')
    this.checkHeldRun(run)
    const reserved = this.options.ctx.sessionPersistence.reserveSessionWriter(run.agent.session)
    if (reserved.kind !== 'reserved') throw new ExecutionBlockedError('writer', reserved)
    const completion = Promise.withResolvers<void>()
    // The drain owns this rejection even when a held request has no release caller.
    void completion.promise.catch(() => {})
    const abort = new AbortController()
    const token = Object.freeze({}) as HeldAttempt
    const signal = AbortSignal.any([abort.signal, run.signal, reserved.reservation.signal, this.abort.signal, this.options.signal])
    const row: HeldRequest = { token, run, operation, writer: reserved.reservation, signal, completion,
      attemptId: startedSchema.shape.attemptId.parse(randomUUID()), abort, done: completion.promise,
      phase: 'reserved', dispatched: false, registered: false }
    this.attempts.set(row.attemptId, row)
    this.held.set(token, row)
    const onAbort = (): void => {
      this.cancelHeld(row, row.cancellation ?? 'cancel')
      if (row.release === undefined) void this.finishHeld(row).catch(() => {})
    }
    signal.addEventListener('abort', onAbort, { once: true })
    row.stop = () => { signal.removeEventListener('abort', onAbort) }
    if (signal.aborted) { this.cancelHeld(row, 'cancel'); void this.finishHeld(row).catch(() => {}) }
    return token
  }

  private registerHeld(token: HeldAttempt, provider: ExecutionHostProvider): Promise<void> {
    const row = this.held.get(token)
    if (row === undefined) return Promise.reject(new ExecutionBlockedError('identity'))
    if (row.registration !== undefined) return row.registration
    const completion = Promise.withResolvers<void>()
    row.registration = completion.promise
    try {
      this.checkHeldRun(row.run)
      row.signal.throwIfAborted()
      const classification = row.run.adapter.classify(row.operation)
      this.checkHeldRun(row.run)
      this.checkRun(row.run, classification)
      row.phase = 'registering'
      row.producer = provider.registerHeld(token, row.attemptId, row.run.agent, row.operation, row.signal)
      if (row.signal.aborted) this.cancelHeld(row, row.cancellation ?? 'cancel')
      this.checkHeldRun(row.run)
      row.signal.throwIfAborted()
      row.registered = true
      row.phase = 'held'
      completion.resolve()
    } catch (error: unknown) {
      // A throwing allocator cannot certify that no partial allocation escaped without an anchor.
      if (row.phase === 'registering' && row.producer === undefined) { row.failure = { reason: 'cleanup-unknown', cause: error }; this.block(error) }
      completion.reject(error)
      void this.finishHeld(row).catch(() => {})
    }
    return completion.promise
  }

  private releaseHeld(token: HeldAttempt): Promise<ExecutionSettlement> {
    const row = this.held.get(token)
    if (row === undefined) return Promise.reject(new ExecutionBlockedError('identity'))
    if (row.release !== undefined) return row.release
    if (row.finishing !== undefined) return row.finishing
    if (!row.registered) return Promise.reject(new ExecutionBlockedError('not-registered'))
    const completion = Promise.withResolvers<ExecutionSettlement>()
    row.release = completion.promise
    // Publish the join before prepare, classification or invocation can reenter the facade.
    void this.performHeld(row).then(completion.resolve, completion.reject)
    return completion.promise
  }

  private cancelHeld(row: HeldRequest, reason: 'handoff' | 'stop' | 'cancel'): void {
    row.cancellation ??= reason
    if (row.cancelSent === true || row.producer === undefined) return
    row.cancelSent = true
    try { row.producer.cancel(row.cancellation) } catch (error: unknown) { row.failure = { reason: 'cleanup-unknown', cause: error }; this.block(error) }
  }

  private async performHeld(row: HeldRequest): Promise<ExecutionSettlement> {
    let start: EffectStarted | undefined
    let outcome: EffectSettled['outcome'] = 'not-dispatched'
    try {
      this.checkHeldRun(row.run)
      row.signal.throwIfAborted()
      const classification = row.run.adapter.classify(row.operation)
      this.checkHeldRun(row.run)
      this.checkRun(row.run, classification)
      if (classification === undefined || row.producer === undefined) throw new ExecutionBlockedError('not-registered')
      start = startedSchema.parse({ rootSessionId: this.options.root.id, participantId: row.run.agent.session.id,
        incarnation: this.incarnation, runId: row.run.runId, attemptId: row.attemptId,
        generation: classification === 'mutation' ? this.generation : null,
        adapter: row.run.adapter.name, revision: row.run.adapter.revision, classification,
        requestHash: createHash('sha256').update(JSON.stringify([row.operation, row.run.agent.session.id])).digest('hex') })
      row.phase = 'preparing'
      const invocation = await row.producer.prepare()
      // Resolve any provider-owned accessor before the final authority check.
      const invoke = invocation.invoke.bind(invocation)
      this.checkHeldRun(row.run)
      row.signal.throwIfAborted()
      row.run.agent.session.append('fusion/effect-started', start)
      row.phase = 'start-pending'
      const flushed = await row.writer.flushDurably()
      if (flushed.kind !== 'durable') throw new ExecutionBlockedError('start-durability', flushed)
      row.phase = 'start-durable'
      const current = row.run.adapter.classify(row.operation)
      // Classification is external code; all authority checks follow its return.
      this.checkHeldRun(row.run)
      this.checkRun(row.run, current)
      if (current !== classification || row.signal.aborted || row.dispatched || row.writer.checkDispatch() !== undefined) {
        throw new ExecutionBlockedError('dispatch-fenced')
      }
      row.dispatched = true
      row.phase = 'dispatching'
      outcome = await invoke()
    } catch (error: unknown) {
      if (row.dispatched) { outcome = 'uncertain'; row.failure = { reason: 'outcome-unknown', cause: error }; this.block(error) }
      else if (row.phase === 'start-pending') { row.failure = { reason: 'durability', cause: error }; this.block(error) }
    }
    return this.finishHeld(row, row.phase === 'preparing' ? undefined : start, outcome)
  }

  private finishHeld(row: HeldRequest, start?: EffectStarted, outcome: EffectSettled['outcome'] = 'not-dispatched'): Promise<ExecutionSettlement> {
    if (row.finishing !== undefined) return row.finishing
    const completion = Promise.withResolvers<ExecutionSettlement>()
    row.finishing = completion.promise
    // A held registration callback may revoke before returning its independent cleanup anchor.
    void (async (): Promise<ExecutionSettlement> => {
      await Promise.allSettled([row.registration])
      row.phase = 'settling'
      try { await row.producer?.cleanup() } catch (error: unknown) {
        row.failure = { reason: 'cleanup-unknown', cause: error }
        outcome = 'uncertain'
        this.block(error)
      }
      try {
        if (start !== undefined) {
          const { rootSessionId, participantId, incarnation, runId, attemptId, generation } = start
          row.run.agent.session.append('fusion/effect-settled', { rootSessionId, participantId, incarnation, runId, attemptId, generation, outcome })
          const flushed = await row.writer.flushDurably()
          if (flushed.kind !== 'durable') throw new ExecutionBlockedError('result-durability', flushed)
        }
        if (row.failure !== undefined) throw new ExecutionBlockedError(row.failure.reason, row.failure.cause)
        if (outcome === 'uncertain') throw new ExecutionBlockedError('outcome-unknown')
        const released = await row.writer.release()
        if (released.kind !== 'durable') throw new ExecutionBlockedError('release-durability', released)
        this.attempts.delete(row.attemptId)
        row.phase = 'settled'
        row.stop?.()
        row.completion.resolve()
        return { kind: 'settled', outcome }
      } catch (error: unknown) {
        row.phase = 'unknown'
        this.unknown.add(row.attemptId)
        this.block(error)
        row.completion.reject(error)
        return { kind: 'blocked', reason: row.failure?.reason ?? (outcome === 'uncertain' ? 'outcome-unknown' : 'durability'),
          attemptId: row.attemptId, cause: error }
      }
    })().then(completion.resolve, completion.reject)
    return completion.promise
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
      if (!this.ready || this.abort.signal.aborted || this.options.signal.aborted || this.phase !== 'closed' || this.owner !== null
        || this.attempts.size > 0 || this.reconciliations.size > 0 || this.unknown.size > 0 || !this.options.participants.has(target)) throw new ExecutionBlockedError('not-drained')
      if (this.enrollment !== undefined) { this.enrollment.current(); this.checkWriters() }
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
          try {
            const released = await reserved.release()
            if (released.kind !== 'durable') throw new ExecutionBlockedError('setup-release', released)
          } catch (cleanup: unknown) {
            row.phase = 'unknown'
            this.unknown.add(attemptId)
            this.block(cleanup)
            throw new ExecutionBlockedError('setup-cleanup', new AggregateError([error, cleanup]))
          }
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
        if (!row.dispatched) {
          outcome = this.options.ctx.sessions.isWithdrawing(run.agent.session) ? 'uncertain' : 'not-dispatched'
        }
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
    if (previous !== undefined) return previous.done
    if (!this.ready || !this.unknown.has(attemptId) || this.abort.signal.aborted) return Promise.reject(new ExecutionBlockedError('not-recoverable'))
    const completion = Promise.withResolvers<void>()
    const reconciliation: { done: Promise<void>; writer?: SessionWriterReservation } = { done: completion.promise }
    this.reconciliations.set(attemptId, reconciliation)
    let source: { session: Session; start: EffectStarted } | undefined
    for (const [session, read] of this.options.state) {
      const entry = read().entries.find(row => row.start.attemptId === attemptId)
      if (entry !== undefined) source = { session, start: entry.start }
    }
    const work = async (): Promise<void> => {
      if (source === undefined || source.start.adapter !== adapter.name || source.start.revision !== adapter.revision) throw new ExecutionBlockedError('evidence-source-mismatch')
      const reserved = this.options.ctx.sessionPersistence.reserveSessionWriter(source.session)
      if (reserved.kind !== 'reserved') throw new ExecutionBlockedError(reserved.reason)
      reconciliation.writer = reserved.reservation
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
    for (const row of admitted) {
      const held = 'token' in row ? this.held.get(row.token as HeldAttempt) : undefined
      if (held !== undefined) this.cancelHeld(held, reason)
      row.abort.abort(new ExecutionBlockedError('revoked'))
    }
    const persist = this.transition.then(() => this.recordRoot(() => this.options.root.append('fusion/execution-revoked', {
      rootSessionId: this.options.root.id, incarnation: this.incarnation,
      generation: this.options.state.get(this.options.root)?.().grant?.generation ?? null, reason, stopped: reason === 'stop',
    })))
    this.transition = persist.catch((error: unknown) => { this.block(error) })
    void (async () => {
      const results = await Promise.allSettled([persist, ...admitted.map(row => row.done.catch((error: unknown) => {
        if (this.attempts.has(row.attemptId)) throw error
      })), ...[...this.reconciliations.values()].map(row => row.done)])
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
    this.options.signal.removeEventListener('abort', this.stop)
    this.abort.abort(new ExecutionBlockedError('disposed'))
    this.owner = null
    this.phase = 'revoking'
    const execution = (async () => {
      await Promise.allSettled([this.opening, this.enrollment?.done])
      // A registration callback can dispose the owner before enrollment finishes.
      // Once an attempt exists, revoke it even when the host has not published
      // its opened state yet; otherwise the producer never receives cleanup.
      if (this.attempts.size > 0 || this.opened && this.issuers.size > 0) {
        await this.revoke('stop')
        if (this.phase !== 'stopped') await this.revoke('stop')
      }
      if (this.failures.length > 0 || this.unknown.size > 0) throw new ExecutionBlockedError('cleanup-unknown')
      await this.options.drain()
    })()
    void Promise.allSettled([execution]).then(async (results) => {
      const errors = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) throw new AggregateError(errors, 'execution and delivery cleanup failed')
      this.phase = 'stopped'
      await this.releaseLifetime()
      for (const stop of this.withdrawalStops.splice(0)) stop()
    }).then(completion.resolve, (error: unknown) => { this.block(error); completion.reject(error) })
    return completion.promise
  }

  private async releaseLifetime(): Promise<void> {
    for (const stop of this.lifetimeStops.splice(0)) stop()
    for (const writer of [...this.lifetimeWriters].reverse()) {
      const released = await writer.release()
      if (released.kind !== 'durable') { this.block(released); throw new ExecutionBlockedError('writer-release', released) }
      this.lifetimeWriters.pop()
    }
    this.rootWriter = undefined
  }

  private checkLive(agent: Agent): void {
    this.enrollment?.current()
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
