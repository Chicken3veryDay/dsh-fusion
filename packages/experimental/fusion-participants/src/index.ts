/** Host-only retained participant preparation. Publication confers no execution or mutation authority. */
import { createHash } from 'node:crypto'
import { createScope, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { Context, Service, FiberState } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AgentHandle, RetainedAgentSession } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-fusion-config'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { captureRoster } from './roster.ts'
import type { Roster } from './roster.ts'
import { DeliveryOwner } from './delivery.ts'
import type { DormantDelivery } from './delivery.ts'
import { admissionProjection, receiverProjection } from './delivery-state.ts'
import type { AdmissionState, ReceiverState } from './delivery-state.ts'
import type { ExecutionHostProvider, TaskExecutionHost } from './execution-host.ts'
import { TaskExecutionOwner, ExecutionBlockedError } from './execution.ts'
import type { ExecutionSnapshot } from './execution.ts'
import { executionProjection } from './execution-state.ts'
import type { ExecutionState } from './execution-state.ts'
import { rosterProjection } from './state.ts'
import type { RosterState } from './state.ts'

export { DeliveryId } from './delivery-state.ts'
export type { TextDelivery } from './delivery-state.ts'
export { DeliveryBlockedError } from './delivery.ts'
export type { DormantDelivery, DeliveryReceipt, AdmissionSnapshot } from './delivery.ts'
export type { ExecutionHostProvider, TaskExecutionHost, ExecutionIssuer, ExecutionController, ExecutionRun, HeldAttempt, HeldProducer, SynchronousInvocation, EffectClass, ExecutionBlockReason, ExecutionSettlement } from './execution-host.ts'
export { ExecutionBlockedError } from './execution.ts'
export type { ExecutionSnapshot } from './execution.ts'
export type { Roster } from './roster.ts'

/** Capability returned only after all required leases, routes and barriers succeed. */
export interface PreparedParticipants {
  /** Immutable root roster; IDs and routes survive Agent detachment and process restart. */
  readonly roster: Roster
  /** Host-only durable text transport; no execution authority. */
  readonly delivery: DormantDelivery
  /** Immutable dormant authority facts; no run, controller or executable callbacks. */
  readonly execution: ExecutionSnapshot
  /** Publish one parked participant by its roster role; no input is claimed. */
  adopt(role: string): Promise<AgentHandle>
  /**
   * Cancel preparation/adoption and drain all owned cleanup; the host handles rejection with retained causes after routing
   * and writers close.
   */
  dispose(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context { fusionParticipants: FusionParticipants }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable root roster captured before participant provisioning. Required and log-only. */
    'fusion/roster': Roster
    /** Root-owned provisioning evidence; missing established participants block recovery. Required and log-only. */
    'fusion/participant-established': { participantId: SessionId }
  }
}

/** Preparation stopped without authorizing any work; the root identity remains recoverable. */
export class ParticipantPreparationError extends Error {
  /** Stable host handling identity; never authorizes retry or work. */
  readonly code = 'fusion-participants/preparation-blocked'
  constructor(
    readonly rootSessionId: SessionId,
    readonly cleanup: 'complete' | 'unknown',
    cause: unknown,
  ) {
    super(`Participant preparation blocked for ${rootSessionId}; cleanup ${cleanup}`, { cause })
  }
}

/** Loader-mounted task owner; exposes no model tools or product activation operation. */
export default class FusionParticipants extends Service {
  static inject = ['agentLoop', 'agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'fusionConfig', 'agentPresets']
  private readonly abort = new AbortController()
  private readonly pending = new Map<Promise<PreparedParticipants>, Promise<void>>()
  private readonly owned = new Map<PreparedParticipants, () => Promise<void>>()
  private readonly executionOwners = new WeakMap<PreparedParticipants, TaskExecutionOwner>()
  private readonly hosts = new WeakMap<PreparedParticipants, { provider: ExecutionHostProvider; caller: Context['fiber']; done: Promise<TaskExecutionHost> }>()
  private readonly release = Promise.withResolvers<void>()
  private readonly lifetime: { ctx: Context; resources: Scope }
  private stopping: Promise<void> | undefined
  private readonly cleanupErrors: unknown[] = []
  private admissions!: ProjectionHandle<AdmissionState>
  private receivers!: ProjectionHandle<ReceiverState>
  private projection!: ProjectionHandle<RosterState>
  private executions!: ProjectionHandle<ExecutionState>

  constructor(ctx: Context) {
    super(ctx, 'fusionParticipants')
    const resources = createScope(ctx, {}, { observeCleanup: true })
    this.lifetime = { ctx: resources.ctx, resources }
    ctx.effect(function* (this: FusionParticipants) {
      yield resources.rawDispose
      yield () => this.stop()
    }.bind(this), 'fusion-participants.lifetime')
  }

  private stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    const completion = Promise.withResolvers<void>()
    this.stopping = completion.promise
    // Publish the join before cancellation callbacks can reenter this owner.
    this.abort.abort(new Error('participant owner disposed'))
    void (async () => {
      const drains = await Promise.allSettled([...this.pending.values(), ...[...this.owned.values()].map(drain => drain())])
      // Preparations have stopped provisioning; their rollback may now release resources.
      this.release.resolve()
      await Promise.allSettled([...this.pending.keys()])
      const results = await Promise.allSettled([...this.owned.keys()].map(task => task.dispose()))
      const errors = [...this.cleanupErrors, ...[...drains, ...results].flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])]
      try { await this.lifetime.resources.dispose() } catch (error: unknown) { errors.push(error) }
      if (errors.length > 0) throw new AggregateError(errors, 'participant owner cleanup failed')
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.lifetime.ctx.sessionProjections.register<'fusionRoster', RosterState>(rosterProjection)
    this.admissions = await this.lifetime.ctx.sessionProjections.register(admissionProjection)
    this.receivers = await this.lifetime.ctx.sessionProjections.register(receiverProjection)
    this.executions = await this.lifetime.ctx.sessionProjections.register(executionProjection)
  }

