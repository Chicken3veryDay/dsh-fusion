/**
 * Browser-safe types for the experimental project map: the durable, citation-checked grouping of
 * context sections and tools, the operations that edit it, and the configuration bounds.
 *
 * @module @deepseek-ai/dsh-experimental-context-map/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextSectionId } from '@deepseek-ai/dsh-experimental-context-index/types'

/** Identity of one group, stable across edits. */
export type MapGroupId = Branded<'ContextMapGroupId'>

/** Identity of one filed note. */
export type MapNoteId = Branded<'ContextMapNoteId'>

/** Identity of one note that is waiting to be filed. */
export type MapPendingId = Branded<'ContextMapPendingId'>

/**
 * What a note stands on. A section citation records the content hash the claim was checked
 * against; a note whose cited section no longer has that hash is stale. An evidence citation is a
 * short reference to a tool result or file outside the index. A note never cites another note.
 */
export type MapCite =
  | { readonly kind: 'section'; readonly id: ContextSectionId; readonly hash: string }
  | { readonly kind: 'evidence'; readonly ref: string }

/** A short fact filed under a group, with the sources it was checked against. */
export interface MapNote {
  readonly id: MapNoteId
  readonly text: string
  /** At least one citation; every section citation names a section the index had when the note was written. */
  readonly cites: readonly MapCite[]
}

/** A note the working agent recorded with `context_note` that the curator has not filed yet. */
export interface MapPendingNote {
  readonly id: MapPendingId
  readonly text: string
  /** Citations the author supplied; may be empty, in which case the curator must add evidence before filing. */
  readonly cites: readonly MapCite[]
  /** The agent that recorded it. */
  readonly by: SessionId
}

/** A named folder of sections or tools the curator placed in the tree. */
export interface MapGroup {
  readonly id: MapGroupId
  /** `Root/Origin/name`: `Instructions`, `Sources`, or `Tools`, then `Global` or `Project`, then the group name. */
  readonly path: string
  readonly title: string
  /** One line saying when to use what is in the group. */
  readonly summary: string
  /** Member sections; empty under `Tools`. */
  readonly sections: readonly ContextSectionId[]
  /** Member tool names; empty under `Instructions` and `Sources`. */
  readonly tools: readonly string[]
  readonly notes: readonly MapNote[]
}

/** The model route a curator run was started on. */
export interface MapRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Complete durable value of one map, owned by one root Session. */
export interface MapSnapshot {
  readonly ownerSessionId: SessionId
  /** Contiguous, starting at 1 for the first edit; every curator edit names the revision it read. */
  readonly revision: number
  /** The agent that holds the curator role; at most one. */
  readonly curatorId: SessionId | null
  /** Route of the default curator run that holds the role; null for other holders. */
  readonly route: MapRoute | null
  /** Digest of the index sections a curator run last completed. */
  readonly indexDigest: string | null
  /** Sections granted up front, in priority order. */
  readonly core: readonly ContextSectionId[]
  readonly groups: readonly MapGroup[]
  readonly pending: readonly MapPendingNote[]
}

/** Kinds of logged map edit. */
export type MapOpKind =
  | 'claim'
  | 'release'
  | 'index-ack'
  | 'group-set'
  | 'group-merge'
  | 'group-retire'
  | 'note-add'
  | 'note-verify'
  | 'note-retire'
  | 'note-pending'
  | 'note-file'
  | 'pending-drop'
  | 'core-set'

/** Why a snapshot was committed: the edit kind, the agent that issued it, and the object it touched. */
export interface MapOp {
  readonly kind: MapOpKind
  readonly actor: SessionId
  readonly target?: string
  /** For `claim`: fingerprint of the curation work the run was started for; equal fingerprints count as one retried job. */
  readonly work?: string
}

/** A note as the model sees it. */
export interface MapNoteView extends MapNote {
  /** True when a cited section changed or vanished since the note was checked. */
  readonly stale: boolean
}

