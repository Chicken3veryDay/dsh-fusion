/** Source discovery over the filesystem service, bounded reads, and per-source sectioning. */
import { dirname, join, relative } from 'node:path'
import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import { toPosix, type ResolvedConfig } from './config.ts'
import { contentHash, deriveSectionId, deriveSourceId } from './ids.ts'
import { byteLength, sectionize, shortenHeading } from './text.ts'
import type {
  ContextDiagnostic,
  ContextSectionId,
  ContextSectionMeta,
  ContextSourceId,
  ContextSourceKind,
} from './types.ts'

const USER_GLOBAL_FILE = 'AGENTS.md'
const USER_GLOBAL_GROUP = 'user-global'

/** A file that exists and may be read, with the metadata observed while discovering it. */
export interface Candidate {
  readonly kind: ContextSourceKind
  readonly path: string
  /** Candidates of one group collapse when their trimmed content is identical; the earliest wins. */
  readonly group: string | undefined
  readonly target: FsTarget
  readonly version: FsVersion
  readonly size: number | undefined
}

/**
 * How long a directory's version must stay unchanged before a listing taken under it is trusted
 * without listing again. Filesystem timestamps are coarse (FAT stores modification times in 2-second
 * steps), so an entry added in the same timestamp step as a listing leaves the directory's version
 * unchanged; listing once more after this interval sees it.
 */
export const LISTING_SETTLE_MS = 2_000

/** One child of a listed directory, without the metadata that goes stale while the directory is unchanged. */
export interface ListedEntry {
  readonly name: string
  readonly type: FsDirEntry['type']
  readonly target: FsTarget
}

/** A documentation directory listing kept between refreshes and reused while the directory's version is unchanged. */
export interface Listing {
  /** Version of the directory observed before the listing was taken. */
  readonly version: FsVersion
  /** Children in name order. */
  readonly entries: readonly ListedEntry[]
  /** `performance.now()` when the listing was taken. */
  readonly listedAt: number
  /**
   * The directory already had `version` at least {@link LISTING_SETTLE_MS} before this listing, so no
   * later change can share that version; an unsettled listing is reused only within that interval.
   */
  readonly settled: boolean
}

/** Candidates in precedence order, what could not be probed, and the documentation listings used. */
export interface Discovery {
  readonly candidates: Candidate[]
  readonly diagnostics: ContextDiagnostic[]
  /** Listings by directory target key, for the next discovery of the same working directory. */
  readonly listings: ReadonlyMap<string, Listing>
}

/** Section metadata before the snapshot assigns `order`. */
export type SectionDraft = Omit<ContextSectionMeta, 'order'>

/** An indexed file together with what is needed to revalidate and read it again. */
export interface SourceRecord {
  readonly id: ContextSourceId
  readonly kind: ContextSourceKind
  readonly path: string
  readonly group: string | undefined
  readonly target: FsTarget
  readonly version: FsVersion
  readonly bytes: number
  readonly hash: string
  readonly trimmedHash: string
  readonly sections: readonly SectionDraft[]
}

function isAbsent(error: unknown): boolean {
  return error instanceof FsError && (error.code === 'FS_NOT_FOUND' || error.code === 'FS_NOT_DIRECTORY')
}