  /**
   * Capture one exact selection and prepare inert durable participant contexts.
   * @param selectionId - named immutable fusion-config selection.
   * @param signal - optional cancellation; owner disposal always cancels preparation.
   * @returns prepared capability only after every writer passes its own durability barrier.
   */
  prepare(selectionId: string, signal?: AbortSignal): Promise<PreparedParticipants> {
    return this.track(async (ownedSignal, quiescent, releaseCaller) => {
      const selection = this.lifetime.ctx.fusionConfig.selection(selectionId)
      const document = await this.lifetime.ctx.agentPresets.readDocument(selection.agentPreset)
      ownedSignal.throwIfAborted()
      const compositionDigest = createHash('sha256').update(document.content).digest('hex')
      return this.acquire({ kind: 'create', roster: captureRoster(selection, compositionDigest) }, ownedSignal, quiescent, releaseCaller)
    }, signal)
  }

  /**
   * Recover the root and persisted participants under root-first leases.
   * @param rootSessionId - persisted root identity; absence/corruption is a blocking failure.
   * @param signal - optional cancellation; omission keeps owner disposal cancellation.
   * @returns a prepared capability using the original roster and context lineages.
   */
  recover(rootSessionId: SessionId, signal?: AbortSignal): Promise<PreparedParticipants> {
    return this.track((ownedSignal, quiescent, releaseCaller) => this.acquire({ kind: 'resume', rootSessionId }, ownedSignal, quiescent, releaseCaller), signal)
  }

  /**
   * Enroll one trusted held host on this exact prepared task. The declaring fiber owns withdrawal;
   * its teardown fences admission immediately and joins cleanup before releasing dependencies.
   * No provider, capability or callback is transported through model tools or SDK requests.
   * @param task - exact live object returned by this service, never a roster or snapshot copy.
   * @param provider - one exact provider identity per task incarnation and declaring fiber.
   * @returns memoized enrollment after exact retained writer reservations; replacement refuses.
   */
  registerExecutionHost(task: PreparedParticipants, provider: ExecutionHostProvider): Promise<TaskExecutionHost> {
    const caller = this.ctx
    try {
      caller.fiber.assertActive()
      this.abort.signal.throwIfAborted()
      const owner = this.executionOwners.get(task)
      if (owner === undefined || !this.owned.has(task)) throw new ExecutionBlockedError('identity')
      const previous = this.hosts.get(task)
      if (previous !== undefined) {
        if (previous.provider !== provider || previous.caller !== caller.fiber) throw new ExecutionBlockedError('host-replacement')
        const phase = owner.snapshot().phase
        if (phase === 'stopped' || phase === 'revoking') throw new ExecutionBlockedError('not-live')
        return previous.done
      }
      const completion = Promise.withResolvers<TaskExecutionHost>()
      this.hosts.set(task, { provider, caller: caller.fiber, done: completion.promise })
      caller.effect(() => () => owner.dispose(), 'fusion-participants.execution-host')
      void owner.enroll(provider, () => {
        caller.fiber.assertActive()
        if (caller.fiber.state === FiberState.UNLOADING || caller.fiber.state === FiberState.DISPOSED) throw new ExecutionBlockedError('not-live')
      }).then(completion.resolve, completion.reject)
      return completion.promise
    } catch (error: unknown) { return Promise.reject(error instanceof Error ? error : new ExecutionBlockedError('not-live', error)) }
  }

