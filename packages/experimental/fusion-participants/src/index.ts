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
import { rosterProjection } from './state.ts'
import type { RosterState } from './state.ts'

export type { Roster } from './roster.ts'

/** Capability returned only after all required leases, routes and barriers succeed. */
export interface PreparedParticipants {
  /** Immutable root roster; IDs and routes survive Agent detachment and process restart. */
  readonly roster: Roster
  /** Publish one parked participant by its roster role; no input is claimed. */
  adopt(role: string): Promise<AgentHandle>
  /** Cancel preparation/adoption, await cleanup, remove live routing and close retained writers. */
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
  static inject = ['agents', 'sessionPersistence', 'sessionProjections', 'fusionConfig', 'agentPresets']
  private readonly abort = new AbortController()
  private readonly pending = new Set<Promise<PreparedParticipants>>()
  private readonly owned = new Set<PreparedParticipants>()
  private projection!: ProjectionHandle<RosterState>

  constructor(ctx: Context) { super(ctx, 'fusionParticipants') }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register<'fusionRoster', RosterState>(rosterProjection)
    this.ctx.effect(() => async () => {
      this.abort.abort(new Error('participant owner disposed'))
      await Promise.allSettled([...this.pending])
      const results = await Promise.allSettled([...this.owned].map(task => task.dispose()))
      const errors: unknown[] = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'participant owner cleanup failed')
    }, 'fusion-participants.tasks')
  }

  /**
   * Capture one exact selection and prepare inert durable participant contexts.
   * @param selectionId - named immutable fusion-config selection.
   * @param signal - optional cancellation; owner disposal always cancels preparation.
   * @returns prepared capability only after every writer passes its own durability barrier.
   */
  prepare(selectionId: string, signal?: AbortSignal): Promise<PreparedParticipants> {
    return this.track((async () => {
      const selection = this.ctx.fusionConfig.selection(selectionId)
      const document = await this.ctx.agentPresets.readDocument(selection.agentPreset)
      const compositionDigest = createHash('sha256').update(document.content).digest('hex')
      return this.acquire({ kind: 'create', roster: captureRoster(selection, compositionDigest) }, signal)
    })())
  }

  /**
   * Recover the root and persisted participants under root-first leases.
   * @param rootSessionId - persisted root identity; absence/corruption is a blocking failure.
   * @param signal - optional cancellation; omission keeps owner disposal cancellation.
   * @returns a prepared capability using the original roster and context lineages.
   */
  recover(rootSessionId: SessionId, signal?: AbortSignal): Promise<PreparedParticipants> {
    return this.track(this.acquire({ kind: 'resume', rootSessionId }, signal))
  }

  private track(operation: Promise<PreparedParticipants>): Promise<PreparedParticipants> {
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }

  private async barrier(session: Session): Promise<void> {
    const result = await this.ctx.sessionPersistence.flushSessionDurably(session)
    if (result.kind !== 'durable') throw new Error(`participant durability refused: ${result.reason}`)
  }

  private async acquire(
    request: { kind: 'create'; roster: Roster } | { kind: 'resume'; rootSessionId: SessionId },
    caller?: AbortSignal,
  ): Promise<PreparedParticipants> {
    const rootSessionId = request.kind === 'create' ? request.roster.rootSessionId : request.rootSessionId
    const signal = AbortSignal.any([this.abort.signal, ...caller === undefined ? [] : [caller]])
    const leases: RetainedAgentSession[] = []
    const participants = new Map<SessionId, RetainedAgentSession>()
    let composition: Scope | undefined
    let disposal: Promise<void> | undefined
    let prepared: PreparedParticipants | undefined
    const dispose = (): Promise<void> => disposal ??= (async () => {
      const errors: unknown[] = []
      for (const lease of [...leases].reverse()) {
        try { await lease.dispose() } catch (error: unknown) { errors.push(error) }
      }
      try { await composition?.dispose() } catch (error: unknown) { errors.push(error) }
      if (prepared !== undefined) this.owned.delete(prepared)
      if (errors.length > 0) throw new AggregateError(errors, 'participant task cleanup failed')
    })()
    try {
      signal.throwIfAborted()
      const root = await this.ctx.agents.retain({ sessionId: rootSessionId, mode: request.kind, agentOptions: {}, signal })
      leases.push(root)
      signal.throwIfAborted()
      if (request.kind === 'create') {
        root.session.append('fusion/roster', request.roster)
        await this.barrier(root.session)
      }
      const state = this.projection.stateOf(root.session)
      const roster = state.roster
      if (roster === null || roster.rootSessionId !== rootSessionId) throw new Error('missing or mismatched root roster')
      const key = {}
      composition = createScope(this.ctx, key)
      await this.ctx.agentPresets.mount(composition.ctx, roster.agentPreset)
      const document = await this.ctx.agentPresets.readDocument(roster.agentPreset)
      const witnessKey = {}
      const witness = createScope(this.ctx, witnessKey)
      try {
        await this.ctx.agentPresets.mount(witness.ctx, roster.agentPreset)
        // Replaced generations cannot be resurrected. Equal parents bracket the document read.
        if (scopeParentOf(key) !== scopeParentOf(witnessKey)
          || createHash('sha256').update(document.content).digest('hex') !== roster.compositionDigest) {
          throw new Error('participant composition changed')
        }
      } finally { await witness.dispose() }
      const pinned = composition
      for (const participant of roster.participants) {
        signal.throwIfAborted()
        const existing = await this.ctx.sessionPersistence.stat(participant.id, { signal })
        if (existing === undefined && state.established.includes(participant.id)) throw new Error('established participant is absent')
        const lease = await this.ctx.agents.retain({
          sessionId: participant.id, root, mode: existing === undefined ? 'create' : 'resume', signal,
          agentOptions: {
            provider: participant.binding.providerId, model: participant.binding.wireModelId,
            reasoningEffort: ReasoningEffortId(participant.binding.effort),
          },
          setup: (ctx) => { this.ctx.agentPresets.composeFrom(ctx, pinned.ctx) },
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
      prepared = Object.freeze({
        roster: deepFreeze(roster),
        adopt: async (role: string): Promise<AgentHandle> => {
          signal.throwIfAborted()
          const id = roster.roles[role]
          const lease = id === undefined ? undefined : participants.get(id)
          if (disposal !== undefined || lease === undefined) throw new Error('participant is not owned by this prepared task')
          return lease.adopt()
        },
        dispose,
      })
      this.owned.add(prepared)
      return prepared
    } catch (error: unknown) {
      try { await dispose() } catch (cleanup: unknown) { throw new ParticipantPreparationError(rootSessionId, 'unknown', new AggregateError([error, cleanup], 'participant preparation and cleanup failed')) }
      throw new ParticipantPreparationError(rootSessionId, 'complete', error)
    }
  }
}
