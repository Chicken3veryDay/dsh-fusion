/** Durable Workstreams keep technical ownership separate from coordinator authority. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { foldSubagentDescriptor, SubagentError } from '@deepseek-ai/dsh-subagent'
import { TicketError, type AssignTicketRequest, type CreateTicketRequest, type EndTicketRequest, type TicketId, type TicketView } from '@deepseek-ai/dsh-experimental-ticket'
import { WorkstreamError, WorkstreamPartialHandoffError } from './error.ts'
import { acceptedMessage } from './accepted-message.ts'
import { ticketParticipants, workstreamProjectionDefinition } from './projection.ts'
import type { WorkstreamProjectionState } from './projection.ts'
import type { AddWorkstreamMemberRequest, Config, SendWorkstreamMessageRequest, WorkstreamMember, WorkstreamMessage,
  WorkstreamOperationId, WorkstreamSnapshot } from './types.ts'

export { WorkstreamOperationId } from './ids.ts'
export { WorkstreamError, WorkstreamPartialHandoffError } from './error.ts'
export type { WorkstreamErrorCode } from './error.ts'
export type * from './types.ts'
export { WorkstreamTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { workstreams: WorkstreamService }
}

/** Authenticated live caller and its durable membership in one root. */
export interface WorkstreamMembership {
  readonly owner: Agent
  readonly snapshot: WorkstreamSnapshot
  readonly member: WorkstreamMember
}

/** Result of one finite, cancellable durable-change observation. */
export interface WorkstreamWaitResult {
  readonly timedOut: boolean
  readonly revision: number
}

const defaults: Required<Config> = {
  maxMembers: 16, maxMessages: 256, maxSnapshotBytes: 1_048_576, maxMessageBytes: 65_536, maxWaitMs: 3_600_000,
}

/** Byte size of the complete JSON value, including framing and metadata. */
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }

/** Result of the queued half of `addMember`: a recorded member, or an unconfirmed launch the caller settles outside the queue. */
type ProvisionOutcome = { readonly kind: 'provisioned'; readonly member: WorkstreamMember }
  | { readonly kind: 'uncertain'; readonly owner: Agent; readonly memberId: SessionId; readonly error: unknown }

/** Turn number of a child's last turn when it is still open or ended aborted or interrupted; undefined otherwise. */
function unfinishedTurn(events: readonly SessionEvent[]): number | undefined {
  for (const event of events.toReversed()) {
    if (event.type === 'turn/start') return event.data.turn
    if (event.type === 'turn/end') {
      return event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted' ? event.data.turn : undefined
    }
  }
  return undefined
}

function deliveryKey(root: SessionId, operationId: WorkstreamOperationId): string { return `${root}\u0000${operationId}` }