function describe(error: unknown): string {
  const text = error instanceof FsError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 197)}...` : text
}

/** Stat result: a target, absence, or the failure that prevented knowing. */
type Probe =
  | { kind: 'present'; target: FsTarget; type: 'file' | 'directory' | 'other'; version: FsVersion; size: number | undefined }
  | { kind: 'absent' }
  | { kind: 'failed'; error: unknown }

async function probe(fs: FileSystem, path: string, signal: AbortSignal): Promise<Probe> {
  try {
    const target = await fs.resolve(path, { signal })
    const info = await fs.stat(target, signal)
    if (info === undefined) return { kind: 'absent' }
    return { kind: 'present', target, type: info.type, version: info.version, size: info.size }
  } catch (error: unknown) {
    signal.throwIfAborted()
    return isAbsent(error) ? { kind: 'absent' } : { kind: 'failed', error }
  }
}

async function findProjectRoot(
  fs: FileSystem,
  cwd: string,
  markers: readonly string[],
  diagnostics: ContextDiagnostic[],
  signal: AbortSignal,
): Promise<string> {
  let current = cwd
  for (;;) {
    for (const marker of markers) {
      const markerPath = join(current, marker)
      const found = await probe(fs, markerPath, signal)
      if (found.kind === 'present') return current
      if (found.kind === 'failed') {
        diagnostics.push({ code: 'unreadable', path: toPosix(markerPath), message: `project root marker probe failed: ${describe(found.error)}` })
      }
    }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = cwd
  while (current !== root) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(root)
  return chain.reverse()
}

async function fileCandidate(
  fs: FileSystem,
  kind: ContextSourceKind,
  absolutePath: string,
  path: string,
  group: string | undefined,
  seen: Set<string>,
  diagnostics: ContextDiagnostic[],
  signal: AbortSignal,
): Promise<Candidate | undefined> {
  const found = await probe(fs, absolutePath, signal)
  if (found.kind === 'failed') {
    diagnostics.push({ code: 'unreadable', path, message: `cannot inspect file: ${describe(found.error)}` })
    return undefined
  }
  if (found.kind === 'absent' || found.type !== 'file') return undefined
  if (seen.has(found.target.targetKey)) return undefined
  seen.add(found.target.targetKey)
  return { kind, path, group, target: found.target, version: found.version, size: found.size }
}

/** A child to visit: from a fresh listing it carries the metadata the listing observed. */
type Visit = ListedEntry & { readonly version?: FsVersion; readonly size?: number }

async function discoverDocs(
  fs: FileSystem,
  config: ResolvedConfig,
  cwd: string,
  seen: Set<string>,
  diagnostics: ContextDiagnostic[],
  prior: ReadonlyMap<string, Listing>,
  signal: AbortSignal,
): Promise<{ candidates: Candidate[]; listings: Map<string, Listing> }> {
  const candidates: Candidate[] = []
  const listings = new Map<string, Listing>()
  const visited = new Set<string>()
  const matches = (name: string): boolean => {
    const lower = name.toLowerCase()
    return config.docExtensions.some(extension => lower.endsWith(extension))
  }
  const limit = { reached: false }
  const inspect = (target: FsTarget, path: string, code: 'unreadable' | 'directory-unreadable'): Promise<FsInfo | undefined> => (
    fs.stat(target, signal).catch((error: unknown) => {
      signal.throwIfAborted()
      diagnostics.push({ code, path, message: `cannot inspect ${code === 'unreadable' ? 'file' : 'directory'}: ${describe(error)}` })
      return undefined
    })
  )
  /** Children of a directory: the kept listing while the directory is unchanged, else a new listing. */
  const childrenOf = async (directory: FsTarget, display: string, version: FsVersion): Promise<readonly Visit[] | undefined> => {
    const kept = prior.get(directory.targetKey)
    const now = performance.now()
    if (kept?.version === version && (kept.settled || now - kept.listedAt < LISTING_SETTLE_MS)) {
      listings.set(directory.targetKey, kept)
      return kept.entries
    }
    let entries: FsDirEntry[]
    try {
      entries = await fs.listDir(directory, signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      diagnostics.push({ code: 'directory-unreadable', path: display, message: `cannot list directory: ${describe(error)}` })
      return undefined
    }
    const sorted = entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    listings.set(directory.targetKey, {
      version,
      entries: sorted.map(({ name, type, target }) => ({ name, type, target })),
      listedAt: now,
      settled: kept?.version === version,
    })
    return sorted
  }
  const walk = async (directory: FsTarget, display: string, depth: number, observed: FsVersion | undefined): Promise<void> => {
    if (visited.has(directory.targetKey)) return
    visited.add(directory.targetKey)
    let version = observed
    if (version === undefined) {
      const info = await inspect(directory, display, 'directory-unreadable')
      if (info?.type !== 'directory') return
      version = info.version
    }
    const children = await childrenOf(directory, display, version)
    if (children === undefined) return
    for (const entry of children) {
      if (limit.reached) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = `${display}/${entry.name}`
      if (entry.type === 'directory') {
        if (depth + 1 > config.maxDocDepth) {
          diagnostics.push({ code: 'limit-exceeded', path, message: `directory is deeper than maxDocDepth (${config.maxDocDepth}) and was not indexed` })
          continue
        }
        await walk(entry.target, path, depth + 1, entry.version)
        continue
      }
      if (entry.type !== 'file' || !matches(entry.name) || seen.has(entry.target.targetKey)) continue
      if (candidates.length >= config.maxDocFiles) {
        diagnostics.push({ code: 'limit-exceeded', path: display, message: `more than maxDocFiles (${config.maxDocFiles}) documentation files; the rest were not indexed` })
        limit.reached = true
        return
      }
      let version = entry.version
      let size = entry.size
      if (version === undefined) {
        // A kept listing has no file versions: an edit changes the file, not its directory.
        const info = await inspect(entry.target, path, 'unreadable')
        if (info?.type !== 'file') continue
        version = info.version
        size = info.size
      }
      seen.add(entry.target.targetKey)
      candidates.push({ kind: 'doc', path, group: undefined, target: entry.target, version, size })
    }
  }
  for (const root of config.docRoots) {
    const found = await probe(fs, join(cwd, ...root.split('/')), signal)
    if (found.kind === 'failed') {
      diagnostics.push({ code: 'directory-unreadable', path: root, message: `cannot inspect documentation root: ${describe(found.error)}` })
    } else if (found.kind === 'present' && found.type === 'directory') {
      await walk(found.target, root, 0, found.version)
    }
    if (limit.reached) break
  }
  return { candidates, listings }
}

/**
 * Find the files to index for one working directory, in precedence order: the
 * user-global files (harness home, then shared agents root), the project chain from
 * the project root to the working directory (each directory: base candidates, then
 * local overlays), then documentation. Discovery matches agent-instructions; it
 * runs over `ctx.fs` instead of the host filesystem so reads stay inside the
 * configured filesystem service.
 * @param fs - the filesystem service.
 * @param config - resolved configuration.
 * @param cwd - absolute working directory.
 * @param listings - documentation listings from the previous discovery of `cwd`; a directory whose
 * version is unchanged is not listed again, but each of its documentation files is still statted.
 * @param signal - cancellation for every probe.
 * @returns present candidates, diagnostics for probes that failed, and the listings to keep.
 */
export async function discoverCandidates(
  fs: FileSystem,
  config: ResolvedConfig,
  cwd: string,
  listings: ReadonlyMap<string, Listing>,
  signal: AbortSignal,
): Promise<Discovery> {
  const diagnostics: ContextDiagnostic[] = []
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  const add = (candidate: Candidate | undefined): void => {
    if (candidate !== undefined) candidates.push(candidate)
  }
  for (const root of [
    { home: config.dshHome, display: config.dshHomeDisplay },
    { home: config.agentsHome, display: config.agentsHomeDisplay },
  ]) {
    add(await fileCandidate(
      fs,
      'user-instructions',
      join(root.home, USER_GLOBAL_FILE),
      `${root.display}/${USER_GLOBAL_FILE}`,
      USER_GLOBAL_GROUP,
      seen,
      diagnostics,
      signal,
    ))
  }
  const projectRoot = await findProjectRoot(fs, cwd, config.projectRootMarkers, diagnostics, signal)
  for (const directory of ancestorChain(projectRoot, cwd)) {
    for (const names of [config.instructionFileCandidates, config.localInstructionFileCandidates]) {
      for (const name of names) {
        const absolutePath = join(directory, name)
        add(await fileCandidate(
          fs,
          'project-instructions',
          absolutePath,
          toPosix(relative(projectRoot, absolutePath)),
          `project:${toPosix(relative(projectRoot, directory))}`,
          seen,
          diagnostics,
          signal,
        ))
      }
    }
  }
  const docs = await discoverDocs(fs, config, cwd, seen, diagnostics, listings, signal)
  candidates.push(...docs.candidates)
  return { candidates, diagnostics, listings: docs.listings }
}

/** A source's decoded text with its raw byte size and digest, or the reason it cannot be used. */
export type ReadOutcome =
  | { kind: 'text'; text: string; bytes: number; hash: string }
  | { kind: 'diagnostic'; diagnostic: ContextDiagnostic }

/**
 * Read one file through the filesystem service under the source size bound and decode it as UTF-8.
 * @param fs - the filesystem service.
 * @param target - file to read.
 * @param path - display path used in diagnostics.
 * @param size - size observed while discovering the file, when known.
 * @param maxSourceBytes - inclusive bound on the file size.
 * @param signal - cancellation.
 * @returns the text, or a typed diagnostic; cancellation throws its reason.
 */
export async function readSource(
  fs: FileSystem,
  target: FsTarget,
  path: string,
  size: number | undefined,
  maxSourceBytes: number,
  signal: AbortSignal,
): Promise<ReadOutcome> {
  const diagnostic = (code: ContextDiagnostic['code'], message: string): ReadOutcome => ({ kind: 'diagnostic', diagnostic: { code, path, message } })
  const tooLarge = `file is larger than maxSourceBytes (${maxSourceBytes})`
  signal.throwIfAborted()
  if (size !== undefined && size > maxSourceBytes) return diagnostic('too-large', tooLarge)
  let bytes: Uint8Array
  try {
    bytes = await fs.readBytes(target, signal, maxSourceBytes)
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (error instanceof FsError && error.code === 'FS_TOO_LARGE') return diagnostic('too-large', tooLarge)
    if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return diagnostic('not-utf8', 'file is not UTF-8 text')
    return diagnostic('unreadable', `cannot read file: ${describe(error)}`)
  }
  signal.throwIfAborted()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return diagnostic('not-utf8', 'file is not valid UTF-8 text')
  }
  return { kind: 'text', text, bytes: bytes.byteLength, hash: contentHash(bytes) }
}

function sanitize(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ')
}

/**
 * Split decoded text into section metadata and bodies with stable ids.
 * @param source - owning source id and display path.
 * @param text - decoded file text.
 * @param config - resolved configuration.
 * @returns section metadata (no `order`) with the matching body text, in document order.
 */
export function sectionsOf(
  source: { id: ContextSourceId; kind: ContextSourceKind; path: string },
  text: string,
  config: ResolvedConfig,
): { draft: SectionDraft; text: string }[] {
  const path = sanitize(source.path)
  return sectionize(text, config.maxSectionBytes).map((raw) => {
    const headings = raw.headingPath.map(heading => shortenHeading(sanitize(heading), config.maxHeadingBytes))
    const anchor = headings.length === 0 ? path : `${path}#${headings.join(' > ')}`
    const id: ContextSectionId = deriveSectionId(source.id, raw.headingPath, raw.occurrence, raw.part)
    return {
      text: raw.text,
      draft: {
        id,
        sourceId: source.id,
        kind: source.kind,
        path: source.path,
        headingPath: raw.headingPath,
        anchor,
        level: raw.level,
        part: raw.part,
        partCount: raw.partCount,
        bytes: byteLength(raw.text),
        hash: contentHash(raw.text),
      },
    }
  })
}

/**
 * Build the cached record of a freshly read source.
 * @param candidate - the discovered file.
 * @param read - its decoded text, size, and digest.
 * @param config - resolved configuration.
 * @returns the record with sections.
 */
export function buildRecord(
  candidate: Candidate,
  read: { text: string; bytes: number; hash: string },
  config: ResolvedConfig,
): SourceRecord {
  const id = deriveSourceId(candidate.kind, candidate.path)
  return {
    id,
    kind: candidate.kind,
    path: candidate.path,
    group: candidate.group,
    target: candidate.target,
    version: candidate.version,
    bytes: read.bytes,
    hash: read.hash,
    trimmedHash: contentHash(read.text.trim()),
    sections: sectionsOf({ id, kind: candidate.kind, path: candidate.path }, read.text, config).map(section => section.draft),
  }
}
