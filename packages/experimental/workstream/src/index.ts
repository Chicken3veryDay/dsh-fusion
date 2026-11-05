/** Durable Workstreams keep technical ownership separate from coordinator authority. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { AssignTicketRequest, CreateTicketRequest, EndTicketRequest, TicketId, TicketView } from '@deepseek-ai/dsh-experimental-ticket'
import { WorkstreamError, WorkstreamPartialHandoffError } from './error.ts'
import { workstreamProjectionDefinition } from './projection.ts'
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

/** Durable message evidence includes admitted history and the surviving pending inbox. */
function acceptedMessage(events: readonly SessionEvent[], predicate: (message: UserMessage) => boolean): MessageId | undefined {
  const pending: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type === 'user/message' && predicate(event.data)) return event.data.id
    if (event.type === 'agent/inbox/spliced') {
      pending[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
    }
  }
  return [...pending['next-turn'], ...pending['next-step']].find(predicate)?.id
}

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
  private readonly tails = new Map<SessionId, Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workstreams')
    this.config = { ...defaults, ...config }
    for (const [key, value] of Object.entries(this.config)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new WorkstreamError(`${key} must be a positive safe integer`,
        'WORKSTREAM_INVALID_INPUT')
    }
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(workstreamProjectionDefinition)
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
        return structuredClone(prior)
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
    return [this.get(caller, rootId)]
  }

  /** Provision or reconcile one continuable direct child under a stable operation id.
   * @param caller - owner or current coordinator.
   * @param rootSessionId - stable technical owner.
   * @param request - immutable intent and cancellation before acceptance.
   * @returns active member; unresolved prior effects throw WORKSTREAM_UNKNOWN without another launch.
   */
  async addMember(caller: Agent, rootSessionId: SessionId, request: AddWorkstreamMemberRequest): Promise<WorkstreamMember> {
    return this.enqueue(rootSessionId, async () => {
      const { owner, snapshot } = this.coordinator(caller, rootSessionId)
      request.signal.throwIfAborted()
      const prior = snapshot.members.find(member => member.operationId === request.operationId)
      if (prior !== undefined) {
        if (prior.name !== request.name || prior.provider !== request.provider || prior.prompt !== request.prompt ||
          prior.description !== request.description) throw new WorkstreamError('Member operation id was reused with different input',
          'WORKSTREAM_CONFLICT')
        if (prior.phase === 'active') return prior
        if (prior.phase !== 'provisioning') throw new
        WorkstreamError('Member is stopped or stopping; use a new operation id and name', 'WORKSTREAM_CONFLICT')
        return this.reconcileMember(owner, snapshot, prior, request.signal)
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
        return await this.reconcileMember(owner, this.state(owner), member, request.signal, started.messageId)
      } catch (error: unknown) {
        await this.ctx.subagents.drainChildren(owner, [member.id])
        throw new WorkstreamError(`Member provisioning remains uncertain; inspect ${member.id} and retry the same operation`,
          'WORKSTREAM_UNKNOWN', { cause: error })
      }
    })
  }

  /** Transfer the coordinator role to a member, moving Ticket coordination with it, while preserving every child parent and root log.
   *
   * Tickets move first and the Workstream snapshot commits last, so the Workstream coordinator never names a member the
   * Tickets have not yet followed. Each move is authenticated by the Ticket's own current coordinator, which the Workstream
   * has already verified as a member; the technical owner may force the handoff but the Ticket then records the previous
   * coordinator as the handing-off actor.
   * @param caller - current coordinator or immutable owner.
   * @param rootSessionId - explicit technical owner.
   * @param request - CAS revision and active new coordinator.
   * @returns committed next snapshot.
   * @throws WorkstreamPartialHandoffError when some Tickets could not move; the coordinator is unchanged and the same call may be retried.
   */
  async handoff(caller: Agent, rootSessionId: SessionId, request: { expectedRevision: number; coordinatorId: SessionId }):
  Promise<WorkstreamSnapshot> {
    return this.enqueue(rootSessionId, async () => {
      const { owner, snapshot } = this.coordinator(caller, rootSessionId)
      if (snapshot.revision !== request.expectedRevision) throw new
      WorkstreamError('Workstream changed; refresh before handoff', 'WORKSTREAM_CONFLICT')
      this.target(snapshot, request.coordinatorId)
      await this.moveTickets(owner, snapshot, request.coordinatorId)
      return this.commit(owner, { ...snapshot, revision: snapshot.revision + 1, coordinatorId: request.coordinatorId })
    })
  }

  /** Deliver one immutable message intent with durable acceptance distinct from processing.
   * @param caller - exact live sending member.
   * @param rootSessionId - explicit root selecting recipient membership.
   * @param request - stable operation id, target, message and optional logged context packet.
   * @returns current durable delivery receipt; unresolved retries never send again.
   */
  async sendMessage(caller: Agent, rootSessionId: SessionId, request: SendWorkstreamMessageRequest): Promise<WorkstreamMessage> {
    return this.enqueue(rootSessionId, async () => {
      const { owner, snapshot } = this.requireMembership(caller, rootSessionId)
      request.signal.throwIfAborted()
      this.target(snapshot, request.targetId)
      if (request.targetId === caller.id) throw new WorkstreamError('Choose another Workstream member', 'WORKSTREAM_INVALID_INPUT')
      const prior = snapshot.messages.find(message => message.operationId === request.operationId)
      if (prior !== undefined) {
        if (prior.senderId !== caller.id || prior.targetId !== request.targetId || prior.text !== request.text ||
          JSON.stringify(prior.context) !== JSON.stringify(request.context ?? null)) throw new
        WorkstreamError('Message operation id was reused with different input', 'WORKSTREAM_CONFLICT')
        if (prior.delivery.phase !== 'intent') return prior
        return this.reconcileMessage(owner, snapshot, prior, request.signal)
      }
      this.text(request.text, 'text')
      if (snapshot.messages.length >= this.config.maxMessages) throw new WorkstreamError('Workstream message limit reached',
        'WORKSTREAM_LIMIT')
      const message: WorkstreamMessage = { operationId: request.operationId, senderId: caller.id, targetId: request.targetId,
        text: request.text, context: request.context ?? null, diagnostic:
        'Inbox acceptance is not yet confirmed; retry the same operation to reconcile', delivery: { phase: 'intent' } }
      if (bytes(message) > this.config.maxMessageBytes) throw new
      WorkstreamError('Complete Workstream message exceeds maxMessageBytes', 'WORKSTREAM_LIMIT')
      await this.commit(owner, { ...snapshot, revision: snapshot.revision + 1, messages: [...snapshot.messages, message] })
      const source = { kind: 'workstream-message' as const, rootSessionId, operationId: request.operationId, senderSessionId: caller.id }
      const content = [{ type: 'text' as const, text: JSON.stringify({ sender: caller.id, text: message.text, context: message.context }) }]
      try {
        if (request.targetId === owner.id) owner.steer(createUserMessage({ content, source }))
        else await steerHostSubagentPrompt(this.ctx.subagents, owner, request.targetId, content, source,
          AbortSignal.any([request.signal, this.lifetime.signal]))
        return await this.reconcileMessage(owner, this.state(owner), message, request.signal)
      } catch (error: unknown) {
        throw new WorkstreamError('Message delivery remains uncertain; retry the same operation to inspect inbox evidence',
          'WORKSTREAM_UNKNOWN', { cause: error })
      }
    })
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
      if (message.delivery.phase === 'processed') return message
      return this.saveMessage(owner, snapshot, { ...message, delivery: { ...message.delivery, phase: 'processed' } })
    })
  }

  /** Observe any durable root event, including Ticket progress, without polling.
   * @param caller - exact live member.
   * @param rootSessionId - explicit Workstream root.
   * @param request - last Workstream revision, finite timeout, and caller cancellation.
   * @returns a revision change, another durable event, or timeout; abort and shutdown reject.
   */
  async waitForChange(
    caller: Agent, rootSessionId: SessionId,
    request: { afterRevision: number; timeoutMs: number; signal: AbortSignal },
  ): Promise<WorkstreamWaitResult> {
    const { owner, snapshot } = this.requireMembership(caller, rootSessionId)
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > this.config.maxWaitMs)
      throw new WorkstreamError('timeoutMs must be positive and at most maxWaitMs', 'WORKSTREAM_INVALID_INPUT')
    if (snapshot.revision !== request.afterRevision) return { timedOut: false, revision: snapshot.revision }
    const signal = AbortSignal.any([request.signal, this.lifetime.signal])
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); stop(); signal.removeEventListener('abort', abort) }
      const abort = (): void => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new
      WorkstreamError('Workstream wait was cancelled', 'WORKSTREAM_DISPOSED')) }
      const stop = this.ctx.on('session/event', (session) => {
        if (session !== owner.session) return
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
    return this.enqueue(rootSessionId, async () => {
      const { owner, snapshot } = this.coordinator(caller, rootSessionId)
      const member = snapshot.members.find(candidate => candidate.id === targetId)
      if (member === undefined || targetId === owner.id || targetId === snapshot.coordinatorId) throw new
      WorkstreamError('Select a child other than the coordinator', 'WORKSTREAM_INVALID_INPUT')
      if (member.phase === 'stopped') return member
      await this.saveMember(owner, snapshot, { ...member, phase: 'stopping' })
      await this.ctx.subagents.drainChildren(owner, [targetId])
      return this.saveMember(owner, this.state(owner), { ...member, phase: 'stopped', diagnostic: null })
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
      return this.ctx.tickets.create(owner.session, { ...request, coordinatorId: snapshot.coordinatorId })
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
      return this.ctx.tickets.assign(owner.session, { ...request, actorId: caller.id })
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
      return this.ctx.tickets.complete(owner.session, { ...request, actorId: caller.id })
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
  /** Hand every open Ticket coordinated by a Workstream member to the target; unmoved Tickets are reported, never skipped. */
  private async moveTickets(owner: Agent, snapshot: WorkstreamSnapshot, coordinatorId: SessionId): Promise<void> {
    const moved: TicketId[] = []
    const pending: TicketId[] = []
    let cause: unknown
    for (const ticket of this.ctx.tickets.list(owner.session)) {
      if (ticket.terminalOutcome !== undefined || ticket.coordinatorId === coordinatorId
        || !snapshot.members.some(member => member.id === ticket.coordinatorId)) continue
      try {
        await this.ctx.tickets.handoff(owner.session, { ticketId: ticket.id, expectedRevision: ticket.revision,
          actorId: ticket.coordinatorId, newCoordinatorId: coordinatorId })
        moved.push(ticket.id)
      } catch (error: unknown) { pending.push(ticket.id); cause ??= error }
    }
    if (pending.length > 0) throw new WorkstreamPartialHandoffError(moved, pending, { cause })
  }
  private target(snapshot: WorkstreamSnapshot, id: SessionId): WorkstreamMember {
    const member = snapshot.members.find(candidate => candidate.id === id && candidate.phase === 'active')
    if (member === undefined) throw new WorkstreamError('Target is not an active Workstream member', 'WORKSTREAM_INVALID_INPUT')
    return member
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
  private async commit(owner: Agent, snapshot: WorkstreamSnapshot): Promise<WorkstreamSnapshot> {
    if (bytes(snapshot) > this.config.maxSnapshotBytes) throw new
    WorkstreamError('Complete Workstream state exceeds maxSnapshotBytes', 'WORKSTREAM_LIMIT')
    owner.session.append('workstream/state', { version: 1, snapshot: structuredClone(snapshot) })
    await this.ctx.sessions.flush(owner.session)
    return structuredClone(snapshot)
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
  private enqueue<T>(root: SessionId, action: () => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(new WorkstreamError('Workstream service has stopped', 'WORKSTREAM_DISPOSED'))
    const prior = this.tails.get(root) ?? Promise.resolve()
    const run = prior.then(action)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(root, tail); this.pending.add(run)
    void tail.then(() => { this.pending.delete(run); if (this.tails.get(root) === tail) this.tails.delete(root) })
    return run
  }
  private async shutdown(): Promise<void> {
    this.lifetime.abort(new WorkstreamError('Workstream service is stopping', 'WORKSTREAM_DISPOSED'))
    await Promise.allSettled([...this.pending])
    const results = await Promise.allSettled(this.ctx.agents.list().map(async (owner) => {
      const snapshot = this.projection.stateOf(owner.session).snapshot
      if (snapshot !== null) await this.ctx.subagents.drainChildren(owner, snapshot.members.filter(member => member.role ===
        'member').map(member => member.id))
    }))
    const failures = results.filter(result => result.status === 'rejected').map((result) => { const reason: unknown =
      result.reason; return reason })
    if (failures.length > 0) throw new AggregateError(failures, 'Workstream child settlement failed')
  }
}
export default WorkstreamService