/** A group as the model sees it. */
export interface MapGroupView extends Omit<MapGroup, 'notes'> {
  readonly notes: readonly MapNoteView[]
  /** Notes after this page; read with groupId and nextNoteAfter. */
  readonly omittedNotes: number
  readonly nextNoteAfter: MapNoteId | '' | null
}

/** The bounded read a curator or member gets. */
export interface MapView {
  readonly ownerSessionId: SessionId
  readonly revision: number
  readonly curatorId: SessionId | null
  readonly core: readonly ContextSectionId[]
  readonly groups: readonly MapGroupView[]
  /** Groups left out because the view byte bound was reached. */
  readonly omittedGroups: number
  readonly pending: readonly MapPendingNote[]
  /** Stable pending id to pass as pendingAfter, or null when this queue page is complete. */
  readonly nextPendingAfter: MapPendingId | null
  /** Stable group id to pass as groupAfter; an empty string starts the group pages without pending notes. */
  readonly nextGroupAfter: MapGroupId | '' | null
  /** Pending entries after this page that did not fit. */
  readonly omittedPending: number
  /** Notes whose cited sections changed or vanished. */
  readonly staleNotes: number
  /** True when the index has changed since the curator last processed it. */
  readonly indexChanged: boolean
  /** Present and true when the working agent's last note was refused because the map is full; free room before anything else. */
  readonly needsSpace?: true
}

/** What a watcher is told. */
export interface MapChange {
  readonly kind: 'committed' | 'work-waiting' | 'note-filed' | 'holder-gone'
  readonly ownerSessionId: SessionId
  /** The agent that vanished while holding the role; set for `holder-gone`. */
  readonly holderId?: SessionId
}

/** Request to set or create a group. */
export interface MapGroupRequest {
  /** Existing group to replace; omitted creates a group. */
  readonly groupId?: MapGroupId
  readonly path: string
  readonly title: string
  readonly summary: string
  readonly sections?: readonly string[]
  readonly tools?: readonly string[]
}

/**
 * Project map configuration. Every field has a working default, so no configuration is required;
 * a value that cannot work makes the service fail at mount.
 */
export interface Config {
  /** Most groups one map holds (default 32). */
  maxGroups?: number
  /** Most sections plus tools one group holds (default 32). */
  maxGroupMembers?: number
  /** Most filed notes one group holds (default 8). */
  maxNotesPerGroup?: number
  /** Most citations one note carries (default 4). */
  maxCitesPerNote?: number
  /** Longest note text in UTF-8 bytes (default 400). */
  maxNoteBytes?: number
  /** Longest evidence reference in UTF-8 bytes (default 200). */
  maxEvidenceBytes?: number
  /** Most notes waiting to be filed (default 16). */
  maxPendingNotes?: number
  /** Longest group title in UTF-8 bytes (default 80). */
  maxTitleBytes?: number
  /** Longest group summary in UTF-8 bytes (default 160). */
  maxSummaryBytes?: number
  /** Most sections in the eager core (default 8). */
  maxCoreSections?: number
  /** UTF-8 bytes of a map snapshot with role and index metadata cleared (default 65,536). */
  maxSnapshotBytes?: number
  /** UTF-8 bytes of one rendered view; must fit page metadata and a maximum-size note (default 8,192). */
  maxViewBytes?: number
}

/** Default curator configuration. */
export interface CuratorConfig {
  /** Registered subagent provider that runs the curator (default `spawn`). */
  provider?: string
  /** Most model steps one curator run takes (default 24). */
  maxSteps?: number
  /** Output tokens per curator step (default 4,096). */
  maxTokens?: number
  /** Smallest context window a curator route may have, in tokens (default 32,768). */
  minContextTokens?: number
  /** Most catalog models of the parent's provider that route selection inspects (default 16). */
  maxRoutesInspected?: number
  /** Most runs started for one unchanged body of work, counted in the Session log so a restart does not reset it (default 2). */
  maxAttempts?: number
}
