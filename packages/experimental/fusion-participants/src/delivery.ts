/** Dormant root-owned text transport on exact retained Sessions and writers. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { contentHash, createIntent, same } from './delivery-state.ts'
import type { AdmissionState, DeliveryCompletion, DeliveryId, DeliveryIntent, DeliveryOrigin, ReceiverState, TextDelivery } from './delivery-state.ts'
import { TaskOrder } from './task-order.ts'

/** Host receipt promises one logical instruction, never a claim, execution or effect settlement. */
export interface DeliveryReceipt extends DeliveryCompletion { readonly messageId: DeliveryIntent['instruction']['id'] }
/** Synchronous immutable view; all ordinary inputs remain unclassified and dirty. */
export interface AdmissionSnapshot {
  readonly decisionInputRevision: number
  readonly dirtyGeneration: number
  readonly reservations: readonly DeliveryId[]
  readonly transportPending: readonly DeliveryId[]
  readonly classificationPending: readonly DeliveryId[]
}
/** Host-only text admission with no Agent activation or execution capability. */
export interface DormantDelivery {
  /** Admit user text; a signal can stop an unrecorded operation or its caller, never erase an intent. */
  admitUser(input: TextDelivery, signal?: AbortSignal): Promise<DeliveryReceipt>
  /** Authenticate the exact live peer against this retained task before reserving text. */
  admitPeer(sender: Agent, input: TextDelivery, signal?: AbortSignal): Promise<DeliveryReceipt>
  /** Reconcile surviving prefixes and reprove current writer coverage before dependent operations. */
  reconcile(): Promise<void>
  /** Read immutable input facts and synchronous pending reservations without I/O. */
  snapshot(): AdmissionSnapshot
}
/** Delivery is pending or uncertain; the retained owner must reconcile the original ID. */
export class DeliveryBlockedError extends Error {
  readonly code = 'fusion-participants/delivery-blocked'
  constructor(readonly deliveryId: DeliveryId | null, cause: unknown) {
    super(`Fusion delivery ${deliveryId ?? 'reconciliation'} blocked; retain identity and reconcile`, { cause })
  }
}

interface Owner {
  ctx: Context
  root: Session
  participants: ReadonlyMap<SessionId, Session>
  projections: { admissions: ProjectionHandle<AdmissionState>; receivers: ProjectionHandle<ReceiverState> }
  signal: AbortSignal
}
interface Reservation { intent: DeliveryIntent; promise: Promise<DeliveryReceipt> | null }
const inboxLengths = z.object({ 'next-turn': z.array(z.unknown()), 'next-step': z.array(z.unknown()) })

/** Private task lifetime; adopted Agents borrow the same order as text transport. */
export class DeliveryOwner implements DormantDelivery {
  private readonly order = new TaskOrder()
  private readonly abort = new AbortController()
  private readonly signal: AbortSignal
  private readonly reservations = new Map<DeliveryId, Reservation>()
  private readonly proven = new Set<DeliveryId>()
  private readonly writers = new Map<Session, symbol>()

  constructor(private readonly owner: Owner) {
    this.signal = AbortSignal.any([owner.signal, this.abort.signal])
  }

  private rootState(): AdmissionState {
    const state = this.owner.projections.admissions.stateOf(this.owner.root)
    if (state.sessionId !== this.owner.root.id) throw new Error('root checkpoint belongs to another Session')
    return state
  }
  private receiver(session: Session): ReceiverState {
    const state = this.owner.projections.receivers.stateOf(session)
    if (state.sessionId !== session.id) throw new Error('receiver checkpoint belongs to another Session')
    return state
  }

  admitUser(input: TextDelivery, signal?: AbortSignal): Promise<DeliveryReceipt> {
    return this.admit(input, { kind: 'user' }, signal)
  }

  admitPeer(sender: Agent, input: TextDelivery, signal?: AbortSignal): Promise<DeliveryReceipt> {
    try {
      this.signal.throwIfAborted()
      if (this.owner.ctx.agents.get(sender.id) !== sender || this.owner.participants.get(sender.id) !== sender.session
        || input.targetParticipantId === sender.id) throw new Error('sender is not a distinct live peer of this task')
      return this.admit(input, { kind: 'peer', sessionId: sender.id }, signal)
    } catch (error: unknown) { return Promise.reject(new DeliveryBlockedError(input.deliveryId, error)) }
  }