/** Host service; unknown intents are reconciled but never automatically executed again. */
export class WorkstreamService extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents', 'tickets']
  static Config: z<Config> = z.object({
    maxMembers: z.number().step(1).min(1).default(defaults.maxMembers),
    maxMessages: z.number().step(1).min(1).default(defaults.maxMessages),
    maxSnapshotBytes: z.number().step(1).min(1).default(defaults.maxSnapshotBytes),
    maxMessageBytes: z.number().step(1).min(1).default(defaults.maxMessageBytes),
    maxWaitMs: z.number().step(1).min(1).default(defaults.maxWaitMs),
  })
  private readonly config: Required<Config>
  private projection!: ProjectionHandle<WorkstreamProjectionState>
  /** True once `projection` is registered and recovered snapshots are readable. */
  private ready = false
  private readonly tails = new Map<SessionId, Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()
  /** Work that runs outside the root queue (child drains, message deliveries); shutdown awaits it after draining the members. */
  private readonly detached = new Set<Promise<unknown>>()
  /** Running message deliveries by root and operation, so a retry joins the delivery instead of reporting it unknown. */
  private readonly deliveries = new Map<string, Promise<WorkstreamMessage>>()
  /** Running message deliveries by recipient, which `stop` lets finish before it drains that recipient. */
  private readonly deliveriesTo = new Map<SessionId, Set<Promise<unknown>>>()
  private readonly lifetime = new AbortController()
  /** Disposers of the Ticket authorities this service registered; `shutdown` runs them before it awaits Ticket's queues. */
  private readonly withdrawals: Array<() => void | Promise<void>> = []

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workstreams')
    this.config = { ...defaults, ...config }
    for (const [key, value] of Object.entries(this.config)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new WorkstreamError(`${key} must be a positive safe integer`,
        'WORKSTREAM_INVALID_INPUT')
    }
  }

  protected async [Service.init](): Promise<void> {
    // Installed before the asynchronous projection registration and failing closed until it settles: an owner-default Ticket
    // admitted while recovered snapshots are not yet readable would record the owner and never be reconciled.
    // A direct `tickets.create` that defaults to the owner names the sitting coordinator, so it cannot disagree with the snapshot.
    // An explicit other coordinator stays the caller's choice; `handoff` moves Tickets held by any member.
    this.withdrawals.push(this.ctx.effect(() => this.ctx.tickets.registerCoordinatorAuthority((session, requested) => {
      if (!this.ready) {
        if (requested !== session.id) return undefined
        const message = 'Workstream is still loading; retry the Ticket creation'
        throw new TicketError(message, 'TICKET_COORDINATOR_UNAVAILABLE', { cause: new WorkstreamError(message, 'WORKSTREAM_NOT_READY') })
      }
      const snapshot = this.projection.stateOf(session).snapshot
      return snapshot !== null && requested === snapshot.ownerSessionId ? snapshot.coordinatorId : undefined
    }), 'workstreams.ticketCoordinator()'))
    // The same active-child rule as `assignTicket`, checked where Ticket appends, so a stop that completes while an assignment
    // waits in Ticket's queue refuses it. The owner and inactive members are refused; a root without a Workstream is not governed.
    this.withdrawals.push(this.ctx.effect(() => this.ctx.tickets.registerAssignmentAuthority((session, assigneeId) => {
      if (!this.ready) {
        const message = 'Workstream is still loading; retry the Ticket assignment'
        throw new TicketError(message, 'TICKET_COORDINATOR_UNAVAILABLE', { cause: new WorkstreamError(message, 'WORKSTREAM_NOT_READY') })
      }
      const snapshot = this.projection.stateOf(session).snapshot
      if (snapshot === null) return
      const member = snapshot.members.find(candidate => candidate.id === assigneeId)
      if (member?.phase === 'active' && member.id !== snapshot.ownerSessionId) return
      throw new TicketError(`${assigneeId} is not an active member of this Workstream; assign an active child member`, 'TICKET_AUTHORITY')
    }), 'workstreams.ticketAssignment()'))
    // Who may act: the same rule as `requireMembership`, checked where Ticket appends. `stop` revokes membership when it
    // records `stopping`, so a command from that member that waits in Ticket's queue past the revocation is refused. The
    // execution owner's settlement and recovery writes act as the system and Ticket does not consult authorities for them.
    this.withdrawals.push(this.ctx.effect(() => this.ctx.tickets.registerCommandAuthority((session, actorId) => {
      // The root Session is always its Workstream's active owner, so its commands need no snapshot, even while loading.
      if (actorId === session.id) return
      if (!this.ready) {
        const message = 'Workstream is still loading; retry the Ticket command'
        throw new TicketError(message, 'TICKET_COORDINATOR_UNAVAILABLE', { cause: new WorkstreamError(message, 'WORKSTREAM_NOT_READY') })
      }
      const snapshot = this.projection.stateOf(session).snapshot
      if (snapshot === null) return
      const member = snapshot.members.find(candidate => candidate.id === actorId && candidate.phase === 'active')
      const direct = this.ctx.agents.get(actorId)?.session.header.parentSession === session.id
      if (member !== undefined && direct) return
      const message = `${actorId} is not an active member of this Workstream`
      throw new TicketError(message, 'TICKET_AUTHORITY', { cause: new WorkstreamError(message, 'WORKSTREAM_UNAUTHORIZED') })
    }), 'workstreams.ticketActor()'))
    this.projection = await this.ctx.sessionProjections.register(workstreamProjectionDefinition)
    this.ready = true
    // Serial and awaited before the resumed owner's queued input runs, so the notice reaches its first request.
    this.ctx.on('agent/created', async ({ agent, source, signal }) => {
      if (source === 'resume') await this.reportUnfinishedMembers(agent, signal)
    })
    this.ctx.effect(() => () => this.shutdown(), 'workstreams.runtime()')
  }

  /** Open one root-owned Workstream, idempotently for the same creation key.
   * @param caller - exact live technical owner.
   * @param request - stable operation identity and human-readable title.
   * @returns committed Workstream snapshot.
   */
  async open(caller: Agent, request: { operationId: WorkstreamOperationId; title: string }): Promise<WorkstreamSnapshot> {
    this.live(caller)
    return this.enqueue(caller.id, async () => {
      this.live(caller)
      const prior = this.projection.stateOf(caller.session).snapshot
      if (prior !== null) {
        if (prior.operationId !== request.operationId || prior.title !== request.title) throw new
        WorkstreamError('Root already owns a different Workstream', 'WORKSTREAM_CONFLICT')
        return this.durable(caller, structuredClone(prior))
      }
      this.text(request.title, 'title')
      if (caller.session.header.parentSession !== undefined) throw new
      WorkstreamError('Only a root Session can own a Workstream', 'WORKSTREAM_UNAUTHORIZED')
      return this.commit(caller, {
        ownerSessionId: caller.id, coordinatorId: caller.id, operationId: request.operationId,
        title: request.title, revision: 1, messages: [],
        members: [{ id: caller.id, name: 'owner', role: 'owner', description: request.title, provider: 'owner', prompt: '',
          operationId: request.operationId, phase: 'active', diagnostic: null }],
      })
    })
  }

  /** Resolve exact live membership against the immutable technical owner.
   * @param caller - live caller, never an id supplied as authorization.
   * @param rootSessionId - explicit Workstream root.
   * @returns technical owner, detached snapshot and durable member.
   */
  requireMembership(caller: Agent, rootSessionId: SessionId): WorkstreamMembership {
    this.live(caller)
    const owner = this.ctx.agents.get(rootSessionId)
    if (owner === undefined) throw new WorkstreamError('Workstream owner is not live; resume its Session first', 'WORKSTREAM_NOT_FOUND')
    const snapshot = this.projection.stateOf(owner.session).snapshot
    if (snapshot === null) throw new WorkstreamError('Root has no Workstream; open it first', 'WORKSTREAM_NOT_FOUND')
    const member = snapshot.members.find(candidate => candidate.id === caller.id && candidate.phase === 'active')
    if (member === undefined || (caller !== owner && caller.session.header.parentSession !== owner.id)) throw new
    WorkstreamError('Caller is not an active member of this Workstream', 'WORKSTREAM_UNAUTHORIZED')
    return { owner, snapshot: structuredClone(snapshot), member: structuredClone(member) }
  }

  /** Read one Workstream visible to the exact live caller.
   * @param caller - authenticated member.
   * @param rootSessionId - explicit Workstream root.
   * @returns detached current value.
   */
  get(caller: Agent, rootSessionId: SessionId): WorkstreamSnapshot { return this.requireMembership(caller, rootSessionId).snapshot }

  /** List live Workstream roots visible to one live member.
   * @param caller - exact live Agent.
   * @returns bounded list, at most the caller's root Workstream.
   */
  list(caller: Agent): WorkstreamSnapshot[] {
    this.live(caller)
    const rootId = caller.session.header.parentSession ?? caller.id
    const owner = this.ctx.agents.get(rootId)
    if (owner === undefined || this.projection.stateOf(owner.session).snapshot === null) return []
    try { return [this.get(caller, rootId)] } catch (error: unknown) {
      // A stopped member or an ordinary child of the root has no membership to list.
      if (error instanceof WorkstreamError && error.code === 'WORKSTREAM_UNAUTHORIZED') return []
      throw error
    }
  }

  /** Provision or reconcile one continuable direct child under a stable operation id.
   * @param caller - owner or current coordinator.
   * @param rootSessionId - stable technical owner.
   * @param request - immutable intent and cancellation before acceptance.
   * @returns active member; unresolved prior effects throw WORKSTREAM_UNKNOWN without another launch, and a Subagent
   * activation-limit refusal throws WORKSTREAM_CAPACITY with no member recorded.
   */
  async addMember(caller: Agent, rootSessionId: SessionId, request: AddWorkstreamMemberRequest): Promise<WorkstreamMember> {
    const outcome = await this.enqueue(rootSessionId, (): Promise<ProvisionOutcome> => this.provisionMember(caller, rootSessionId, request))
    if (outcome.kind === 'provisioned') return outcome.member
    // Settle the unconfirmed child outside the root queue: its first Workstream tool call may be queued behind this operation
    // and must be able to finish for the drain to complete. The member stays `provisioning`, so there is nothing to commit
    // afterwards; a retry of the same operation reconciles it from the child's log.
    const cause = await this.track(this.ctx.subagents.drainChildren(outcome.owner, [outcome.memberId]).then(
      () => outcome.error, (drainError: unknown) => new AggregateError([outcome.error, drainError], 'Provisioning failed and the child did not drain')))
    throw new WorkstreamError(`Member provisioning remains uncertain; inspect ${outcome.memberId} and retry the same operation`,
      'WORKSTREAM_UNKNOWN', { cause })
  }

  /** The queued part of {@link addMember}: records and launches the member; when the launch is uncertain it returns, not drains. */
  private async provisionMember(caller: Agent, rootSessionId: SessionId, request: AddWorkstreamMemberRequest): Promise<ProvisionOutcome> {
    const { owner, snapshot } = this.coordinator(caller, rootSessionId)
    request.signal.throwIfAborted()
    const prior = snapshot.members.find(member => member.operationId === request.operationId)
    if (prior !== undefined) {
      if (prior.name !== request.name || prior.provider !== request.provider || prior.prompt !== request.prompt ||
        prior.description !== request.description) throw new WorkstreamError('Member operation id was reused with different input',
        'WORKSTREAM_CONFLICT')
      if (prior.phase === 'active') return { kind: 'provisioned', member: await this.durable(owner, prior) }
      if (prior.phase !== 'provisioning') throw new
      WorkstreamError('Member is stopped or stopping; use a new operation id and name', 'WORKSTREAM_CONFLICT')
      return { kind: 'provisioned', member: await this.reconcileMember(owner, snapshot, prior, request.signal) }
    }
    this.text(request.name, 'name'); this.text(request.description, 'description'); this.text(request.provider,
      'provider'); this.text(request.prompt, 'prompt')
    if (snapshot.members.length >= this.config.maxMembers) throw new WorkstreamError('Workstream member limit reached',
      'WORKSTREAM_LIMIT')
    if (snapshot.members.some(member => member.name === request.name)) throw new
    WorkstreamError('Member name is already reserved', 'WORKSTREAM_CONFLICT')
    const provider = this.ctx.subagents.getProvider(request.provider)
    if (provider?.prepareContinuable === undefined) throw new
    WorkstreamError('Member provider must support local continuable children', 'WORKSTREAM_INVALID_INPUT')
    const member: WorkstreamMember = { id: SessionId(randomUUID()), role: 'member', operationId: request.operationId, name:
      request.name, description: request.description, provider: request.provider, prompt: request.prompt, phase: 'provisioning',
    diagnostic: 'Provisioning acceptance is not yet confirmed; retry the same operation to reconcile' }
    await this.commit(owner, { ...snapshot, revision: snapshot.revision + 1, members: [...snapshot.members, member] })
    try {
      const started = await this.ctx.subagents.startActivation({
        delivery: 'parent', childId: member.id, provider: member.provider, label: member.description,
        request: { parent: owner, prompt: [{ type: 'text', text: member.prompt }] },
        signal: AbortSignal.any([request.signal, this.lifetime.signal]),
      })
      const session = this.ctx.sessions.get(member.id)
      if (session === undefined) throw new
      WorkstreamError('Provisioned child left the live registry before durability confirmation', 'WORKSTREAM_UNKNOWN')
      await this.ctx.sessions.flush(session)
      return { kind: 'provisioned', member: await this.reconcileMember(owner, this.state(owner), member, request.signal, started.messageId) }
    } catch (error: unknown) {
      if (error instanceof SubagentError && error.code === 'ACTIVATION_LIMIT_REACHED') return this.refuseMember(owner, member, error)
      return { kind: 'uncertain', owner, memberId: member.id, error }
    }
  }

  /** Subagent refuses at its activation limit before any child Session exists, so the refusal is definite: remove the
   * `provisioning` record, freeing its name and operation id, and report a capacity refusal that the same operation may retry.
   * @throws WorkstreamError `WORKSTREAM_CAPACITY` once the removal is durable, or `WORKSTREAM_UNKNOWN` when it is not. */
  private async refuseMember(owner: Agent, member: WorkstreamMember, refusal: SubagentError): Promise<never> {
    const snapshot = this.state(owner)
    try {
      await this.commit(owner, { ...snapshot, revision: snapshot.revision + 1, members: snapshot.members.filter(candidate =>
        candidate.id !== member.id) })
    } catch (error: unknown) {
      throw new WorkstreamError(`Member "${member.name}" was not started, but removing its provisioning record is uncertain; retry the same operation`,
        'WORKSTREAM_UNKNOWN', { cause: new AggregateError([refusal, error], 'Capacity refusal rollback failed') })
    }
    throw new WorkstreamError(`Member "${member.name}" was not added: ${refusal.message}. Nothing was recorded; a member whose turn ends or that is stopped frees a slot, then retry the same operation`,
      'WORKSTREAM_CAPACITY', { cause: refusal })
  }

  /** Transfer the coordinator role to a member, moving Ticket coordination with it, while preserving every child parent and root log.
   *
   * Tickets move first and the Workstream snapshot commits last, so the Workstream coordinator never names a member the
   * Tickets have not yet followed. Each move is authenticated by the immutable technical owner after Workstream verifies
   * the caller's authority.
   * @param caller - current coordinator or immutable owner.
   * @param rootSessionId - explicit technical owner.
   * @param request - CAS revision and active new coordinator.
   * @returns committed next snapshot.
   * @throws WorkstreamPartialHandoffError when some Tickets could not move, were handed back by a competing writer, or the
   * service began stopping after some moved; the coordinator is unchanged and the same call may be retried.
   */
  async handoff(caller: Agent, rootSessionId: SessionId, request: { expectedRevision: number; coordinatorId: SessionId }):
  Promise<WorkstreamSnapshot> {
    return this.enqueue(rootSessionId, async () => {
      const { owner, snapshot } = this.coordinator(caller, rootSessionId)
      if (snapshot.revision !== request.expectedRevision) throw new
      WorkstreamError('Workstream changed; refresh before handoff', 'WORKSTREAM_CONFLICT')
      this.target(snapshot, request.coordinatorId)
      await this.resumeSuccessor(owner, request.coordinatorId)
      this.liveSuccessor(request.coordinatorId)
      const next:WorkstreamSnapshot = { ...snapshot, revision: snapshot.revision + 1, coordinatorId: request.coordinatorId }
      this.fit(next)
      const moved = await this.moveTicketsAndAppend(owner, snapshot, next)
      try {
        await this.ctx.sessions.flush(owner.session)
        return structuredClone(next)
      } catch (error: unknown) {
        if (moved === 0) throw error
        throw new WorkstreamError('Tickets moved but the Workstream coordinator commit is uncertain; refresh and inspect before retrying',
          'WORKSTREAM_UNKNOWN', { cause: error })
      }
    })
  }

  /** Deliver one immutable message intent with durable acceptance distinct from processing.
   * @param caller - exact live sending member.
   * @param rootSessionId - explicit root selecting recipient membership.
   * @param request - stable operation id, target, message and optional logged context packet.
   * @returns current durable delivery receipt; unresolved retries never send again.
   */
  async sendMessage(caller: Agent, rootSessionId: SessionId, request: SendWorkstreamMessageRequest): Promise<WorkstreamMessage> {
    // The queue covers only the durable intent and the durable receipt. Delivery runs outside it: a closing recipient's
    // disposal waits for that recipient's own queued Workstream tools, which cannot start while this operation holds the queue.
    const { settled } = await this.enqueue(rootSessionId, () => this.admitMessage(caller, rootSessionId, request))
    return settled
  }

  /** The queued part of {@link sendMessage}: validates, records the intent, and starts its delivery. */
  private async admitMessage(caller: Agent, rootSessionId: SessionId, request: SendWorkstreamMessageRequest):
  Promise<{ readonly settled: Promise<WorkstreamMessage> }> {
    const { owner, snapshot } = this.requireMembership(caller, rootSessionId)
    request.signal.throwIfAborted()
    const prior = snapshot.messages.find(message => message.operationId === request.operationId)
    if (prior !== undefined) {
      if (prior.senderId !== caller.id || prior.targetId !== request.targetId || prior.text !== request.text ||
        JSON.stringify(prior.context) !== JSON.stringify(request.context ?? null)) throw new
      WorkstreamError('Message operation id was reused with different input', 'WORKSTREAM_CONFLICT')
      if (prior.delivery.phase !== 'intent') return { settled: Promise.resolve(await this.durable(owner, prior)) }
      // A delivery of this operation that is still running owns the outcome; a retry joins it instead of reporting it unknown.
      const running = this.deliveries.get(deliveryKey(rootSessionId, request.operationId))
      if (running !== undefined) return { settled: running }
      return { settled: Promise.resolve(await this.reconcileMessage(owner, snapshot, prior, request.signal)) }
    }
    this.target(snapshot, request.targetId)
    if (request.targetId === caller.id) throw new WorkstreamError('Choose another Workstream member', 'WORKSTREAM_INVALID_INPUT')
    this.text(request.text, 'text')
    if (snapshot.messages.length >= this.config.maxMessages) throw new WorkstreamError('Workstream message limit reached',
      'WORKSTREAM_LIMIT')
    const message: WorkstreamMessage = { operationId: request.operationId, senderId: caller.id, targetId: request.targetId,
      text: request.text, context: request.context ?? null, diagnostic:
      'Inbox acceptance is not yet confirmed; retry the same operation to reconcile', delivery: { phase: 'intent' } }
    if (bytes(message) > this.config.maxMessageBytes) throw new
    WorkstreamError('Complete Workstream message exceeds maxMessageBytes', 'WORKSTREAM_LIMIT')
    await this.commit(owner, { ...snapshot, revision: snapshot.revision + 1, messages: [...snapshot.messages, message] })
    // Registered before the queue is released, so a `stop` queued next already sees this delivery.
    const delivery = this.track(this.deliver(owner, message, request))
    this.registerDelivery(rootSessionId, message, delivery)
    return { settled: delivery }
  }

  private async deliver(owner: Agent, message: WorkstreamMessage, request: SendWorkstreamMessageRequest): Promise<WorkstreamMessage> {
    const source = { kind: 'workstream-message' as const, rootSessionId: owner.id, operationId: request.operationId,
      senderSessionId: message.senderId }
    const content = [{ type: 'text' as const, text: JSON.stringify({ sender: message.senderId, text: message.text, context: message.context }) }]
    try {
      if (request.targetId === owner.id) owner.steer(createUserMessage({ content, source }))
      else await steerHostSubagentPrompt(this.ctx.subagents, owner, request.targetId, content, source,
        AbortSignal.any([request.signal, this.lifetime.signal]))
      return await this.enqueue(owner.id, () => {
        const current = this.state(owner).messages.find(candidate => candidate.operationId === message.operationId)
        if (current === undefined) throw new WorkstreamError('Message disappeared during delivery', 'WORKSTREAM_UNKNOWN')
        // Another reconciliation may have recorded acceptance while this delivery ran.
        if (current.delivery.phase !== 'intent') return this.durable(owner, current)
        return this.reconcileMessage(owner, this.state(owner), current, request.signal)
      })
    } catch (error: unknown) {
      throw new WorkstreamError('Message delivery remains uncertain; retry the same operation to inspect inbox evidence',
        'WORKSTREAM_UNKNOWN', { cause: error })
    }
  }

  private registerDelivery(rootSessionId: SessionId, message: WorkstreamMessage, delivery: Promise<WorkstreamMessage>): void {
    const key = deliveryKey(rootSessionId, message.operationId)
    const toTarget = this.deliveriesTo.get(message.targetId) ?? new Set<Promise<unknown>>()
    this.deliveries.set(key, delivery); toTarget.add(delivery); this.deliveriesTo.set(message.targetId, toTarget)
    const release = (): void => {
      this.deliveries.delete(key); toTarget.delete(delivery)
      if (toTarget.size === 0 && this.deliveriesTo.get(message.targetId) === toTarget) this.deliveriesTo.delete(message.targetId)
    }
    void delivery.then(release, release)
  }

  /** Record recipient acknowledgement; idle status never implies processing.
   * @param caller - exact live recipient.
   * @param rootSessionId - explicit Workstream root.
   * @param operationId - accepted send being acknowledged.
   * @returns the explicit processed receipt.
   */
  async acknowledge(caller: Agent, rootSessionId: SessionId, operationId: WorkstreamOperationId): Promise<WorkstreamMessage> {
    return this.enqueue(rootSessionId, async () => {
      const { owner, snapshot } = this.requireMembership(caller, rootSessionId)
      const message = snapshot.messages.find(candidate => candidate.operationId === operationId)
      if (message === undefined || message.targetId !== caller.id) throw new
      WorkstreamError('Only the message recipient can acknowledge it', 'WORKSTREAM_UNAUTHORIZED')
      if (message.delivery.phase === 'intent') throw new WorkstreamError('Reconcile inbox acceptance before acknowledgement',
        'WORKSTREAM_UNKNOWN')
      if (message.delivery.phase === 'processed') return this.durable(owner, message)
      return this.saveMessage(owner, snapshot, { ...message, delivery: { ...message.delivery, phase: 'processed' } })
    })
  }

  /** Read the wait cursor of one Workstream: the root Session position that `waitForChange` compares later events with.
   * @param caller - exact live member.
   * @param rootSessionId - explicit Workstream root.
   * @returns the position after the last root event committed so far.
   */
  cursor(caller: Agent, rootSessionId: SessionId): number {
    return this.requireMembership(caller, rootSessionId).owner.session.seq
  }

  /** Observe Workstream changes and the root Ticket events that concern the caller, without polling.
   * The owner and the sitting coordinator are concerned by every root Ticket; another member by the Tickets that name it as
   * coordinator or Assignment owner. Other root events, such as the owner's own turns, never end the wait.
   * @param caller - exact live member.
   * @param rootSessionId - explicit Workstream root.
   * @param request - last read Workstream revision, optional cursor from `cursor`, finite timeout, and caller cancellation.
   * Without `afterCursor`, every concerning event committed after `afterRevision` counts.
   * @returns at once when the revision differs from `afterRevision` or a concerning event is at or after the cursor;
   * otherwise at the next concerning event or the timeout. Abort and shutdown reject.
   */
  async waitForChange(
    caller: Agent, rootSessionId: SessionId,
    request: { afterRevision: number; afterCursor?: number; timeoutMs: number; signal: AbortSignal },
  ): Promise<WorkstreamWaitResult> {
    const { owner, snapshot } = this.requireMembership(caller, rootSessionId)
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > this.config.maxWaitMs)
      throw new WorkstreamError('timeoutMs must be positive and at most maxWaitMs', 'WORKSTREAM_INVALID_INPUT')
    if (request.afterCursor !== undefined && (!Number.isSafeInteger(request.afterCursor) || request.afterCursor < 0
      || request.afterCursor > owner.session.seq))
      throw new WorkstreamError('afterCursor must be a cursor read from this Workstream', 'WORKSTREAM_INVALID_INPUT')
    if (snapshot.revision !== request.afterRevision) return { timedOut: false, revision: snapshot.revision }
    const state = this.projection.stateOf(owner.session)
    const from = request.afterCursor ?? (state.snapshotSeq ?? -1) + 1
    const concerned = (snapshotNow: WorkstreamSnapshot): boolean =>
      caller.id === snapshotNow.ownerSessionId || caller.id === snapshotNow.coordinatorId
    const seen = Math.max(state.snapshotSeq ?? -1, (concerned(snapshot) ? state.ticketSeq : state.participantTicketSeqs[caller.id]) ?? -1)
    if (seen >= from) return { timedOut: false, revision: snapshot.revision }
    const signal = AbortSignal.any([request.signal, this.lifetime.signal])
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); stop(); signal.removeEventListener('abort', abort) }
      const abort = (): void => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new
      WorkstreamError('Workstream wait was cancelled', 'WORKSTREAM_DISPOSED')) }
      const stop = this.ctx.on('session/event', (session, event) => {
        if (session !== owner.session) return
        if (event.type === 'workstream/state') {
          if (event.data.snapshot.ownerSessionId !== owner.id) return
        } else if (event.type === 'ticket/state') {
          const ticket = ticketParticipants(event.data)
          if (ticket.sessionId !== owner.id || (!concerned(this.state(owner)) && !ticket.participants.includes(caller.id))) return
        } else return
        cleanup(); resolve({ timedOut: false, revision: this.state(owner).revision })
      })
      const timer = setTimeout(() => { cleanup(); resolve({ timedOut: true, revision: this.state(owner).revision }) }, request.timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  /** Request cancellation of one member's current turn; pending inbox remains owned by Subagent.
   * @param caller - current coordinator or immutable owner.
   * @param rootSessionId - explicit root.
   * @param targetId - active child member.
   */
  interrupt(caller: Agent, rootSessionId: SessionId, targetId: SessionId): void {
    const { owner, snapshot } = this.coordinator(caller, rootSessionId)
    this.child(snapshot, targetId)
    this.ctx.subagents.interrupt(targetId, { kind: 'ancestor', agent: owner })
  }

  /** Stop and await the selected child before persisting its stopped phase.
   * @param caller - current coordinator or immutable owner.
   * @param rootSessionId - explicit root.
   * @param targetId - child member; coordinator must hand off before stopping itself.
   * @returns stopped durable member after actual producer settlement.
   */
  async stop(caller: Agent, rootSessionId: SessionId, targetId: SessionId): Promise<WorkstreamMember> {
    const begun = await this.enqueue(rootSessionId, async () => {
      const { owner, snapshot } = this.coordinator(caller, rootSessionId)
      const member = snapshot.members.find(candidate => candidate.id === targetId)
      if (member === undefined || targetId === owner.id || targetId === snapshot.coordinatorId) throw new
      WorkstreamError('Select a child other than the coordinator', 'WORKSTREAM_INVALID_INPUT')
      if (member.phase === 'stopped') return { owner, stopped: member }
      if (member.phase !== 'stopping') await this.saveMember(owner, snapshot, { ...member, phase: 'stopping' })
      return { owner, stopped: undefined }
    })
    if (begun.stopped !== undefined) return this.durable(begun.owner, begun.stopped)
    // Drain outside the root queue: the child's own queued Workstream tools must be able to finish for it to settle.
    // A delivery already running to this member finishes first, so none resumes the member after its drain.
    await Promise.allSettled([...this.deliveriesTo.get(targetId) ?? []])
    await this.track(this.ctx.subagents.drainChildren(begun.owner, [targetId]))
    return this.enqueue(rootSessionId, async () => {
      const snapshot = this.state(begun.owner)
      const current = snapshot.members.find(candidate => candidate.id === targetId)
      if (current === undefined) throw new WorkstreamError('Member disappeared while stopping', 'WORKSTREAM_UNKNOWN')
      if (current.phase === 'stopped') return this.durable(begun.owner, current)
      return this.saveMember(begun.owner, snapshot, { ...current, phase: 'stopped', diagnostic: null })
    })
  }

  /** Create a Ticket in the stable root, coordinated by the current Workstream coordinator; peers may propose work.
   * @param caller - exact live member.
   * @param rootSessionId - Ticket-owning Workstream root.
   * @param request - Ticket content; coordinator authority is supplied by Workstream.
   * @returns committed Ticket view.
   */
  async createTicket(caller: Agent, rootSessionId: SessionId, request: Omit<CreateTicketRequest, 'coordinatorId'>): Promise<TicketView> {
    return this.enqueue(rootSessionId, async () => {
      const { owner, snapshot } = this.requireMembership(caller, rootSessionId)
      return this.ctx.agents.withInitiator(owner, () =>
        this.ctx.tickets.create(owner.session, { ...request, coordinatorId: snapshot.coordinatorId }))
    })
  }

  /** Assign a Ticket as the current coordinator; the Ticket records that caller as actor.
   * @param caller - exact current coordinator; the owner must first reclaim the role with {@link handoff}.
   * @param rootSessionId - root owning the Ticket.
   * @param request - assignment to an active Workstream member.
   * @returns committed Ticket view.
   */
  async assignTicket(caller: Agent, rootSessionId: SessionId, request: Omit<AssignTicketRequest, 'actorId'>): Promise<TicketView> {
    return this.enqueue(rootSessionId, async () => {
      const { owner, snapshot } = this.actingCoordinator(caller, rootSessionId)
      this.child(snapshot, request.ownerId)
      return this.ctx.agents.withInitiator(caller, () => this.ctx.tickets.assign(owner.session, { ...request, actorId: caller.id }))
    })
  }

  /** End a Ticket through its existing completion checks as the current coordinator; the Ticket records that caller as actor.
   * @param caller - exact current coordinator; the owner must first reclaim the role with {@link handoff}.
   * @param rootSessionId - root owning the Ticket.
   * @param request - Ticket CAS revision and summary.
   * @returns completed Ticket view.
   */
  async endTicket(caller: Agent, rootSessionId: SessionId, request: Omit<EndTicketRequest, 'actorId'>): Promise<TicketView> {
    return this.enqueue(rootSessionId, async () => {
      const { owner } = this.actingCoordinator(caller, rootSessionId)
      return this.ctx.agents.withInitiator(caller, () => this.ctx.tickets.complete(owner.session, { ...request, actorId: caller.id }))
    })
  }

  private live(caller: Agent): void {
    if (this.lifetime.signal.aborted) throw new WorkstreamError('Workstream service has stopped', 'WORKSTREAM_DISPOSED')
    if (this.ctx.agents.get(caller.id) !== caller) throw new WorkstreamError('Caller is stale; resolve the exact live Agent',
      'WORKSTREAM_UNAUTHORIZED')
  }
  private coordinator(caller: Agent, rootSessionId: SessionId): WorkstreamMembership {
    const membership = this.requireMembership(caller, rootSessionId)
    if (caller.id !== membership.owner.id && caller.id !== membership.snapshot.coordinatorId) throw new
    WorkstreamError('Current Workstream coordinator authority is required', 'WORKSTREAM_UNAUTHORIZED')
    return membership
  }
  /** Ticket mutations record the acting identity, so only the sitting coordinator may issue them. */
  private actingCoordinator(caller: Agent, rootSessionId: SessionId): WorkstreamMembership {
    const membership = this.requireMembership(caller, rootSessionId)
    if (caller.id !== membership.snapshot.coordinatorId) throw new
    WorkstreamError('Current Workstream coordinator authority is required; the owner may reclaim it by handoff', 'WORKSTREAM_UNAUTHORIZED')
    return membership
  }
  /** Hand every open Ticket coordinated by a Workstream member to the new coordinator, then append the next snapshot.
   *
   * The final empty Ticket list and the snapshot append run in one synchronous step, so no Ticket can be created between
   * them; a Ticket created earlier is in the list and moves, and one created later names the new coordinator through the
   * Ticket coordinator authority. Passes repeat while Tickets created during earlier moves remain. Each Ticket moves at
   * most once per call: one that comes back under another coordinator, or any move after service shutdown begins, ends the
   * call with a partial outcome instead of continuing. The snapshot is only appended when no Ticket is left behind.
   * @returns number of Tickets moved by this call.
   * @throws WorkstreamPartialHandoffError when a Ticket could not move, was handed back, or the service is stopping. */
  private async moveTicketsAndAppend(owner: Agent, snapshot: WorkstreamSnapshot, next: WorkstreamSnapshot): Promise<number> {
    const coordinatorId = next.coordinatorId
    const moved = new Set<TicketId>()
    const stopIfDisposed = (open: readonly TicketId[]): void => {
      if (!this.lifetime.signal.aborted) return
      const cause = new WorkstreamError('Workstream service has stopped', 'WORKSTREAM_DISPOSED', { cause: this.lifetime.signal.reason })
      if (moved.size === 0) throw cause
      throw new WorkstreamPartialHandoffError([...moved], open.filter(id => !moved.has(id)), { cause })
    }
    for (;;) {
      const open = this.ctx.tickets.list(owner.session).filter(ticket => ticket.terminalOutcome === undefined
        && ticket.coordinatorId !== coordinatorId && snapshot.members.some(member => member.id === ticket.coordinatorId))
      const openIds = open.map(ticket => ticket.id)
      stopIfDisposed(openIds)
      if (open.length === 0) {
        // Same synchronous step as the append: the successor must still be live when the snapshot names it.
        try { this.liveSuccessor(coordinatorId) } catch (error: unknown) {
          if (moved.size === 0) throw error
          throw new WorkstreamPartialHandoffError([...moved], [], { cause: error })
        }
        this.append(owner, next)
        return moved.size
      }
      const pending: TicketId[] = []
      let cause: unknown
      for (const ticket of open) {
        stopIfDisposed(openIds)
        if (moved.has(ticket.id)) {
          pending.push(ticket.id)
          cause ??= new WorkstreamError(`Ticket ${ticket.id} was handed back during the handoff; resolve the competing writer and retry`,
            'WORKSTREAM_CONFLICT')
          continue
        }
        try {
          await this.ctx.agents.withInitiator(owner, () =>
            this.ctx.tickets.handoff(owner.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
              actorId: owner.id, newCoordinatorId: coordinatorId }))
          moved.add(ticket.id)
        } catch (error: unknown) { pending.push(ticket.id); cause ??= error }
      }
      if (pending.length > 0) throw new WorkstreamPartialHandoffError([...moved], pending, { cause })
    }
  }
  private target(snapshot: WorkstreamSnapshot, id: SessionId): WorkstreamMember {
    const member = snapshot.members.find(candidate => candidate.id === id && candidate.phase === 'active')
    if (member === undefined) throw new WorkstreamError('Target is not an active Workstream member', 'WORKSTREAM_INVALID_INPUT')
    return member
  }
  /** Durable `active` membership is not liveness: a drained or unloaded member has no Agent that can act as coordinator.
   * Matches the registered live Agent check of `tickets.handoff`. */
  private liveSuccessor(id: SessionId): void {
    const agent = this.ctx.agents.get(id)
    if (agent === undefined || this.ctx.sessions.get(agent.id) !== agent.session) throw new
    WorkstreamError('Target is not a registered live Agent; send it a message with workstream_send and retry the handoff',
      'WORKSTREAM_INVALID_INPUT')
  }
  /** Cold-resume an active child member that has no registered Agent, delivering a logged notice that starts its turn.
   *
   * Runs inside the queued handoff: with no registered Agent the member has no driver, so none of its Workstream tool
   * calls can be waiting on this root queue, and the calls it makes after the resume serialize behind the commit.
   * A registered Agent is left to {@link liveSuccessor}. Nothing durable changes in Workstream when the resume fails. */
  private async resumeSuccessor(owner: Agent, id: SessionId): Promise<void> {
    if (id === owner.id || this.ctx.agents.get(id) !== undefined) return
    const text = `The coordinator role of Workstream ${owner.id} is being handed to you. When workstream_get shows your `
      + 'Session id as coordinatorId, you coordinate its Tickets: create, assign and end them, and hand the role back when done.'
    const source = { kind: 'workstream-notice' as const, rootSessionId: owner.id, form: 'notice' as const,
      summary: 'Coordinator role handoff' }
    try {
      await steerHostSubagentPrompt(this.ctx.subagents, owner, id, [{ type: 'text', text }], source, this.lifetime.signal)
    } catch (error: unknown) {
      if (this.lifetime.signal.aborted) throw new WorkstreamError('Workstream service has stopped', 'WORKSTREAM_DISPOSED', { cause: error })
      throw new WorkstreamError(`Member ${id} could not be resumed to take the coordinator role; send it a message with `
        + 'workstream_send and retry the handoff while it runs', 'WORKSTREAM_INVALID_INPUT', { cause: error })
    }
  }
  private child(snapshot: WorkstreamSnapshot, id: SessionId): WorkstreamMember {
    const member = this.target(snapshot, id)
    if (id === snapshot.ownerSessionId) throw new WorkstreamError('Select a child member', 'WORKSTREAM_INVALID_INPUT')
    return member
  }
  private text(value: string, name: string): void {
    if (value.trim().length === 0) throw new WorkstreamError(`${name} must not be empty`, 'WORKSTREAM_INVALID_INPUT')
  }
  private state(owner: Agent): WorkstreamSnapshot {
    const state = this.projection.stateOf(owner.session).snapshot
    if (state === null) throw new WorkstreamError('Workstream is absent', 'WORKSTREAM_NOT_FOUND')
    return state
  }
  private fit(snapshot: WorkstreamSnapshot): void {
    if (bytes(snapshot) > this.config.maxSnapshotBytes) throw new
    WorkstreamError('Complete Workstream state exceeds maxSnapshotBytes', 'WORKSTREAM_LIMIT')
  }
  /** Synchronously make a snapshot the live projection state; durability is a separate `flush`. */
  private append(owner: Agent, snapshot: WorkstreamSnapshot): void {
    this.fit(snapshot)
    owner.session.append('workstream/state', { version: 1, snapshot: structuredClone(snapshot) })
  }
  private async commit(owner: Agent, snapshot: WorkstreamSnapshot): Promise<WorkstreamSnapshot> {
    this.append(owner, snapshot)
    await this.ctx.sessions.flush(owner.session)
    return structuredClone(snapshot)
  }
  /** An idempotent success must not outrun durability: an earlier attempt may have appended `value` and failed its flush.
   * Flushing the owning Session again retries that write and propagates a continuing storage failure. */
  private async durable<T>(owner: Agent, value: T): Promise<T> {
    await this.ctx.sessions.flush(owner.session)
    return value
  }
  private async saveMember(owner: Agent, snapshot: WorkstreamSnapshot, member: WorkstreamMember): Promise<WorkstreamMember> {
    await this.commit(owner, { ...snapshot, revision: snapshot.revision + 1, members: snapshot.members.map(candidate =>
      candidate.id === member.id ? member : candidate) })
    return structuredClone(member)
  }
  private async saveMessage(owner: Agent, snapshot: WorkstreamSnapshot, message: WorkstreamMessage): Promise<WorkstreamMessage> {
    await this.commit(owner, { ...snapshot, revision: snapshot.revision + 1, messages: snapshot.messages.map(candidate =>
      candidate.operationId === message.operationId ? message : candidate) })
    return structuredClone(message)
  }
  private async readChild(id: SessionId, signal: AbortSignal): Promise<{ parent: SessionId | undefined; events: readonly SessionEvent[] }> {
    const session = this.ctx.sessions.get(id)
    if (session !== undefined) await this.ctx.sessions.flush(session)
    const handle = await this.ctx.sessionPersistence.open(id, 'read', { signal })
    try {
      const { events } = await handle.read(0, undefined, { signal })
      return { parent: handle.header.parentSession, events: events.slice(handle.inheritedEventCount) }
    } finally { await handle.close() }
  }
  /** Tell a resumed owner which active members are not running although their last turn did not finish.
   *
   * Durable `active` membership and a `running` Ticket assignment survive a shutdown that aborted the member's turn, and
   * nothing resumes the member. The notice is injected without waking the owner; it repeats at each owner resume while the
   * member's last turn stays unfinished. A member whose log cannot be read is reported as uninspected, never a resume failure. */
  private async reportUnfinishedMembers(owner: Agent, factorySignal: AbortSignal | undefined): Promise<void> {
    const snapshot = this.projection.stateOf(owner.session).snapshot
    if (snapshot === null || snapshot.ownerSessionId !== owner.id) return
    const members = snapshot.members.filter(member => member.role === 'member' && member.phase === 'active'
      && this.ctx.agents.get(member.id) === undefined)
    if (members.length === 0) return
    const signal = factorySignal === undefined ? this.lifetime.signal : AbortSignal.any([factorySignal, this.lifetime.signal])
    const found = await Promise.all(members.map(async (member) => {
      try {
        const turn = unfinishedTurn((await this.readChild(member.id, signal)).events)
        return turn === undefined ? undefined : `${member.name} (${member.id}, turn ${String(turn)})`
      } catch (error: unknown) {
        this.ctx.logger.warn(`workstream member ${member.id} log could not be read on owner resume: ${String(error)}`)
        return `${member.name} (${member.id}, log unreadable)`
      }
    }))
    // A cancelled resume or a stopping service has no owner turn left to inform.
    if (signal.aborted) return
    const lines = found.filter(line => line !== undefined)
    if (lines.length === 0) return
    const text = `These Workstream ${owner.id} members are not running and their last turn did not finish, so their `
      + `Ticket assignments may still read running: ${lines.join('; ')}. Send each a message with workstream_send to `
      + 'continue its work, or stop it with workstream_stop.'
    owner.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'workstream-notice', rootSessionId:
      owner.id, form: 'notice', summary: boundContextSummary(`Workstream members interrupted: ${String(lines.length)}`) } }))
  }
  private async reconcileMember(owner: Agent, snapshot: WorkstreamSnapshot, member: WorkstreamMember, signal: AbortSignal,
    messageId?: MessageId): Promise<WorkstreamMember> {
    let accepted = false
    try {
      const loaded = await this.readChild(member.id, signal)
      const descriptor = foldSubagentDescriptor(loaded.events)
      accepted = loaded.parent === owner.id && descriptor?.mode === 'continuable' && descriptor.provider === member.provider
        && acceptedMessage(loaded.events, message => messageId === undefined ? message.source.kind === 'user' : message.id
          === messageId) !== undefined
    } catch (error: unknown) {
      throw new WorkstreamError(`Child ${member.id} has no confirmed durable acceptance; inspect its Session before taking further action`, 'WORKSTREAM_UNKNOWN', { cause: error })
    }
    if (!accepted) throw new WorkstreamError(`Child ${member.id} provisioning remains unknown; no duplicate launch was attempted`, 'WORKSTREAM_UNKNOWN')
    return this.saveMember(owner, snapshot, { ...member, phase: 'active', diagnostic: null })
  }
  private async reconcileMessage(owner: Agent, snapshot: WorkstreamSnapshot, message: WorkstreamMessage, signal:
  AbortSignal): Promise<WorkstreamMessage> {
    let id: MessageId | undefined
    try {
      const loaded = await this.readChild(message.targetId, signal)
      id = acceptedMessage(loaded.events, candidate => candidate.source.kind === 'workstream-message'
        && candidate.source.rootSessionId === owner.id && candidate.source.operationId === message.operationId
        && candidate.source.senderSessionId === message.senderId)
    } catch (error: unknown) {
      throw new WorkstreamError('Recipient evidence is unavailable; delivery remains unknown', 'WORKSTREAM_UNKNOWN', { cause: error })
    }
    if (id === undefined) throw new WorkstreamError('Inbox acceptance is unknown; no duplicate delivery was attempted',
      'WORKSTREAM_UNKNOWN')
    return this.saveMessage(owner, snapshot, { ...message, diagnostic: null, delivery: { phase: 'accepted', messageId: id } })
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.detached.add(work)
    const release = (): void => { this.detached.delete(work) }
    void work.then(release, release)
    return work
  }
  private enqueue<T>(root: SessionId, action: () => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(new WorkstreamError('Workstream service has stopped', 'WORKSTREAM_DISPOSED'))
    const prior = this.tails.get(root) ?? Promise.resolve()
    const run = prior.then(action)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(root, tail); this.pending.add(run)
    void tail.then(() => { this.pending.delete(run); if (this.tails.get(root) === tail) this.tails.delete(root) })
    return run
  }
  /** Unload in an explicit, awaited order rather than sibling-effect order.
   *
   * Ticket binds each queued command to the authorities registered when it was admitted, so withdrawing the registrations
   * first ends Workstream governance only for Ticket commands admitted afterwards. Those admitted earlier still run
   * Workstream's rules, and shutdown awaits them before it drains the members those rules read. */
  private async shutdown(): Promise<void> {
    // Workstream methods refuse from here on.
    this.lifetime.abort(new WorkstreamError('Workstream service is stopping', 'WORKSTREAM_DISPOSED'))
    await Promise.allSettled(this.withdrawals.splice(0).map(async (withdraw) => { await withdraw() }))
    await Promise.allSettled([...this.pending])
    // Ticket commands already admitted for a Workstream root commit or fail while their members are still live.
    await Promise.allSettled(this.ctx.sessions.list().filter(session => this.projection.stateOf(session).snapshot !== null)
      .map(session => this.ctx.tickets.whenIdle(session)))
    const results = await Promise.allSettled(this.ctx.agents.list().map(async (owner) => {
      const snapshot = this.projection.stateOf(owner.session).snapshot
      if (snapshot !== null) await this.ctx.subagents.drainChildren(owner, snapshot.members.filter(member => member.role ===
        'member').map(member => member.id))
    }))
    const failures = results.filter(result => result.status === 'rejected').map((result) => { const reason: unknown =
      result.reason; return reason })
    // Deliveries and drains outside the queue end once the members are drained and the queue rejects new work.
    await Promise.allSettled([...this.detached])
    if (failures.length > 0) throw new AggregateError(failures, 'Workstream child settlement failed')
  }
}
export default WorkstreamService