  private track(
    work: (signal: AbortSignal, quiescent: () => void, releaseCaller: () => Promise<void>) => Promise<PreparedParticipants>,
    caller?: AbortSignal,
  ): Promise<PreparedParticipants> {
    const operation = Promise.withResolvers<PreparedParticipants>()
    const abort = new AbortController()
    const signal = AbortSignal.any([this.abort.signal, abort.signal, ...caller === undefined ? [] : [caller]])
    let settled = false
    let removeCaller: () => void | Promise<void>
    const releaseCaller = async (): Promise<void> => {
      // Removing an effect runs its cleanup; a settled task must not join itself.
      settled = true
      await removeCaller()
    }
    try {
      signal.throwIfAborted()
      this.ctx.fiber.assertActive()
      // Caller scopes cancel and join; only the captured resource scope owns leases.
      removeCaller = this.ctx.effect(() => async () => {
        if (settled) return
        abort.abort(new Error('participant caller disposed'))
        let task: PreparedParticipants
        try { task = await operation.promise } catch (_preparation: unknown) { return /* Rollback belongs to the pending operation. */ }
        await task.dispose()
      }, 'fusion-participants.caller')
    } catch (error: unknown) { operation.reject(error); return operation.promise }
    const quiescent = Promise.withResolvers<void>()
    this.pending.set(operation.promise, quiescent.promise)
    void operation.promise.then(() => this.pending.delete(operation.promise), () => this.pending.delete(operation.promise))
    // Reserve before invoking provider code, including synchronous reentrant callbacks.
    void Promise.resolve().then(() => {
      signal.throwIfAborted()
      return work(signal, quiescent.resolve, releaseCaller)
    }).then(operation.resolve, async (error: unknown) => {
      await releaseCaller()
      operation.reject(error)
    }).finally(quiescent.resolve)
    return operation.promise
  }

  private async barrier(session: Session): Promise<void> {
    const result = await this.lifetime.ctx.sessionPersistence.flushSessionDurably(session)
    if (result.kind !== 'durable') {
      throw new Error(`participant durability refused: ${result.reason}`,
        result.reason === 'flush-failed' ? { cause: result.cause } : undefined)
    }
  }