  private admit(input: TextDelivery, origin: DeliveryOrigin, caller?: AbortSignal): Promise<DeliveryReceipt> {
    try {
      this.signal.throwIfAborted()
      caller?.throwIfAborted()
      if (!this.owner.participants.has(input.targetParticipantId)) throw new Error('target is outside this task')
      const state = this.rootState()
      const existing = this.reservations.get(input.deliveryId)
      const durable = state.entries.find(row => row.intent.deliveryId === input.deliveryId)?.intent
      const prior = existing?.intent ?? durable
      const digest = contentHash({ ...input, rootSessionId: this.owner.root.id, origin })
      if (prior !== undefined && prior.contentHash !== digest) throw new Error('delivery identity reused with changed input')
      if (existing?.promise != null) {
        return caller === undefined ? existing.promise : existing.promise.then((receipt) => {
          caller.throwIfAborted()
          return receipt
        })
      }
      const next = Math.max(state.entries.at(-1)?.intent.order ?? 0,
        ...[...this.reservations.values()].map(row => row.intent.order)) + 1
      const intent = prior ?? deepFreeze(createIntent(input, this.owner.root.id, origin, next))
      const reservation: Reservation = existing ?? { intent, promise: null }
      // Reservation and revision are visible synchronously, before the task-order wait.
      this.reservations.set(input.deliveryId, reservation)
      const operation = this.order.reserve(async () => {
        caller?.throwIfAborted()
        const receipt = await this.deliver(intent)
        this.signal.throwIfAborted()
        caller?.throwIfAborted()
        this.proven.add(intent.deliveryId)
        this.reservations.delete(intent.deliveryId)
        return receipt
      })
      reservation.promise = operation.catch((error: unknown) => {
        reservation.promise = null
        throw new DeliveryBlockedError(intent.deliveryId, error)
      })
      return reservation.promise
    } catch (error: unknown) { return Promise.reject(new DeliveryBlockedError(input.deliveryId, error)) }
  }

  snapshot(): AdmissionSnapshot {
    const state = this.rootState()
    const intents = new Map(state.entries.map(row => [row.intent.deliveryId, row.intent]))
    for (const { intent } of this.reservations.values()) intents.set(intent.deliveryId, intent)
    const ordered = [...intents.values()].sort((a, b) => a.order - b.order)
    const decisionInputRevision = ordered.at(-1)?.decisionInputRevision ?? 0
    return deepFreeze({
      decisionInputRevision, dirtyGeneration: decisionInputRevision,
      reservations: [...this.reservations.keys()],
      transportPending: ordered.filter(intent => !this.proven.has(intent.deliveryId)).map(intent => intent.deliveryId),
      classificationPending: ordered.map(intent => intent.deliveryId),
    })
  }

  reconcile(): Promise<void> {
    return this.order.reserve(async () => {
      try {
        this.signal.throwIfAborted()
        const state = this.rootState()
        if (this.receiver(this.owner.root).entries.length > 0) throw new Error('receiver acceptance in root')
        for (const row of state.entries) {
          const intent = row.intent
          if (!this.owner.participants.has(intent.targetParticipantId)
            || intent.origin.kind === 'peer' && (!this.owner.participants.has(intent.origin.sessionId)
              || intent.origin.sessionId === intent.targetParticipantId)) throw new Error('invalid durable task attribution')
        }
        for (const [id, session] of this.owner.participants) {
          if (this.owner.projections.admissions.stateOf(session).entries.length > 0) throw new Error('root intent in receiver')
          for (const row of this.receiver(session).entries) {
            const root = state.entries.find(entry => entry.intent.deliveryId === row.intent.deliveryId)
            if (root === undefined || row.intent.targetParticipantId !== id || !same(row.intent, root.intent)) {
              throw new Error('receiver history has no identical root intent')
            }
          }
        }
        const intents = new Map(state.entries.map(row => [row.intent.deliveryId, row.intent]))
        for (const { intent } of this.reservations.values()) intents.set(intent.deliveryId, intent)
        for (const intent of [...intents.values()].sort((a, b) => a.order - b.order)) {
          await this.deliver(intent)
          this.signal.throwIfAborted()
          this.proven.add(intent.deliveryId)
          this.reservations.delete(intent.deliveryId)
        }
      } catch (error: unknown) { throw new DeliveryBlockedError(null, error) }
    }, true)
  }

