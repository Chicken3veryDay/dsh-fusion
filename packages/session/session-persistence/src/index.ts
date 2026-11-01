/**
 * Durable session-persistence Service Definition (`ctx.sessionPersistence`). Backends store
 * {@link SessionEvent}s as the event-sourced log and carry non-replayable
 * {@link SessionHeader} metadata separately; callers address one stored
 * session through a {@link SessionHandle} obtained from `create`/`open`.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionAccess } from './handle.ts'
import type { SessionLocation } from './errors.ts'
import type { SessionPersistenceRevision } from './revision.ts'

// Re-export the metadata vocabulary so Consumers import it from the Service Definition.
export type { SessionHeader } from '@deepseek-ai/dsh-session'
export { SessionPersistenceRevision } from './revision.ts'
export type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
} from './handle.ts'
export {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  sessionFormatVersionRefusal,
} from './errors.ts'
export type { SessionLocation } from './errors.ts'
export {
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
} from './storage-contract.ts'

/**
 * Lightweight stored-session observation returned by {@link SessionPersistence.stat}
 * and {@link SessionPersistence.list} without reading the full event log.
 */
export interface SessionPersistenceSnapshot {
  /** Detached metadata for one stored session. */
  readonly header: SessionHeader
  /** Header-only format classification; absent without versioned artifact metadata. */
  readonly formatStatus?: 'current' | 'migration-required'
  /** Opaque change token; see {@link SessionPersistence.stat}. */
  readonly revision: SessionPersistenceRevision
  /** Logical event count, when the backend can provide it cheaply from metadata; otherwise absent. */
  readonly eventCount?: number
  /** Physical artifact byte size, when the backend can provide it cheaply (JSONL); otherwise absent. */
  readonly sizeBytes?: number
  /**
   * Backend-resolved location of the selected materialized per-Session
   * artifact, for diagnostics and export. Absent when the backend has no
   * materialized per-Session file, including an unmaterialized pending Session.
   */
  readonly location?: SessionLocation
}

/** Options for {@link SessionPersistence.create}. */
export interface SessionPersistenceCreateOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
  /**
   * Exact fork-inherited prefix length. Required when `header.isSeeded` is
   * true and must be omitted (or `0`) otherwise; the backend refuses a
   * mismatch at create.
   */
  readonly inheritedEventCount?: SessionLogOffset
}

/**
 * Logical Session header paired with its exact inherited cut for body-bearing
 * storage operations. `isSeeded` marks fork lineage on the header; the
 * numeric cut travels beside it, never inside the replayable event log.
 */
export interface SessionStorageMetadata {
  /** Validated immutable Session header. */
  readonly meta: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset
}

/** Immutable logical session read: storage metadata plus the complete validated event log. */
export interface SessionInspection extends SessionStorageMetadata {
  /** Contiguous validated events from seq 0. */
  readonly events: readonly SessionEvent[]
}