  private async acquire(
    request: { kind: 'create'; roster: Roster } | { kind: 'resume'; rootSessionId: SessionId },
    caller: AbortSignal,
    quiescent: () => void,
    releaseCaller: () => Promise<void>,
  ): Promise<PreparedParticipants> {
    const rootSessionId = request.kind === 'create' ? request.roster.rootSessionId : request.rootSessionId
    const taskAbort = new AbortController()
    const signal = AbortSignal.any([this.abort.signal, taskAbort.signal, caller])
    const leases: RetainedAgentSession[] = []
    const participants = new Map<SessionId, RetainedAgentSession>()
    let composition: Scope | undefined
    let disposal: Promise<void> | undefined
    let prepared: PreparedParticipants | undefined
    let delivery: DeliveryOwner | undefined
    let execution: TaskExecutionOwner | undefined
    const acquired = Promise.withResolvers<void>()
    const withdrawals: (() => void)[] = []
    let draining: Promise<void> | undefined
    const drain = (): Promise<void> => {
      if (draining !== undefined) return draining
      const completion = Promise.withResolvers<void>()
      draining = completion.promise
      taskAbort.abort(new Error('participant task disposed'))
      const joins: Promise<void>[] = [acquired.promise]
      for (const stop of [() => delivery?.dispose(), () => execution?.dispose()]) {
        try { joins.push(Promise.resolve(stop())) } catch (error: unknown) {
          const failed = Promise.withResolvers<void>()
          failed.reject(error)
          joins.push(failed.promise)
        }
      }
      void Promise.allSettled(joins).then((results) => {
        const errors = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length > 0) throw new AggregateError(errors, 'participant task drain failed')
      }).then(completion.resolve, completion.reject)
      return completion.promise
    }
    const dispose = (): Promise<void> => {
      if (disposal !== undefined) return disposal
      const completion = Promise.withResolvers<void>()
      disposal = completion.promise
      void (async () => {
        try {
          const errors: unknown[] = []
          await drain()
          if (this.stopping !== undefined) await this.release.promise
          for (const lease of [...leases].reverse()) {
            try { await lease.dispose() } catch (error: unknown) { errors.push(error) }
          }
          try { await composition?.dispose() } catch (error: unknown) { errors.push(error) }
          if (errors.length > 0) throw new AggregateError(errors, 'participant task cleanup failed')
          for (const remove of withdrawals.splice(0)) remove()
          if (prepared !== undefined) this.owned.delete(prepared)
        } finally { await releaseCaller() }
      })().then(completion.resolve, completion.reject)
      return completion.promise
    }
    try {
      signal.throwIfAborted()
      const root = await this.lifetime.ctx.agents.retain({ sessionId: rootSessionId, mode: request.kind, agentOptions: {}, signal })
      leases.push(root)
      withdrawals.push(this.lifetime.ctx.sessions.registerWithdrawal(root.session, drain))
      signal.throwIfAborted()
      if (request.kind === 'create') {
        root.session.append('fusion/roster', request.roster)
        await this.barrier(root.session)
      }
      signal.throwIfAborted()
      const state = this.projection.stateOf(root.session)
      const roster = state.roster
      if (roster === null || roster.rootSessionId !== rootSessionId) throw new Error('missing or mismatched root roster')
      const key = {}
      composition = createScope(this.lifetime.ctx, key, { observeCleanup: true })
      await this.lifetime.ctx.agentPresets.mount(composition.ctx, roster.agentPreset)
      signal.throwIfAborted()
      const document = await this.lifetime.ctx.agentPresets.readDocument(roster.agentPreset)
      signal.throwIfAborted()
      const witnessKey = {}
      const witness = createScope(composition.ctx, witnessKey, { observeCleanup: true })
      try {
        await this.lifetime.ctx.agentPresets.mount(witness.ctx, roster.agentPreset)
        // Replaced generations cannot be resurrected. Equal parents bracket the document read.
        if (scopeParentOf(key) !== scopeParentOf(witnessKey)
          || createHash('sha256').update(document.content).digest('hex') !== roster.compositionDigest) {
          throw new Error('participant composition changed')
        }
      } catch (error: unknown) {
        try { await witness.dispose() } catch (cleanup: unknown) {
          throw new AggregateError([error, cleanup], 'participant composition setup and cleanup failed')
        }
        throw error
      }
      await witness.dispose()
      const pinned = composition
      for (const participant of roster.participants) {
        signal.throwIfAborted()
        const existing = await this.lifetime.ctx.sessionPersistence.stat(participant.id, { signal })
        if (existing === undefined && state.established.includes(participant.id)) throw new Error('established participant is absent')
        const lease = await this.lifetime.ctx.agents.retain({
          sessionId: participant.id, root, mode: existing === undefined ? 'create' : 'resume', signal,
          agentOptions: {
            provider: participant.binding.providerId, model: participant.binding.wireModelId,
            reasoningEffort: ReasoningEffortId(participant.binding.effort),
          },
          setup: (ctx) => { this.lifetime.ctx.agentPresets.composeFrom(ctx, pinned.ctx) },
        })
        leases.push(lease)
        withdrawals.push(this.lifetime.ctx.sessions.registerWithdrawal(lease.session, drain))
        participants.set(participant.id, lease)
        signal.throwIfAborted()
        if (!state.established.includes(participant.id)) {
          root.session.append('fusion/participant-established', { participantId: participant.id })
          await this.barrier(root.session)
        }
      }
      await this.barrier(root.session)
      signal.throwIfAborted()
      delivery = new DeliveryOwner({
        ctx: this.lifetime.ctx, root: root.session, signal,
        participants: new Map([...participants].map(([id, lease]) => [id, lease.session])),
        projections: { admissions: this.admissions, receivers: this.receivers },
      })
      await delivery.reconcile()
      signal.throwIfAborted()
      const deliveryOwner = delivery
      const sessions = new Map([...participants].map(([id, lease]) => [id, lease.session]))
      execution = new TaskExecutionOwner({
        ctx: this.lifetime.ctx, root: root.session, participants: sessions, signal, adapters: [], drain: () => deliveryOwner.dispose(),
        state: new Map([root.session, ...sessions.values()].map(session => [session, this.executions.readerFor(session)])),
      })
      await execution.open()
      const executionOwner = execution
      signal.throwIfAborted()
      prepared = Object.freeze({
        roster: deepFreeze(roster),
        delivery: deliveryOwner,
        get execution(): ExecutionSnapshot { return executionOwner.snapshot() },
        adopt: async (role: string): Promise<AgentHandle> => {
          const id = roster.roles[role]
          const lease = id === undefined ? undefined : participants.get(id)
          if (disposal !== undefined || lease === undefined) throw new Error('participant is not owned by this prepared task')
          signal.throwIfAborted()
          return deliveryOwner.adopt(() => lease.adopt())
        },
        dispose,
      })
      this.executionOwners.set(prepared, executionOwner)
      this.owned.set(prepared, drain)
      acquired.resolve()
      quiescent()
      return prepared
    } catch (error: unknown) {
      acquired.resolve()
      quiescent()
      try { await dispose() } catch (cleanup: unknown) { this.cleanupErrors.push(cleanup); throw new ParticipantPreparationError(rootSessionId, 'unknown', new AggregateError([error, cleanup], 'participant preparation and cleanup failed')) }
      throw new ParticipantPreparationError(rootSessionId, 'complete', error)
    }
  }
}
