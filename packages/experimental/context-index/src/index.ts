/**
 * Experimental context index: deterministic, addressable sections of instruction
 * files and documentation for the working directory.
 *
 * `ctx.contextIndex` splits the user-global and project instruction chain plus
 * Markdown under the documentation roots into sections with stable ids, content
 * hashes, byte sizes, and path and heading anchors; reads bounded section bodies;
 * and renders a bounded catalog. It makes no model calls and registers no tools.
 *
 * @module @deepseek-ai/dsh-experimental-context-index
 */
import { isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { renderCatalog } from './catalog.ts'
import { ConfigSchema, resolveConfig, type ResolvedConfig } from './config.ts'
import { ContextIndexError } from './error.ts'
import { buildRecord, discoverCandidates, readSource, sectionsOf, type Listing, type SourceRecord } from './sources.ts'
import { truncateUtf8 } from './text.ts'
import type {
  Config,
  ContextCatalog,
  ContextCatalogBudget,
  ContextDiagnostic,
  ContextIndexRefresh,
  ContextIndexScope,
  ContextIndexSnapshot,
  ContextReadBudget,
  ContextReadResult,
  ContextSectionBody,
  ContextSectionId,
  ContextSectionMeta,
} from './types.ts'

export { ContextIndexError } from './error.ts'
export type { ContextIndexErrorCode } from './error.ts'
export { ContextSectionIdOf } from './ids.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextIndex: ContextIndexService
  }
}

/** One committed index of a working directory; never mutated after creation. */
interface IndexState {
  readonly snapshot: ContextIndexSnapshot
  readonly records: ReadonlyMap<string, SourceRecord>
  readonly signature: string
  /** Documentation listings the next refresh reuses while their directories are unchanged. */
  readonly listings: ReadonlyMap<string, Listing>
  /** Ordinal of the refresh that committed this state, counted across every working directory. */
  readonly refresh: number
}

/** A section re-read from disk: its text and the metadata derived from that same text. */
type FreshSection = ReturnType<typeof sectionsOf>[number]

interface Flight {
  readonly controller: AbortController
  readonly promise: Promise<IndexState>
  waiters: number
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

function recordKey(kind: string, path: string): string {
  return `${kind}\u0000${path}`
}

/** Service that indexes instruction and documentation sources per working directory. */
export class ContextIndexService extends Service {
  static inject = ['fs']
  static Config: z<Config> = ConfigSchema

