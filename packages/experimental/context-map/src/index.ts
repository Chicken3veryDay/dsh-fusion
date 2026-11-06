/**
 * Experimental project map: a durable, citation-checked grouping of context sections and tools
 * that only the curator role holder edits.
 *
 * `ctx.contextMap` keeps the map in a Session projection with compare-and-set revisions, shows
 * the context tree the curator's groups and eager core, and records the short notes the working
 * agent files through `context_note` for the curator to verify and file later. The curator is a
 * role: a durable grant to one agent id, checked against the exact live caller. Map building,
 * regrouping, and note verification therefore never run in the working agent's context.
 *
 * @module @deepseek-ai/dsh-experimental-context-map
 */
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { ContextSectionId } from '@deepseek-ai/dsh-experimental-context-index/types'
import type { CuratedGroup } from '@deepseek-ai/dsh-experimental-context-tree/types'
import '@deepseek-ai/dsh-experimental-context-index'
import '@deepseek-ai/dsh-experimental-context-tree'
import type {} from '@deepseek-ai/dsh-working-directory'
import { ConfigSchema, resolveConfig, type ResolvedConfig } from './config.ts'
import {
  buildGroup,
  digestOf,
  isStale,
  knownSection,
  noteText,
  parseCites,
  parseGroupPath,
  restamp,
  type IndexFacts,
} from './edits.ts'
import { ContextMapError } from './error.ts'
import { contextMapProjectionDefinition, type ContextMapProjectionState } from './projection.ts'
import { byteLength } from './text.ts'
import type {
  Config,
  MapChange,
  MapGroup,
  MapGroupId,
  MapGroupRequest,
  MapCite,
  MapGroupView,
  MapNote,
  MapNoteId,
  MapOp,
  MapOpKind,
  MapPendingId,
  MapRoute,
  MapSnapshot,
  MapView,
} from './types.ts'

export { ContextMapError } from './error.ts'
export type { ContextMapErrorCode } from './error.ts'
export { ContextMapTools } from './tools.ts'
export { DefaultContextCurator } from './curator.ts'
export { selectCuratorRoute } from './route.ts'
export type { CuratorRouteChoice } from './route.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextMap: ContextMapService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete project map after one admitted edit, with the edit that produced it. */
    'context-map/state': { readonly version: 1; readonly op: MapOp; readonly snapshot: MapSnapshot }
  }
}

/** Tools only the curator role holder sees and may run. */
export const CURATOR_TOOL_NAMES: readonly string[] = ['map_view', 'map_group', 'map_note', 'map_core']

/** Target of a map operation that needs no CAS. */
export interface MapTarget {
  /** Root Session that owns the map; omitted means the caller's own root. */
  readonly rootSessionId?: SessionId
}

/** Target and revision of a curator edit. */
export interface CurateRequest extends MapTarget {
  /** Revision the curator read; a different current revision rejects the edit. */
  readonly expectedRevision: number
}

/** Replace or create one group. */
export interface SetGroupRequest extends CurateRequest { readonly group: MapGroupRequest }
/** Fold one group into another. */
export interface MergeGroupsRequest extends CurateRequest { readonly from: MapGroupId; readonly into: MapGroupId }
/** Remove one group and its notes. */
export interface RetireGroupRequest extends CurateRequest { readonly groupId: MapGroupId }
/** File a cited note under a group. */
export interface AddNoteRequest extends CurateRequest {
  readonly groupId: MapGroupId
  readonly text: string
  readonly cites: readonly string[]
}
/** Refresh a note's citations, optionally correcting its text. */
export interface VerifyNoteRequest extends CurateRequest { readonly noteId: MapNoteId; readonly text?: string }
/** Remove one filed note. */
export interface RetireNoteRequest extends CurateRequest { readonly noteId: MapNoteId }
/** Move a pending note under a group. */
export interface FilePendingRequest extends CurateRequest {
  readonly pendingId: MapPendingId
  readonly groupId: MapGroupId
  readonly text?: string
  readonly cites?: readonly string[]
}
/** Discard one pending note. */
export interface DropPendingRequest extends CurateRequest { readonly pendingId: MapPendingId }
/** Choose the eager core. */
export interface SetCoreRequest extends CurateRequest { readonly sections: readonly string[] }

/** A note the working agent records for the curator. */
export interface NoteRequest extends MapTarget {
  readonly text: string
  /** Section ids or `ref:` evidence; may be empty. */
  readonly cites?: readonly string[]
}

/** Curation work waiting for a curator. */
export interface CurationWork {
  /** What is waiting: an unprocessed index, pending notes, stale notes, or a note refused for lack of room. */
  readonly reasons: readonly ('index' | 'pending' | 'stale' | 'space')[]
  /** Fingerprint of the waiting work; it changes when the work does. */
  readonly signature: string
  /** Claims already logged for this exact work, including those before a restart. */
  readonly attempts: number
}

/** Request to take or hand over the curator role. */
export interface ClaimRequest extends MapTarget {
  /** Agent that becomes the holder; defaults to the caller, and only the map owner may name another agent. */
  readonly holderId?: SessionId
  /** Route a default curator run uses; recorded in the claim. */
  readonly route?: MapRoute
  /** Signature of the {@link CurationWork} this claim serves; logged so retries of the same work can be counted. */
  readonly work?: string
}

