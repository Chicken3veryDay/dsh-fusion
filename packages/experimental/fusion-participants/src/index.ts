/** Host-only retained participant preparation. Publication confers no execution or mutation authority. */
import { createHash } from 'node:crypto'
import { createScope, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { Context, Service } from '@deepseek-ai/cordis'
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
import { rosterProjection } from './state.ts'
import type { RosterState } from './state.ts'

export { DeliveryId } from './delivery-state.ts'
export type { TextDelivery } from './delivery-state.ts'
export { DeliveryBlockedError } from './delivery.ts'
export type { DormantDelivery, DeliveryReceipt, AdmissionSnapshot } from './delivery.ts'
export type { Roster } from './roster.ts'

/** Capability returned only after all required leases, routes and barriers succeed. */
export interface PreparedParticipants {
  /** Immutable root roster; IDs and routes survive Agent detachment and process restart. */
  readonly roster: Roster
  /** Host-only durable text transport; no execution authority. */
  readonly delivery: DormantDelivery
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
  static inject = ['agentLoop', 'agents', 'sessionPersistence', 'sessionProjections', 'fusionConfig', 'agentPresets']
  private readonly abort = new AbortController()
  private readonly pending = new Map<Promise<PreparedParticipants>, Promise<void>>()
  private readonly owned = new Map<PreparedParticipants, () => Promise<void>>()
  private readonly release = Promise.withResolvers<void>()
  private readonly lifetime: { ctx: Context; resources: Scope }
  private stopping: Promise<void> | undefined
  private readonly cleanupErrors: unknown[] = []
  private admissions!: ProjectionHandle<AdmissionState>
  private receivers!: ProjectionHandle<ReceiverState>
  private projection!: ProjectionHandle<RosterState>

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
  }

  /**
   * Capture one exact selection and prepare inert durable participant contexts.
   * @param selectionId - named immutable fusion-config selection.
   * @param signal - optional cancellation; owner disposal always cancels preparation.
   * @returns prepared capability only after every writer passes its own durability barrier.
   */
  prepare(selectionId: string, signal?: AbortSignal): Promise<PreparedParticipants> {
    return this.track(async (ownedSignal, quiescent) => {
      const selection = this.lifetime.ctx.fusionConfig.selection(selectionId)
      const document = await this.lifetime.ctx.agentPresets.readDocument(selection.agentPreset)
      ownedSignal.throwIfAborted()
      const compositionDigest = createHash('sha256').update(document.content).digest('hex')
      return this.acquire({ kind: 'create', roster: captureRoster(selection, compositionDigest) }, ownedSignal, quiescent)
    }, signal)
  }

  /**
   * Recover the root and persisted participants under root-first leases.
   * @param rootSessionId - persisted root identity; absence/corruption is a blocking failure.
   * @param signal - optional cancellation; omission keeps owner disposal cancellation.
   * @returns a prepared capability using the original roster and context lineages.
   */
  recover(rootSessionId: SessionId, signal?: AbortSignal): Promise<PreparedParticipants> {
    return this.track((ownedSignal, quiescent) => this.acquire({ kind: 'resume', rootSessionId }, ownedSignal, quiescent), signal)
  }

  private track(
    work: (signal: AbortSignal, quiescent: () => void) => Promise<PreparedParticipants>,
    caller?: AbortSignal,
  ): Promise<PreparedParticipants> {
    const operation = Promise.withResolvers<PreparedParticipants>()
    const abort = new AbortController()
    const signal = AbortSignal.any([this.abort.signal, abort.signal, ...caller === undefined ? [] : [caller]])
    try {
      signal.throwIfAborted()
      this.ctx.fiber.assertActive()
      // Caller scopes cancel and join; only the captured resource scope owns leases.
      this.ctx.effect(() => async () => {
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
      return work(signal, quiescent.resolve)
    }).then(operation.resolve, operation.reject).finally(quiescent.resolve)
    return operation.promise
  }

  private async barrier(session: Session): Promise<void> {
    const result = await this.lifetime.ctx.sessionPersistence.flushSessionDurably(session)
    if (result.kind !== 'durable') throw new Error(`participant durability refused: ${result.reason}`)
  }

  private async acquire(
    request: { kind: 'create'; roster: Roster } | { kind: 'resume'; rootSessionId: SessionId },
    caller: AbortSignal,
    quiescent: () => void,
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
    const drain = (): Promise<void> => {
      taskAbort.abort(new Error('participant task disposed'))
      return delivery?.dispose() ?? Promise.resolve()
    }
    const dispose = (): Promise<void> => {
      if (disposal !== undefined) return disposal
      const completion = Promise.withResolvers<void>()
      disposal = completion.promise
      void (async () => {
        const errors: unknown[] = []
        try { await drain() } catch (error: unknown) { errors.push(error) }
        if (this.stopping !== undefined) await this.release.promise
        for (const lease of [...leases].reverse()) {
          try { await lease.dispose() } catch (error: unknown) { errors.push(error) }
        }
        try { await composition?.dispose() } catch (error: unknown) { errors.push(error) }
        if (errors.length > 0) throw new AggregateError(errors, 'participant task cleanup failed')
        if (prepared !== undefined) this.owned.delete(prepared)
      })().then(completion.resolve, completion.reject)
      return completion.promise
    }
    try {
      signal.throwIfAborted()
      const root = await this.lifetime.ctx.agents.retain({ sessionId: rootSessionId, mode: request.kind, agentOptions: {}, signal })
      leases.push(root)
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
        participants.set(participant.id, lease)
        signal.throwIfAborted()
        if (!state.established.includes(participant.id)) {
          root.session.append('fusion/participant-established', { participantId: participant.id })
          await this.barrier(root.session)
        }
      }
      await this.barrier(root.session)
      signal.throwIfAborted()
      signal.throwIfAborted()
      delivery = new DeliveryOwner({
        ctx: this.lifetime.ctx, root: root.session, signal,
        participants: new Map([...participants].map(([id, lease]) => [id, lease.session])),
        projections: { admissions: this.admissions, receivers: this.receivers },
      })
      await delivery.reconcile()
      const deliveryOwner = delivery
      signal.throwIfAborted()
      prepared = Object.freeze({
        roster: deepFreeze(roster),
        delivery: deliveryOwner,
        adopt: async (role: string): Promise<AgentHandle> => {
          const id = roster.roles[role]
          const lease = id === undefined ? undefined : participants.get(id)
          if (disposal !== undefined || lease === undefined) throw new Error('participant is not owned by this prepared task')
          signal.throwIfAborted()
          return deliveryOwner.adopt(() => lease.adopt())
        },
        dispose,
      })
      this.owned.set(prepared, drain)
      quiescent()
      return prepared
    } catch (error: unknown) {
      quiescent()
      try { await dispose() } catch (cleanup: unknown) { this.cleanupErrors.push(cleanup); throw new ParticipantPreparationError(rootSessionId, 'unknown', new AggregateError([error, cleanup], 'participant preparation and cleanup failed')) }
      throw new ParticipantPreparationError(rootSessionId, 'complete', error)
    }
  }
}