  /**
   * Reserve parked adoption after reconciliation, holding the same task slot through adoption's barrier.
   * @param adopt - retained lease adoption without execution rights.
   * @returns the borrowed parked Agent handle.
   */
  async adopt<T>(adopt: () => Promise<T>): Promise<T> {
    await this.reconcile()
    return this.order.reserve(async () => {
      this.signal.throwIfAborted()
      const handle = await adopt()
      this.signal.throwIfAborted()
      return handle
    })
  }

  /** Abort caller publication, then drain owned operations before writers can close. */
  dispose(): Promise<void> {
    this.abort.abort(new Error('delivery owner disposed'))
    return this.order.close()
  }

  private async barrier(session: Session): Promise<void> {
    this.signal.throwIfAborted()
    const boundary = session.seq
    const result = await this.owner.ctx.sessionPersistence.flushSessionDurably(session)
    this.signal.throwIfAborted()
    if (result.kind !== 'durable' || result.session !== session || result.boundary < boundary
      || this.writers.has(session) && this.writers.get(session) !== result.writer) throw new Error('delivery writer coverage unproven')
    this.writers.set(session, result.writer)
  }

  private async deliver(intent: DeliveryIntent): Promise<DeliveryReceipt> {
    this.signal.throwIfAborted()
    const { root } = this.owner
    let entry = this.rootState().entries.find(row => row.intent.deliveryId === intent.deliveryId)
    if (entry === undefined) {
      root.append('fusion/delivery-intent', intent)
      entry = this.rootState().entries.find(row => row.intent.deliveryId === intent.deliveryId)
    }
    if (entry === undefined || !same(entry.intent, intent)) throw new Error('root intent projection mismatch')
    await this.barrier(root)
    const target = this.owner.participants.get(intent.targetParticipantId)
    if (target === undefined) throw new Error('root intent targets a foreign participant')
    let accepted = this.receiver(target).entries.find(row => row.intent.deliveryId === intent.deliveryId)
    if (accepted !== undefined && !same(accepted.intent, intent)) throw new Error('receiver acceptance differs from root intent')
    if (accepted === undefined) {
      target.append('fusion/delivery-accepted', intent)
      accepted = this.receiver(target).entries.find(row => row.intent.deliveryId === intent.deliveryId)
    }
    if (accepted === undefined) throw new Error('receiver acceptance projection mismatch')
    if (accepted.instructionSeq === null) {
      const inbox = inboxLengths.parse(this.owner.ctx.sessionProjections.snapshot(target, ['inbox']).values.inbox)
      target.append('agent/inbox/spliced', { target: intent.inboxTarget, start: inbox[intent.inboxTarget].length, inserted: [intent.instruction] })
      accepted = this.receiver(target).entries.find(row => row.intent.deliveryId === intent.deliveryId)
    }
    if (accepted === undefined || accepted.instructionSeq === null) throw new Error('receiver insertion projection mismatch')
    await this.barrier(target)
    const completion: DeliveryCompletion = {
      deliveryId: intent.deliveryId, contentHash: intent.contentHash, order: intent.order,
      decisionInputRevision: intent.decisionInputRevision, targetParticipantId: intent.targetParticipantId,
      acceptanceSeq: accepted.acceptanceSeq, instructionSeq: accepted.instructionSeq,
      receiverBoundary: accepted.instructionSeq + 1,
    }
    if (entry.completion === null) {
      root.append('fusion/delivery-completed', completion)
      entry = this.rootState().entries.find(row => row.intent.deliveryId === intent.deliveryId)
    }
    if (entry === undefined || !same(entry.completion, completion)) throw new Error('root completion projection mismatch')
    await this.barrier(root)
    return deepFreeze({ ...completion, messageId: intent.instruction.id })
  }
}