const groupIdOf = (): MapGroupId => brandString<MapGroupId>(`grp_${randomUUID().slice(0, 8)}`)
const noteIdOf = (): MapNoteId => brandString<MapNoteId>(`note_${randomUUID().slice(0, 8)}`)
const pendingIdOf = (): MapPendingId => brandString<MapPendingId>(`pnd_${randomUUID().slice(0, 8)}`)

function emptySnapshot(ownerSessionId: SessionId): MapSnapshot {
  return { ownerSessionId, revision: 0, curatorId: null, route: null, indexDigest: null, core: [], groups: [], pending: [] }
}

/** Service that keeps the project map and enforces the curator role. */
export class ContextMapService extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections', 'contextIndex', 'contextTree', 'workingDirectory']
  static Config: z<Config> = ConfigSchema

  private readonly config: ResolvedConfig
  private projection!: ProjectionHandle<ContextMapProjectionState>
  private readonly watchers = new Set<(change: MapChange) => void>()
  /** Section hashes the index had at each owner's last read, for the stale flag the tree shows. */
  private readonly hashes = new Map<SessionId, ReadonlyMap<ContextSectionId, string>>()
  private readonly announced = new Map<SessionId, string>()
  /** Notes refused for lack of room per owner, and how many of them a finished role hold had seen. */
  private readonly spaceRefusals = new Map<SessionId, number>()
  private readonly spaceSeen = new Map<SessionId, number>()
  private readonly spaceAtClaim = new Map<SessionId, number>()
  private readonly heldOwners = new Map<SessionId, Set<SessionId>>()
  private disposed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'contextMap')
    this.config = resolveConfig(config)
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(contextMapProjectionDefinition)
    this.ctx.effect(() => () => {
      this.disposed = true
      this.watchers.clear()
    }, 'contextMap.runtime()')
    for (const agent of this.ctx.agents.list()) this.indexHolder(agent)
    this.ctx.on('agent/created', ({ agent }) => { this.indexHolder(agent) })
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'context-map/state' || event.data.snapshot.ownerSessionId !== session.id) return
      const owner = this.ctx.agents.get(session.id)
      if (owner !== undefined) this.indexHolder(owner)
    })
    this.ctx.contextTree.registerCuratedGroups(agent => this.groupsFor(agent))
    this.ctx.contextTree.registerEagerCore(agent => this.snapshotOfRoot(agent).core)
    this.ctx.contextTree.registerManagedTools(CURATOR_TOOL_NAMES, agent => this.curatedRoots(agent).length > 0)
    this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || agent.session.header.parentSession !== undefined) return decision
      try {
        await this.observe(agent, signal)
      } catch (error: unknown) {
        signal.throwIfAborted()
        this.ctx.logger.warn(`context map: index observation failed: ${String(error)}`)
      }
      return decision
    })
    this.ctx.on('agent/disposed', ({ agent }) => {
      const owners = [...this.heldOwners.get(agent.id) ?? []]
      for (const held of this.heldOwners.values()) held.delete(agent.id)
      this.heldOwners.delete(agent.id)
      for (const ownerId of owners) {
        this.notify({ kind: 'holder-gone', ownerSessionId: ownerId, holderId: agent.id })
        void this.releaseGone(ownerId, agent.id).catch((error: unknown) => {
          this.ctx.logger.warn(`context map: could not log the end of curator ${agent.id}: ${String(error)}`)
        })
      }
    })
  }

  /**
   * Be told when a map is committed, its index moves on, a note is filed, or a holder disappears.
   * @param listener - called synchronously after the change is visible; must not throw.
   * @returns the disposer.
   */
  watch(listener: (change: MapChange) => void): () => void {
    this.watchers.add(listener)
    return () => { this.watchers.delete(listener) }
  }

  /**
   * Whether an agent holds the curator role of its map right now.
   * @param agent - the agent.
   * @param rootSessionId - optional map to check.
   * @returns true only for the live holder.
   */
  isCurator(agent: Agent, rootSessionId?: SessionId): boolean {
    if (this.disposed || this.ctx.agents.get(agent.id) !== agent) return false
    return this.heldOwners.get(agent.id)?.has(rootSessionId ?? this.rootOf(agent).id) === true
  }

  /**
   * Maps whose curator tools a live agent may use.
   * @param agent - the exact live agent.
   * @returns detached owner ids; empty for stale callers or an unloaded service.
   */
  curatedRoots(agent: Agent): readonly SessionId[] {
    if (this.disposed || this.ctx.agents.get(agent.id) !== agent) return []
    return [...this.heldOwners.get(agent.id) ?? []]
  }

  /**
   * The holder of an owner's curator role.
   * @param owner - the map owner.
   * @returns the holder id, or `null`; the holder may no longer be live.
   */
  curatorOf(owner: Agent): SessionId | null {
    return this.snapshotOf(owner).curatorId
  }

  /**
   * Whether the holder recorded for an owner is a live agent.
   * @param owner - the map owner.
   * @returns true when a live agent holds the role.
   */
  hasLiveCurator(owner: Agent): boolean {
    const id = this.snapshotOf(owner).curatorId
    return id !== null && this.ctx.agents.get(id) !== undefined
  }

  /**
   * Read the current snapshot of an owner's map.
   * @param owner - the map owner.
   * @returns a detached snapshot; revision 0 when nothing was committed.
   */
  snapshotOf(owner: Agent): MapSnapshot {
    return structuredClone(this.projection.stateOf(owner.session).snapshot ?? emptySnapshot(owner.id))
  }

  /**
   * Read a map as a member of its Session lineage: the owner, a direct child, or the holder.
   * @param caller - the exact live agent.
   * @param target - map and edit-stable cursors; groupId reads one group's notes without pending entries.
   * @param signal - cancellation.
   * @returns a view within `maxViewBytes`, with continuations and stale notes flagged.
   * @throws {@link ContextMapError} for an unauthorized caller, unknown group, or an item exceeding the view budget.
   */
  async view(caller: Agent, target: MapTarget & {
    readonly pendingAfter?: MapPendingId
    readonly groupAfter?: MapGroupId | ''
    readonly groupId?: MapGroupId
    readonly noteAfter?: MapNoteId | ''
  } = {}, signal?: AbortSignal): Promise<MapView> {
    if (target.noteAfter !== undefined && target.groupId === undefined) {
      throw new ContextMapError('noteAfter requires groupId', 'CONTEXT_MAP_INVALID_INPUT')
    }
    const owner = this.member(caller, target.rootSessionId)
    const facts = await this.facts(owner, signal)
    const snapshot = this.snapshotOf(owner)
    const pending = target.groupAfter !== undefined || target.groupId !== undefined ? []
      : snapshot.pending.filter(note => note.id > (target.pendingAfter ?? '')).toSorted((a, b) => a.id.localeCompare(b.id))
    const groups = target.groupId === undefined
      ? snapshot.groups.filter(group => group.id > (target.groupAfter ?? '')).toSorted((a, b) => a.id.localeCompare(b.id))
      : [this.group(snapshot, target.groupId)]
    let view = this.viewFrame(snapshot,
      snapshot.groups.reduce((sum, group) => sum + group.notes.filter(note => isStale(note.cites, facts)).length, 0),
      snapshot.indexDigest !== facts.digest, this.needsSpace(owner))
    view = { ...view, omittedPending: pending.length, omittedGroups: groups.length }
    const fits = (candidate: MapView): boolean => byteLength(JSON.stringify(candidate)) <= this.config.maxViewBytes
    if (!fits(view)) throw new ContextMapError('Map metadata exceeds maxViewBytes; increase the view budget', 'CONTEXT_MAP_LIMIT')
    for (const note of pending) {
      const omittedPending = view.omittedPending - 1
      const next = { ...view, pending: [...view.pending, note], omittedPending, nextPendingAfter: omittedPending > 0 ? note.id : null }
      if (!fits(next)) {
        if (view.pending.length === 0) throw new ContextMapError('One pending note exceeds maxViewBytes; increase the view budget', 'CONTEXT_MAP_LIMIT')
        break
      }
      view = next
    }
    for (const group of groups) {
      const notes = group.notes.filter(note => note.id > (target.noteAfter ?? '')).toSorted((a, b) => a.id.localeCompare(b.id))
      const header: MapGroupView = { ...group, notes: [], omittedNotes: notes.length, nextNoteAfter: notes.length > 0 ? target.noteAfter ?? '' : null }
      let next: MapView = { ...view, groups: [...view.groups, header], omittedGroups: view.omittedGroups - 1,
        nextGroupAfter: view.omittedGroups > 1 ? group.id : null }
      if (!fits(next)) break
      let detail = header
      for (const note of notes) {
        const omittedNotes = detail.omittedNotes - 1
        const candidate = { ...detail, notes: [...detail.notes, { ...note, stale: isStale(note.cites, facts) }],
          omittedNotes, nextNoteAfter: omittedNotes > 0 ? note.id : null }
        const page = { ...next, groups: [...view.groups, candidate] }
        if (!fits(page)) break
        detail = candidate
        next = page
      }
      if (target.groupId !== undefined && notes.length > 0 && detail.notes.length === 0) {
        throw new ContextMapError('One group note exceeds maxViewBytes; increase the view budget', 'CONTEXT_MAP_LIMIT')
      }
      view = next
    }
    if (view.omittedGroups > 0 && view.nextGroupAfter === null) view = { ...view, nextGroupAfter: target.groupAfter ?? '' }
    if (target.groupAfter !== undefined && groups.length > 0 && view.groups.length === 0) {
      throw new ContextMapError('One group exceeds maxViewBytes; increase the view budget', 'CONTEXT_MAP_LIMIT')
    }
    return view
  }

  /**
   * Take the curator role for an agent. The previous holder, live or not, is replaced and the
   * handoff is logged. This is a plugin-level operation: no model tool calls it.
   * @param caller - the exact live agent; the holder, or the map owner naming another holder.
   * @param request - target map, holder, and route.
   * @param signal - cancellation.
   * @returns the committed snapshot and the observed index digest; claiming does not mark it curated.
   * @throws {@link ContextMapError} `CONTEXT_MAP_UNAUTHORIZED` when a non-owner names another holder.
   */
  async claim(
    caller: Agent, request: ClaimRequest = {}, signal?: AbortSignal,
  ): Promise<MapSnapshot & { readonly observedIndexDigest: string }> {
    this.live(caller)
    const owner = this.ownerFor(request.rootSessionId ?? this.rootOf(caller).id)
    const holderId = request.holderId ?? caller.id
    if (holderId !== caller.id && caller !== owner) {
      throw new ContextMapError('Only the map owner may give the curator role to another agent', 'CONTEXT_MAP_UNAUTHORIZED')
    }
    const facts = await this.facts(owner, signal)
    this.live(caller)
    const current = this.snapshotOf(owner)
    this.spaceAtClaim.set(owner.id, this.spaceRefusals.get(owner.id) ?? 0)
    const committed = await this.commit(owner, caller.id, {
      kind: 'claim', target: holderId, ...request.work === undefined ? {} : { work: request.work },
    }, {
      ...current,
      curatorId: holderId,
      route: request.route ?? null,
    })
    this.announced.delete(owner.id)
    return { ...committed, observedIndexDigest: facts.digest }
  }

  /**
   * Give up the curator role. The holder or the map owner may release it.
   * @param caller - the exact live holder or the owner.
   * @param target - which map.
   * @returns the committed snapshot, or the current one when nobody held the role.
   * @throws {@link ContextMapError} `CONTEXT_MAP_UNAUTHORIZED` for any other caller.
   */
  async release(caller: Agent, target: MapTarget = {}): Promise<MapSnapshot> {
    this.live(caller)
    const owner = this.ownerFor(target.rootSessionId ?? this.rootOf(caller).id)
    const current = this.snapshotOf(owner)
    if (caller !== owner && current.curatorId !== caller.id) {
      throw new ContextMapError('Only the curator or the map owner may release the role', 'CONTEXT_MAP_UNAUTHORIZED')
    }
    if (current.curatorId === null) return current
    return this.commit(owner, caller.id, { kind: 'release', target: current.curatorId }, { ...current, curatorId: null, route: null })
  }

  /**
   * Mark the index observed at claim as fully curated after a successful run. The owner may
   * acknowledge a settled child after its role has been released; another holder excludes it.
   * @param caller - the exact live curator or map owner.
   * @param request - target map and the digest returned by the run's claim.
   * @returns the committed snapshot.
   * @throws {@link ContextMapError} `CONTEXT_MAP_UNAUTHORIZED` for another caller or holder.
   */
  async acknowledgeIndex(caller: Agent, request: MapTarget & { readonly indexDigest: string }): Promise<MapSnapshot> {
    const owner = this.member(caller, request.rootSessionId)
    const current = this.snapshotOf(owner)
    if (current.curatorId === null ? caller !== owner : current.curatorId !== caller.id) {
      throw new ContextMapError('Only the curator or the owner of an unclaimed map may acknowledge the index', 'CONTEXT_MAP_UNAUTHORIZED')
    }
    return this.commit(owner, caller.id, { kind: 'index-ack' }, { ...current, indexDigest: request.indexDigest })
  }

  /**
   * Record a short fact for the curator to verify and file. Any member of the lineage may; the
   * working agent's context carries only this call and its one-line answer.
   * @param caller - the exact live agent.
   * @param request - the text and optional citations.
   * @param signal - cancellation.
   * @returns the pending note id and how many notes now wait.
   * @throws {@link ContextMapError} `CONTEXT_MAP_LIMIT` when `maxPendingNotes` notes already wait.
   */
  async note(caller: Agent, request: NoteRequest, signal?: AbortSignal): Promise<{ id: MapPendingId; pending: number }> {
    const owner = this.member(caller, request.rootSessionId)
    const facts = await this.facts(owner, signal)
    this.live(caller)
    const current = this.snapshotOf(owner)
    if (current.pending.length >= this.config.maxPendingNotes) {
      this.notify({ kind: 'note-filed', ownerSessionId: owner.id })
      throw new ContextMapError(`${current.pending.length} notes already wait for the curator; try again later`, 'CONTEXT_MAP_LIMIT')
    }
    const text = noteText(request.text, this.config)
    const cites = parseCites(request.cites ?? [], facts, current, this.config)
    const id = pendingIdOf()
    await this.commit(owner, caller.id, { kind: 'note-pending', target: id }, {
      ...current,
      pending: [...current.pending, { id, text, cites, by: caller.id }],
    })
    return { id, pending: current.pending.length + 1 }
  }

  /**
   * Create or replace a group.
   * @param caller - the exact live curator.
   * @param request - revision, target, and the group.
   * @param signal - cancellation.
   * @returns the committed snapshot.
   * @throws {@link ContextMapError} for a stale revision, a bad path or member, a duplicate, or an exceeded bound.
   */
  setGroup(caller: Agent, request: SetGroupRequest, signal?: AbortSignal): Promise<MapSnapshot> {
    return this.curate(caller, request, signal, 'group-set', (current, facts) => {
      const existing = request.group.groupId === undefined ? undefined : current.groups.find(group => group.id === request.group.groupId)
      if (request.group.groupId !== undefined && existing === undefined) {
        throw new ContextMapError(`no group ${request.group.groupId}`, 'CONTEXT_MAP_NOT_FOUND')
      }
      if (existing === undefined && current.groups.length >= this.config.maxGroups) {
        throw new ContextMapError(`the map holds at most ${this.config.maxGroups} groups`, 'CONTEXT_MAP_LIMIT')
      }
      const group = buildGroup(request.group, existing?.id ?? groupIdOf(), existing?.notes ?? [], facts, current, this.config)
      return {
        target: group.id,
        next: {
          ...current,
          groups: existing === undefined ? [...current.groups, group] : current.groups.map(entry => entry === existing ? group : entry),
        },
      }
    })
  }

  /**
   * Merge one group into another: members and notes move, the source group is retired.
   * @param caller - the exact live curator.
   * @param request - revision, target, and the two group ids.
   * @param signal - cancellation.
   * @returns the committed snapshot.
   */
  mergeGroups(caller: Agent, request: MergeGroupsRequest, signal?: AbortSignal): Promise<MapSnapshot> {
    return this.curate(caller, request, signal, 'group-merge', (current, facts) => {
      const from = this.group(current, request.from)
      const into = this.group(current, request.into)
      if (from.id === into.id) throw new ContextMapError('merge needs two different groups', 'CONTEXT_MAP_INVALID_INPUT')
      if (from.path.split('/')[0] !== into.path.split('/')[0]) {
        throw new ContextMapError('only groups under the same root merge', 'CONTEXT_MAP_INVALID_INPUT')
      }
      const notes = [...into.notes, ...from.notes]
      if (notes.length > this.config.maxNotesPerGroup) {
        throw new ContextMapError(`a group holds at most ${this.config.maxNotesPerGroup} notes; retire some first`, 'CONTEXT_MAP_LIMIT')
      }
      const rest = { ...current, groups: current.groups.filter(group => group.id !== from.id) }
      const merged = buildGroup(
        {
          path: into.path,
          title: into.title,
          summary: into.summary,
          sections: [...into.sections, ...from.sections],
          tools: [...into.tools, ...from.tools],
        },
        into.id,
        notes,
        facts,
        rest,
        this.config,
      )
      return { target: into.id, next: { ...rest, groups: rest.groups.map(group => group.id === into.id ? merged : group) } }
    })
  }

  /**
   * Remove a group and its notes.
   * @param caller - the exact live curator.
   * @param request - revision, target, and the group id.
   * @param signal - cancellation.
   * @returns the committed snapshot.
   */
  retireGroup(caller: Agent, request: RetireGroupRequest, signal?: AbortSignal): Promise<MapSnapshot> {
    return this.curate(caller, request, signal, 'group-retire', (current) => {
      const group = this.group(current, request.groupId)
      return { target: group.id, next: { ...current, groups: current.groups.filter(entry => entry.id !== group.id) } }
    })
  }

  /**
   * File a new note under a group. A note needs at least one citation.
   * @param caller - the exact live curator.
   * @param request - revision, target, group, text, and citations.
   * @param signal - cancellation.
   * @returns the committed snapshot.
   * @throws {@link ContextMapError} for no citation, a citation of a note, or an unknown section.
   */
  addNote(caller: Agent, request: AddNoteRequest, signal?: AbortSignal): Promise<MapSnapshot> {
    return this.curate(caller, request, signal, 'note-add', (current, facts) => {
      const cites = parseCites(request.cites, facts, current, this.config)
      if (cites.length === 0) throw new ContextMapError('a note needs at least one citation', 'CONTEXT_MAP_INVALID_INPUT')
      const note: MapNote = { id: noteIdOf(), text: noteText(request.text, this.config), cites }
      return { target: note.id, next: this.withNote(current, request.groupId, note) }
    })
  }

  /**
   * Re-verify a note against the current sources: its citations take the current hashes, which
   * clears the stale flag. The curator is asserting that it re-read the sources.
   * @param caller - the exact live curator.
   * @param request - revision, target, note id, and optionally corrected text.
   * @param signal - cancellation.
   * @returns the committed snapshot.
   * @throws {@link ContextMapError} `CONTEXT_MAP_NOT_FOUND` when a cited section is gone.
   */
  verifyNote(caller: Agent, request: VerifyNoteRequest, signal?: AbortSignal): Promise<MapSnapshot> {
    return this.curate(caller, request, signal, 'note-verify', (current, facts) => {
      const { group, note } = this.noteOf(current, request.noteId)
      const verified: MapNote = {
        id: note.id,
        text: request.text === undefined ? note.text : noteText(request.text, this.config),
        cites: restamp(note.cites, facts),
      }
      return { target: note.id, next: this.replaceNote(current, group.id, verified) }
    })
  }

  /**
   * Remove a note.
   * @param caller - the exact live curator.
   * @param request - revision, target, and the note id.
   * @param signal - cancellation.
   * @returns the committed snapshot.
   */
  retireNote(caller: Agent, request: RetireNoteRequest, signal?: AbortSignal): Promise<MapSnapshot> {
    return this.curate(caller, request, signal, 'note-retire', (current) => {
      const { group, note } = this.noteOf(current, request.noteId)
      return { target: note.id, next: this.replaceNote(current, group.id, undefined, note.id) }
    })
  }

  /**
   * File a pending note under a group. Section citations whose text changed since the author wrote
   * the note are dropped, so the curator must cite fresh sources it checked; the filed note still
   * needs at least one citation.
   * @param caller - the exact live curator.
   * @param request - revision, target, pending id, group, and optional text and extra citations.
   * @param signal - cancellation.
   * @returns the committed snapshot.
   */
  filePending(caller: Agent, request: FilePendingRequest, signal?: AbortSignal): Promise<MapSnapshot> {
    return this.curate(caller, request, signal, 'note-file', (current, facts) => {
      const pending = current.pending.find(entry => entry.id === request.pendingId)
      if (pending === undefined) throw new ContextMapError(`no pending note ${request.pendingId}`, 'CONTEXT_MAP_NOT_FOUND')
      const fresh = parseCites(request.cites ?? [], facts, current, this.config)
      const kept = pending.cites.filter(cite => !isStale([cite], facts))
      const same = (a: MapCite, b: MapCite): boolean => JSON.stringify(a) === JSON.stringify(b)
      const cites = [...kept, ...fresh].filter((cite, index, all) => all.findIndex(other => same(other, cite)) === index)
      if (cites.length === 0) {
        throw new ContextMapError('the note has no citation that still holds; cite a section or evidence you checked', 'CONTEXT_MAP_INVALID_INPUT')
      }
      if (cites.length > this.config.maxCitesPerNote) {
        throw new ContextMapError(`a note carries at most ${this.config.maxCitesPerNote} citations`, 'CONTEXT_MAP_LIMIT')
      }
      const note: MapNote = { id: noteIdOf(), text: noteText(request.text ?? pending.text, this.config), cites }
      const withNote = this.withNote(current, request.groupId, note)
      return { target: note.id, next: { ...withNote, pending: withNote.pending.filter(entry => entry.id !== pending.id) } }
    })
  }

  /**
   * Discard a pending note without filing it.
   * @param caller - the exact live curator.
   * @param request - revision, target, and the pending id.
   * @param signal - cancellation.
   * @returns the committed snapshot.
   */
  dropPending(caller: Agent, request: DropPendingRequest, signal?: AbortSignal): Promise<MapSnapshot> {
    return this.curate(caller, request, signal, 'pending-drop', (current) => {
      if (!current.pending.some(entry => entry.id === request.pendingId)) {
        throw new ContextMapError(`no pending note ${request.pendingId}`, 'CONTEXT_MAP_NOT_FOUND')
      }
      return { target: request.pendingId, next: { ...current, pending: current.pending.filter(entry => entry.id !== request.pendingId) } }
    })
  }

  /**
   * Choose the sections that are granted up front. The tree grants them within its own byte budget.
   * @param caller - the exact live curator.
   * @param request - revision, target, and the section ids in priority order.
   * @param signal - cancellation.
   * @returns the committed snapshot.
   * @throws {@link ContextMapError} `CONTEXT_MAP_LIMIT` for more than `maxCoreSections` sections.
   */
  setCore(caller: Agent, request: SetCoreRequest, signal?: AbortSignal): Promise<MapSnapshot> {
    return this.curate(caller, request, signal, 'core-set', (current, facts) => {
      const core = [...new Set(request.sections.map(raw => knownSection(raw, facts)))]
      if (core.length > this.config.maxCoreSections) {
        throw new ContextMapError(`the core holds at most ${this.config.maxCoreSections} sections`, 'CONTEXT_MAP_LIMIT')
      }
      return { next: { ...current, core } }
    })
  }

  private group(snapshot: MapSnapshot, id: MapGroupId): MapGroup {
    const group = snapshot.groups.find(entry => entry.id === id)
    if (group === undefined) throw new ContextMapError(`no group ${id}`, 'CONTEXT_MAP_NOT_FOUND')
    return group
  }

  private noteOf(snapshot: MapSnapshot, id: MapNoteId): { group: MapGroup; note: MapNote } {
    for (const group of snapshot.groups) {
      const note = group.notes.find(entry => entry.id === id)
      if (note !== undefined) return { group, note }
    }
    throw new ContextMapError(`no note ${id}`, 'CONTEXT_MAP_NOT_FOUND')
  }

  private withNote(snapshot: MapSnapshot, groupId: MapGroupId, note: MapNote): Omit<MapSnapshot, 'revision'> {
    const group = this.group(snapshot, groupId)
    if (group.notes.length >= this.config.maxNotesPerGroup) {
      throw new ContextMapError(`a group holds at most ${this.config.maxNotesPerGroup} notes; retire some first`, 'CONTEXT_MAP_LIMIT')
    }
    return { ...snapshot, groups: snapshot.groups.map(entry => entry.id === groupId ? { ...entry, notes: [...entry.notes, note] } : entry) }
  }

  private replaceNote(snapshot: MapSnapshot, groupId: MapGroupId, note: MapNote | undefined, removeId?: MapNoteId): Omit<MapSnapshot, 'revision'> {
    return {
      ...snapshot,
      groups: snapshot.groups.map((group) => {
        if (group.id !== groupId) return group
        const notes = note === undefined
          ? group.notes.filter(entry => entry.id !== removeId)
          : group.notes.map(entry => entry.id === note.id ? note : entry)
        return { ...group, notes }
      }),
    }
  }

  /**
   * Run one curator edit. Everything after the index read is synchronous up to the append, so the
   * role check, the revision check, and the commit see one state.
   */
  private async curate(
    caller: Agent,
    request: CurateRequest,
    signal: AbortSignal | undefined,
    kind: MapOpKind,
    build: (current: MapSnapshot, facts: IndexFacts) => { target?: string; next: Omit<MapSnapshot, 'revision'> },
  ): Promise<MapSnapshot> {
    const owner = this.member(caller, request.rootSessionId)
    const facts = await this.facts(owner, signal)
    this.live(caller)
    const current = this.snapshotOf(owner)
    if (current.curatorId !== caller.id) {
      throw new ContextMapError('Current curator role is required', 'CONTEXT_MAP_UNAUTHORIZED')
    }
    if (current.revision !== request.expectedRevision) {
      throw new ContextMapError(
        `the map is at revision ${current.revision}, not ${request.expectedRevision}; read it again`,
        'CONTEXT_MAP_CONFLICT',
      )
    }
    const { target, next } = build(current, facts)
    return this.commit(owner, caller.id, { kind, ...target === undefined ? {} : { target } }, next)
  }

  /** Empty page with the same metadata and counters used by reads and admission. */
  private viewFrame(snapshot: MapSnapshot, staleNotes: number, indexChanged: boolean, needsSpace: boolean): MapView {
    return {
      ownerSessionId: snapshot.ownerSessionId, revision: snapshot.revision, curatorId: snapshot.curatorId,
      core: snapshot.core, pending: [], nextPendingAfter: null, omittedPending: snapshot.pending.length,
      groups: [], nextGroupAfter: null, omittedGroups: snapshot.groups.length, staleNotes, indexChanged,
      ...needsSpace ? { needsSpace: true as const } : {},
    }
  }

  /** Every accepted item must remain reachable on a page, including its metadata and cursors. */
  private validatePages(snapshot: MapSnapshot): void {
    const frame = this.viewFrame(snapshot, snapshot.groups.reduce((sum, group) => sum + group.notes.length, 0), false, true)
    const check = (page: MapView): void => {
      if (byteLength(JSON.stringify(page)) > this.config.maxViewBytes) {
        throw new ContextMapError('The edit would make a map item exceed maxViewBytes; shorten the item or increase the view budget', 'CONTEXT_MAP_LIMIT')
      }
    }
    check(frame)
    for (const note of snapshot.pending) check({ ...frame, pending: [note], nextPendingAfter: note.id })
    for (const group of snapshot.groups) {
      const header: MapGroupView = { ...group, notes: [], omittedNotes: group.notes.length, nextNoteAfter: '' }
      const page = { ...frame, groups: [header], nextGroupAfter: group.id }
      check(page)
      for (const note of group.notes) {
        check({ ...page, groups: [{ ...header, notes: [{ ...note, stale: false }], nextNoteAfter: note.id }] })
      }
    }
  }

  private async commit(owner: Agent, actor: SessionId, op: Omit<MapOp, 'actor'>, next: Omit<MapSnapshot, 'revision'>): Promise<MapSnapshot> {
    if (this.disposed) throw new ContextMapError('context map disposed', 'CONTEXT_MAP_DISPOSED')
    const current = this.snapshotOf(owner)
    const snapshot: MapSnapshot = { ...next, ownerSessionId: owner.id, revision: current.revision + 1 }
    // Role metadata must never prevent taking the role needed to shrink content. Measure every
    // content edit with the same role-free metadata so a note cannot spend released role space.
    const content = { ...snapshot, curatorId: null, route: null, indexDigest: null }
    if (op.kind !== 'claim' && op.kind !== 'release' && op.kind !== 'index-ack'
      && byteLength(JSON.stringify(content)) > this.config.maxSnapshotBytes) {
      if (op.kind === 'note-pending') {
        this.spaceRefusals.set(owner.id, (this.spaceRefusals.get(owner.id) ?? 0) + 1)
        this.notify({ kind: 'note-filed', ownerSessionId: owner.id })
        throw new ContextMapError(`the map would exceed ${this.config.maxSnapshotBytes} bytes; shorten this note or retry after the curator frees space`, 'CONTEXT_MAP_LIMIT')
      }
      throw new ContextMapError(`the map would exceed ${this.config.maxSnapshotBytes} bytes; merge or retire groups first`, 'CONTEXT_MAP_LIMIT')
    }
    this.validatePages(snapshot)
    owner.session.append('context-map/state', { version: 1, op: { ...op, actor }, snapshot })
    this.indexHolder(owner)
    // A finished hold has seen every refusal made before it started; later ones still wait.
    if (op.kind === 'release') this.spaceSeen.set(owner.id, this.spaceAtClaim.get(owner.id) ?? this.spaceRefusals.get(owner.id) ?? 0)
    await this.ctx.sessions.flush(owner.session)
    this.notify({ kind: op.kind === 'note-pending' ? 'note-filed' : 'committed', ownerSessionId: owner.id })
    return structuredClone(snapshot)
  }

  private live(caller: Agent): void {
    if (this.disposed) throw new ContextMapError('context map disposed', 'CONTEXT_MAP_DISPOSED')
    if (this.ctx.agents.get(caller.id) !== caller) {
      throw new ContextMapError('Caller is stale; resolve the exact live Agent', 'CONTEXT_MAP_UNAUTHORIZED')
    }
  }

  private ownerFor(rootId: SessionId): Agent {
    const owner = this.ctx.agents.get(rootId)
    if (owner === undefined) throw new ContextMapError('The map owner is not live; resume its Session first', 'CONTEXT_MAP_NOT_FOUND')
    return owner
  }

  /** The owner of the map a live caller may read: its own root, its parent, or the one it holds. */
  private member(caller: Agent, rootSessionId: SessionId | undefined): Agent {
    this.live(caller)
    const owner = this.ownerFor(rootSessionId ?? this.rootOf(caller).id)
    if (this.rootOf(caller) !== owner && this.snapshotOf(owner).curatorId !== caller.id) {
      throw new ContextMapError('Caller is not part of this map\'s Session lineage and does not hold its curator role', 'CONTEXT_MAP_UNAUTHORIZED')
    }
    return owner
  }

  /** Rebuildable live role index; projections remain the authority. */
  private indexHolder(owner: Agent): void {
    for (const [holder, owners] of this.heldOwners) {
      owners.delete(owner.id)
      if (owners.size === 0) this.heldOwners.delete(holder)
    }
    const snapshot = this.projection.stateOf(owner.session).snapshot
    if (snapshot === null || snapshot.ownerSessionId !== owner.id || snapshot.curatorId === null) return
    const owners = this.heldOwners.get(snapshot.curatorId) ?? new Set<SessionId>()
    owners.add(owner.id)
    this.heldOwners.set(snapshot.curatorId, owners)
  }

  private snapshotOfRoot(agent: Agent): MapSnapshot {
    return this.snapshotOf(this.rootOf(agent))
  }

  /** The root agent of a lineage, or the highest live ancestor when a parent is no longer live. */
  private rootOf(agent: Agent): Agent {
    let current = agent
    for (;;) {
      const parentId = current.session.header.parentSession
      const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
      if (parent === undefined) return current
      current = parent
    }
  }

  private groupsFor(agent: Agent): CuratedGroup[] {
    const owner = this.rootOf(agent)
    const hashes = this.hashes.get(owner.id)
    return this.snapshotOf(owner).groups.map((group) => {
      const { root, origin, name } = parseGroupPath(group.path)
      const stale = hashes !== undefined && group.notes.some(note => note.cites.some(cite => cite.kind === 'section' && hashes.get(cite.id) !== cite.hash))
      return {
        root,
        origin,
        name,
        title: group.title,
        summary: stale ? `[stale until re-verified] ${group.summary}` : group.summary,
        sections: group.sections,
        tools: group.tools,
      }
    })
  }

  private async facts(owner: Agent, signal: AbortSignal | undefined): Promise<IndexFacts> {
    if (this.disposed) throw new ContextMapError('context map disposed', 'CONTEXT_MAP_DISPOSED')
    const snapshot = await this.ctx.contextIndex.snapshot(
      { workingDirectory: await this.ctx.workingDirectory.ensure(owner, signal) },
      signal,
    )
    const sections = new Map(snapshot.sections.map(section => [section.id, section]))
    this.hashes.set(owner.id, new Map(snapshot.sections.map(section => [section.id, section.hash])))
    return { sections, digest: digestOf(snapshot.sections) }
  }

  /**
   * The curation work waiting for an owner's map, whoever holds the role.
   * @param owner - the map owner.
   * @param signal - cancellation.
   * @returns the work, or `null` when nothing waits.
   */
  curationWork(owner: Agent, signal?: AbortSignal): Promise<CurationWork | null> {
    return this.facts(owner, signal).then(facts => this.workOf(owner, facts))
  }

  private needsSpace(owner: Agent): boolean {
    return (this.spaceRefusals.get(owner.id) ?? 0) > (this.spaceSeen.get(owner.id) ?? 0)
  }

  /** Durable work (index, pending, stale) comes from the Session log, so it survives restarts; a refused note does not. */
  private workOf(owner: Agent, facts: IndexFacts): CurationWork | null {
    const snapshot = this.snapshotOf(owner)
    const reasons: CurationWork['reasons'][number][] = []
    if (facts.sections.size > 0 && snapshot.indexDigest !== facts.digest) reasons.push('index')
    if (snapshot.pending.length > 0) reasons.push('pending')
    const stale = snapshot.groups.flatMap(group => group.notes.filter(note => isStale(note.cites, facts)).map(note => note.id))
    if (stale.length > 0) reasons.push('stale')
    const space = this.needsSpace(owner)
    if (space) reasons.push('space')
    if (reasons.length === 0) return null
    const content = { ...snapshot, revision: 0, curatorId: null, route: null, indexDigest: null }
    const signature = createHash('sha256').update(JSON.stringify([
      reasons.includes('index') ? facts.digest : null,
      snapshot.pending.map(note => note.id).toSorted(),
      stale.toSorted(),
      space ? byteLength(JSON.stringify(content)) : null,
    ])).digest('hex').slice(0, 16)
    const attempts = this.projection.stateOf(owner.session).attempts
    return { reasons, signature, attempts: attempts?.work === signature ? attempts.count : 0 }
  }

  private async observe(agent: Agent, signal: AbortSignal): Promise<void> {
    const work = this.workOf(agent, await this.facts(agent, signal))
    if (work === null || this.announced.get(agent.id) === work.signature) return
    this.announced.set(agent.id, work.signature)
    this.notify({ kind: 'work-waiting', ownerSessionId: agent.id })
  }

  private async releaseGone(ownerId: SessionId, holderId: SessionId): Promise<void> {
    const owner = this.ctx.agents.get(ownerId)
    if (owner === undefined || this.disposed) return
    const current = this.snapshotOf(owner)
    if (current.curatorId !== holderId) return
    await this.commit(owner, ownerId, { kind: 'release', target: holderId }, { ...current, curatorId: null, route: null })
  }

  private notify(change: MapChange): void {
    for (const listener of [...this.watchers]) {
      try {
        listener(change)
      } catch (error: unknown) {
        this.ctx.logger.warn(`context map: watcher failed: ${String(error)}`)
      }
    }
  }
}

export default ContextMapService