/** Options for {@link SessionPersistence.open}. */
export interface SessionPersistenceOpenOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.stat}. */
export interface SessionPersistenceStatOptions {
  /** Optional cancellation for backend metadata reads. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.list}. */
export interface SessionPersistenceListOptions {
  /** Optional cancellation for backend listing work. */
  readonly signal?: AbortSignal
}

/** A host-only durability result; identities are transient and never stored or accepted as input. */
export type SessionDurabilityResult =
  | {
    readonly kind: 'durable'
    readonly session: Session
    /** Exclusive required event boundary, captured before the first await. */
    readonly boundary: SessionLogOffset
    readonly operation: symbol
    readonly writer: symbol
  }
  | {
    readonly kind: 'refused'
    readonly reason: 'unsupported' | 'not-live' | 'missing-writer' | 'stale-writer' | 'coverage'
  }
  | {
    readonly kind: 'refused'
    readonly reason: 'flush-failed'
    /** Original storage/listener failure; refusal does not imply rollback. */
    readonly cause: unknown
  }

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/** Refusal leaves dispatch closed; uncertainty retains the writer and its storage ownership. */
export type WriterLifetimeReason = 'unsupported' | 'not-live' | 'missing-writer' | 'fenced' | 'released' | 'uncertain'
/** Verified prefix on the reserved writer, or a refusal that never implies rollback. */
export type WriterLifetimeFlush = { readonly kind: 'durable'; readonly boundary: SessionLogOffset }
  | { readonly kind: 'refused'; readonly reason: WriterLifetimeReason; readonly cause?: unknown }
/** Private host operation lifetime; never a model/SDK credential or permission grant. */
export interface SessionWriterReservation {
  /** Monotonic cancellation request; cancellation alone does not establish cleanup. */
  readonly signal: AbortSignal
  /**
   * Reauthenticate the declaring provider, exact live Session and writer immediately before dispatch.
   * @returns refusal when fenced, released or uncertain; otherwise undefined.
   */
  checkDispatch(): { readonly kind: 'refused'; readonly reason: WriterLifetimeReason } | undefined
  /**
   * Capture the current Session boundary synchronously and verify storage on the pinned writer.
   * Fenced reservations may finish cleanup while public handle operations remain closed.
   * @returns durable prefix or sticky uncertainty; earlier receipts authorize nothing.
   */
  flushDurably(): Promise<WriterLifetimeFlush>
  /**
   * Close admission synchronously, join earlier flushes and verify the final captured prefix.
   * Call only after the owned operation and cleanup finish. Idempotent; uncertainty retains ownership.
   * @returns the memoized durability join, never the handle's close join.
   */
  release(): Promise<WriterLifetimeFlush>
}
/** Synchronously registered exact-writer operation, or explicit unsupported/lifecycle refusal. */
export type WriterLifetimeReservation = { readonly kind: 'reserved'; readonly reservation: SessionWriterReservation }
  | { readonly kind: 'refused'; readonly reason: WriterLifetimeReason }

/**
 * Durable append-only session storage addressed through per-session handles.
 *
 * Storage semantics shared by every backend: events are contiguous from seq 0
 * and never rewritten; a torn physical tail is never returned to a reader and
 * is truncated by the write path before its first append; reads validate
 * current-format records only and refuse unknown vocabulary fail-closed.
 * `append` persists best-effort; `flush` — per handle or service-wide — is
 * the durability barrier.
 *
 * Visibility: a created session is observable through `stat`/`list`/`open`
 * in this process from the moment `create` resolves, even while a backend
 * defers physical materialization (a pure optimization); other processes see
 * the session only once it materializes, and a session that never
 * materialized before a crash never existed. `SessionHandle.flush` forces
 * materialization.
 *
 * Freshness: once an `append` or `flush` resolves, reads started afterwards
 * on this backend instance observe at least that prefix.
 */
export abstract class SessionPersistence extends Service {
  /**
   * Reserve exact provider/Session/writer lifetime before any await or effect-capable callback.
   * Providers authenticate object identity and roll back partial setup on refusal or reentry.
   * Close/withdrawal/detach fence dispatch synchronously, retaining routing and ownership through cleanup.
   * @param session - exact live Session whose current writer must remain owned.
   * @returns a private operation reservation; unsupported providers refuse by default.
   */
  reserveSessionWriter(session: Session): WriterLifetimeReservation {
    void session
    return { kind: 'refused', reason: 'unsupported' }
  }

  /** Process-local instance identity, stable through Context proxies and distinct after service replacement. */
  readonly identity: symbol = Symbol('sessionPersistence')

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /**
   * Opt in to host-verified same-session writer durability. Ordinary callers keep
   * using `sessions.flush(session)`. No model receipt or prior result is input.
   * Providers must capture the live Session's exclusive boundary before awaiting
   * that store entry point, require true, and verify fresh flush coverage from
   * the same currently owned, routed write handle after every await.
   * Refusal leaves dependent protocol work blocked; storage may have committed
   * a prefix, so the caller owns recovery and must not infer rollback or dispatch permission.
   * @param session - exact live Session requiring persistence.
   * @returns a transient success or a typed refusal; unsupported providers refuse explicitly.
   */
  flushSessionDurably(session: Session): Promise<SessionDurabilityResult> {
    void session
    return Promise.resolve({ kind: 'refused', reason: 'unsupported' })
  }

  /**
   * Create a new stored session and take its write ownership.
   * @param header - the immutable header (id, version, cwd, lineage) to store.
   * @param options - optional cancellation.
   * @returns a `write` handle owned by the caller; close it to release ownership.
   * @throws {SessionAlreadyExistsError} when the id already exists.
   */
  abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>

  /**
   * Open an existing stored session.
   *
   * `read` never takes ownership and works while another handle (or process)
   * holds write ownership. `write` atomically claims single-writer ownership;
   * an existing active owner rejects.
   * @param id - the stored session to open.
   * @param access - `read` or `write`.
   * @param options - optional cancellation.
   * @returns the open handle.
   * @throws {SessionPersistenceNotFoundError} when the session does not exist.
   * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
   */
  abstract open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>

  /**
   * Flush every active write handle owned by this service instance in one
   * durability barrier: each handle's routed live events drain durably and
   * its session materializes, exactly as that handle's own
   * `SessionHandle.flush` would. Read handles buffer nothing and are
   * untouched. A handle closed concurrently counts as flushed — close itself
   * drains durably.
   * @returns resolution once every write handle active at the call has flushed.
   * @throws {AggregateError} naming each session whose flush failed; the
   *   remaining handles still flush.
   */
  abstract flush(): Promise<void>

  /**
   * Observe one stored session without reading its event log or taking
   * ownership.
   *
   * The snapshot's `revision` is an opaque change token comparable only
   * against revisions from the same service instance and session id: equal
   * revisions may be treated as an unchanged log; unequal revisions promise
   * nothing. Write-ownership churn does not change a revision. It exists for
   * derived read-model caches keyed off `stat`/`list`; it plays no part in
   * open, read, or resume.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>

  /**
   * List every stored session visible to this process, in no promised order.
   * @param options - optional cancellation.
   * @returns one snapshot per stored session.
   */
  abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>
}

export default SessionPersistence