  private readonly config: ResolvedConfig
  private readonly states = new Map<string, IndexState>()
  /** Hash of the text each section's latest `read` returned, per working directory; dropped with its state. */
  private readonly served = new Map<string, Map<ContextSectionId, string>>()
  private committed = 0
  private readonly flights = new Map<string, Flight>()
  /** Every accepted refresh and body read until it settles, independent of which flight is still joinable. */
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'contextIndex')
    this.config = resolveConfig(config)
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => this.shutdown(), 'contextIndex.runtime()')
  }

  /**
   * Refresh the index for a working directory and return its section metadata.
   * Files whose version, size, and hash are unchanged are not read again; callers
   * arriving during a refresh share it.
   * @param scope - the working directory.
   * @param signal - cancels this caller's wait; the shared refresh stops when no caller is left.
   * @returns the snapshot, which is the same object while nothing changed.
   * @throws {@link ContextIndexError} `CONTEXT_INDEX_INVALID_INPUT` for a relative or missing directory,
   * `CONTEXT_INDEX_DISPOSED` after disposal, or the abort reason on cancellation.
   */
  async snapshot(scope: ContextIndexScope, signal?: AbortSignal): Promise<ContextIndexSnapshot> {
    return (await this.refresh(scope, signal)).snapshot
  }

  /**
   * Read section bodies within a byte budget.
   * Bodies are read from the files at call time, so `hash` reflects the file now;
   * ids stay valid across edits. Once the budget cuts a body, later ids are omitted.
   * @param scope - the working directory.
   * @param ids - sections to read, in the order to return them.
   * @param budget - byte bound, lowered to the configured `maxReadBytes`.
   * @param signal - cancellation.
   * @returns bodies with full-section hashes, plus missing and omitted ids.
   * @throws {@link ContextIndexError} `CONTEXT_INDEX_INVALID_INPUT` for an invalid budget or scope.
   */
  async read(
    scope: ContextIndexScope,
    ids: readonly ContextSectionId[],
    budget: ContextReadBudget = {},
    signal?: AbortSignal,
  ): Promise<ContextReadResult> {
    const maxBytes = this.effectiveBudget(budget.maxBytes, this.config.maxReadBytes, 'maxBytes')
    const state = await this.refresh(scope, signal)
    const sectionById = new Map(state.snapshot.sections.map(section => [section.id, section]))
    const diagnostics: ContextDiagnostic[] = [...state.snapshot.diagnostics]
    const texts = new Map<string, ReadonlyMap<ContextSectionId, FreshSection>>()
    const bodies: ContextSectionBody[] = []
    const missing: ContextSectionId[] = []
    const omitted: ContextSectionId[] = []
    let remaining = maxBytes
    let used = 0
    for (const id of new Set(ids)) {
      const meta = sectionById.get(id)
      if (meta === undefined) {
        missing.push(id)
        continue
      }
      if (remaining <= 0) {
        omitted.push(id)
        continue
      }
      let sourceTexts = texts.get(meta.sourceId)
      if (sourceTexts === undefined) {
        sourceTexts = await this.sourceTexts(state, meta, diagnostics, signal)
        texts.set(meta.sourceId, sourceTexts)
      }
      const fresh = sourceTexts.get(id)
      if (fresh === undefined) {
        missing.push(id)
        continue
      }
      const body = this.bodyOf(fresh, remaining)
      bodies.push(body)
      this.serve(state.snapshot.scope.workingDirectory, body)
      used += body.bytes
      remaining = body.truncated ? 0 : remaining - body.bytes
    }
    return { revision: state.snapshot.revision, sections: bodies, missing, omitted, usedBytes: used, maxBytes, diagnostics }
  }

  /**
   * The state the latest refresh of a working directory committed, without refreshing.
   * @param scope - the working directory.
   * @returns the snapshot and the ordinal of the refresh that committed it, or undefined when the
   * directory has not been indexed or was evicted.
   * @throws {@link ContextIndexError} `CONTEXT_INDEX_INVALID_INPUT` for a relative directory, `CONTEXT_INDEX_DISPOSED` after disposal.
   */
  latest(scope: ContextIndexScope): ContextIndexRefresh | undefined {
    this.assertLive()
    const state = this.states.get(this.directoryOf(scope))
    return state === undefined ? undefined : { snapshot: state.snapshot, refresh: state.refresh }
  }

  /**
   * How many refreshes have committed, across every working directory. A caller that notes this
   * number and later finds a {@link latest} refresh above it knows that refresh committed in between.
   * @returns the ordinal of the latest committed refresh; 0 before the first.
   */
  refreshes(): number {
    return this.committed
  }

  /**
   * The hash of the text each section's latest `read` in a working directory returned, whoever read
   * it. A section whose current hash differs was last read as other text.
   * @param scope - the working directory.
   * @returns a detached map; empty when no section was read or the directory was evicted.
   * @throws {@link ContextIndexError} `CONTEXT_INDEX_INVALID_INPUT` for a relative directory, `CONTEXT_INDEX_DISPOSED` after disposal.
   */
  lastRead(scope: ContextIndexScope): ReadonlyMap<ContextSectionId, string> {
    this.assertLive()
    return new Map(this.served.get(this.directoryOf(scope)))
  }

  /**
   * Render a compact listing of sections within a byte budget.
   * @param sections - sections in listing order, usually from {@link snapshot}.
   * @param budget - byte bound, lowered to the configured `maxCatalogBytes`.
   * @returns the bounded text and how many sections it lists.
   * @throws {@link ContextIndexError} `CONTEXT_INDEX_INVALID_INPUT` for an invalid budget.
   */
  renderCatalog(sections: readonly ContextSectionMeta[], budget: ContextCatalogBudget = {}): ContextCatalog {
    this.assertLive()
    return renderCatalog(sections, this.effectiveBudget(budget.maxBytes, this.config.maxCatalogBytes, 'maxBytes'))
  }

  private serve(directory: string, body: ContextSectionBody): void {
    // A read that settles after its directory was evicted must not recreate the entry.
    if (!this.states.has(directory)) return
    const served = this.served.get(directory) ?? new Map<ContextSectionId, string>()
    served.set(body.id, body.hash)
    this.served.set(directory, served)
  }

  /** Build a body from the section as just re-read, so its hash and size describe the returned text. */
  private bodyOf({ draft: meta, text: full }: FreshSection, remaining: number): ContextSectionBody {
    const text = truncateUtf8(full, remaining)
    const bytes = Buffer.byteLength(text, 'utf8')
    return {
      id: meta.id,
      path: meta.path,
      anchor: meta.anchor,
      hash: meta.hash,
      totalBytes: meta.bytes,
      bytes,
      truncated: text.length < full.length,
      text,
    }
  }

  /** Re-read one source and return its sections, with metadata derived from that read, as they are on disk now. */
  private async sourceTexts(
    state: IndexState,
    meta: ContextSectionMeta,
    diagnostics: ContextDiagnostic[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<ContextSectionId, FreshSection>> {
    const record = state.records.get(recordKey(meta.kind, meta.path))
    /* v8 ignore if -- a committed state holds a record for every source of its sections, and this state is the one the section came from */
    if (record === undefined) return new Map()
    const outcome = await this.guard(signal, abort => (
      readSource(this.ctx.fs, record.target, record.path, undefined, this.config.maxSourceBytes, abort)
    ))
    if (outcome.kind === 'diagnostic') {
      diagnostics.push(outcome.diagnostic)
      return new Map()
    }
    const sections = sectionsOf(record, outcome.text, this.config)
    return new Map(sections.map(section => [section.draft.id, section]))
  }

  private effectiveBudget(requested: number | undefined, ceiling: number, name: string): number {
    this.assertLive()
    if (requested === undefined) return ceiling
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new ContextIndexError(`${name} must be a positive safe integer, got ${String(requested)}`, 'CONTEXT_INDEX_INVALID_INPUT')
    }
    return Math.min(requested, ceiling)
  }

  private assertLive(): void {
    if (this.lifetime.signal.aborted) throw this.lifetime.signal.reason
  }

  private directoryOf(scope: ContextIndexScope): string {
    if (!isAbsolute(scope.workingDirectory)) {
      throw new ContextIndexError(`workingDirectory must be an absolute path, got "${scope.workingDirectory}"`, 'CONTEXT_INDEX_INVALID_INPUT')
    }
    return resolve(scope.workingDirectory)
  }

  /** Run `work` with a signal that fires on the caller's abort or on disposal. */
  private async guard<T>(signal: AbortSignal | undefined, work: (abort: AbortSignal) => Promise<T>): Promise<T> {
    this.assertLive()
    signal?.throwIfAborted()
    const abort = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    try {
      return await this.track(work(abort))
    } catch (error: unknown) {
      /* v8 ignore else -- readSource fails only with the abort reason, so no failure reaches here outside an abort */
      if (abort.aborted) throw abort.reason
      /* v8 ignore next -- see the guard above */
      throw error
    }
  }

  private refresh(scope: ContextIndexScope, signal: AbortSignal | undefined): Promise<IndexState> {
    this.assertLive()
    signal?.throwIfAborted()
    const directory = this.directoryOf(scope)
    let flight = this.flights.get(directory)
    if (flight === undefined) flight = this.startFlight(directory)
    return this.join(directory, flight, signal)
  }

  private startFlight(directory: string): Flight {
    const controller = new AbortController()
    const abort = AbortSignal.any([controller.signal, this.lifetime.signal])
    const promise = this.track(this.rebuild(directory, abort).catch((error: unknown) => {
      if (abort.aborted) throw abort.reason
      throw error
    }))
    const flight: Flight = { controller, promise, waiters: 0 }
    this.flights.set(directory, flight)
    const clear = (): void => {
      if (this.flights.get(directory) === flight) this.flights.delete(directory)
    }
    // Unobserved when every waiter left; each waiter observes the rejection itself.
    promise.then(clear, clear)
    return flight
  }

  private join(directory: string, flight: Flight, signal: AbortSignal | undefined): Promise<IndexState> {
    flight.waiters++
    return new Promise<IndexState>((resolveJoin, rejectJoin) => {
      const onAbort = (): void => {
        flight.waiters--
        if (flight.waiters === 0) {
          /* v8 ignore else -- the listener is removed in the microtask that clears a settled flight, so this flight is the directory's */
          if (this.flights.get(directory) === flight) this.flights.delete(directory)
          flight.controller.abort(signal?.reason)
        }
        rejectJoin(asError(signal?.reason))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      flight.promise.then(
        (state) => {
          signal?.removeEventListener('abort', onAbort)
          resolveJoin(state)
        },
        (error: unknown) => {
          signal?.removeEventListener('abort', onAbort)
          rejectJoin(asError(error))
        },
      )
    })
  }

  private async rebuild(directory: string, signal: AbortSignal): Promise<IndexState> {
    const fs: FileSystem = this.ctx.fs
    const config = this.config
    let isDirectory: boolean
    try {
      isDirectory = (await fs.stat(await fs.resolve(directory, { signal }), signal))?.type === 'directory'
    } catch (error: unknown) {
      signal.throwIfAborted()
      throw new ContextIndexError(`workingDirectory "${directory}" cannot be inspected: ${error instanceof Error ? error.message : String(error)}`, 'CONTEXT_INDEX_INVALID_INPUT', { cause: error })
    }
    if (!isDirectory) {
      throw new ContextIndexError(`workingDirectory "${directory}" is not an existing directory`, 'CONTEXT_INDEX_INVALID_INPUT')
    }
    const prior = this.states.get(directory)
    const discovery = await discoverCandidates(fs, config, directory, prior?.listings ?? new Map(), signal)
    const diagnostics: ContextDiagnostic[] = [...discovery.diagnostics]
    const loaded = new Map<string, SourceRecord>()
    const ordered: SourceRecord[] = []
    let total = 0
    for (const candidate of discovery.candidates) {
      signal.throwIfAborted()
      const key = recordKey(candidate.kind, candidate.path)
      const cached = prior?.records.get(key)
      const unchanged = cached !== undefined
        && cached.version === candidate.version
        && cached.target.targetKey === candidate.target.targetKey
        && (candidate.size === undefined || candidate.size === cached.bytes)
      let record: SourceRecord
      if (unchanged) {
        record = cached
      } else {
        if (candidate.size !== undefined && total + candidate.size > config.maxTotalSourceBytes) {
          diagnostics.push({ code: 'limit-exceeded', path: candidate.path, message: `total source size would exceed maxTotalSourceBytes (${config.maxTotalSourceBytes})` })
          continue
        }
        const outcome = await readSource(fs, candidate.target, candidate.path, candidate.size, config.maxSourceBytes, signal)
        if (outcome.kind === 'diagnostic') {
          diagnostics.push(outcome.diagnostic)
          continue
        }
        record = cached !== undefined && cached.hash === outcome.hash
          ? { ...cached, version: candidate.version, target: candidate.target }
          : buildRecord(candidate, outcome, config)
      }
      if (total + record.bytes > config.maxTotalSourceBytes) {
        diagnostics.push({ code: 'limit-exceeded', path: candidate.path, message: `total source size would exceed maxTotalSourceBytes (${config.maxTotalSourceBytes})` })
        continue
      }
      total += record.bytes
      loaded.set(key, record)
      ordered.push(record)
    }
    signal.throwIfAborted()
    return this.commit(directory, prior, loaded, ordered, diagnostics, discovery.listings)
  }

  private commit(
    directory: string,
    prior: IndexState | undefined,
    loaded: ReadonlyMap<string, SourceRecord>,
    ordered: readonly SourceRecord[],
    diagnostics: readonly ContextDiagnostic[],
    listings: ReadonlyMap<string, Listing>,
  ): IndexState {
    const kept: SourceRecord[] = []
    const digests = new Map<string, Set<string>>()
    for (const record of ordered) {
      if (record.group !== undefined) {
        const seen = digests.get(record.group) ?? new Set<string>()
        digests.set(record.group, seen)
        if (seen.has(record.trimmedHash)) continue
        seen.add(record.trimmedHash)
      }
      kept.push(record)
    }
    const signature = JSON.stringify([kept.map(record => [record.id, record.hash]), diagnostics])
    let snapshot: ContextIndexSnapshot
    if (prior !== undefined && prior.signature === signature) {
      snapshot = prior.snapshot
    } else {
      let order = 0
      snapshot = {
        scope: { workingDirectory: directory },
        revision: (prior?.snapshot.revision ?? 0) + 1,
        sources: kept.map((record, index) => ({
          id: record.id,
          kind: record.kind,
          path: record.path,
          bytes: record.bytes,
          hash: record.hash,
          order: index,
          sectionCount: record.sections.length,
        })),
        sections: kept.flatMap(record => record.sections.map(section => ({ ...section, order: order++ }))),
        diagnostics,
      }
    }
    const state: IndexState = { snapshot, records: loaded, signature, listings, refresh: ++this.committed }
    // Re-inserting keeps the Map in least-recently-used order.
    this.states.delete(directory)
    this.states.set(directory, state)
    const served = this.served.get(directory)
    if (served !== undefined && snapshot !== prior?.snapshot) {
      const present = new Set(snapshot.sections.map(section => section.id))
      for (const id of served.keys()) if (!present.has(id)) served.delete(id)
    }
    for (const oldest of this.states.keys()) {
      if (this.states.size <= this.config.maxIndexedDirectories) break
      this.states.delete(oldest)
      this.served.delete(oldest)
    }
    return state
  }

  /** Keep an operation in the disposal drain until it settles. */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.inflight.add(operation)
    const done = (): void => { this.inflight.delete(operation) }
    operation.then(done, done)
    return operation
  }

  private async shutdown(): Promise<void> {
    this.lifetime.abort(new ContextIndexError('context index disposed', 'CONTEXT_INDEX_DISPOSED'))
    await Promise.allSettled([...this.inflight])
    this.flights.clear()
    this.states.clear()
    this.served.clear()
  }
}

export default ContextIndexService
