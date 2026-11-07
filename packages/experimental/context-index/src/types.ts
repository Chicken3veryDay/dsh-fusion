/**
 * Browser-safe types for the experimental context index: addressable sections of
 * instruction files and documentation, bounded reads, and compact catalogs.
 *
 * @module @deepseek-ai/dsh-experimental-context-index/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one indexed source file, derived from its kind and display path. */
export type ContextSourceId = Branded<'ContextSourceId'>

/** Stable identity of one section, derived from its source, heading path, and part number; never from content. */
export type ContextSectionId = Branded<'ContextSectionId'>

/**
 * Where a source comes from. `user-instructions` are the user-global files,
 * `project-instructions` the project-root-to-working-directory chain, and `doc`
 * the Markdown files under the configured documentation roots.
 */
export type ContextSourceKind = 'user-instructions' | 'project-instructions' | 'doc'

/** The working directory whose sources one index covers. */
export interface ContextIndexScope {
  /** Absolute path of the working directory; relative paths are rejected. */
  readonly workingDirectory: string
}

/** Metadata of one indexed source file. */
export interface ContextSourceMeta {
  readonly id: ContextSourceId
  readonly kind: ContextSourceKind
  /**
   * Model-facing path: `$DSH_HOME/AGENTS.md`-style for user-global files,
   * project-root-relative for project instructions, working-directory-relative
   * for documentation. Always uses `/` separators.
   */
  readonly path: string
  /** UTF-8 byte size of the file. */
  readonly bytes: number
  /** `sha256:` digest of the file bytes. */
  readonly hash: string
  /** Position in discovery order; a larger value is more specific and takes precedence among instructions. */
  readonly order: number
  /** Number of sections the file contributes. */
  readonly sectionCount: number
}

/** Metadata of one addressable section; the body is read separately. */
export interface ContextSectionMeta {
  readonly id: ContextSectionId
  readonly sourceId: ContextSourceId
  readonly kind: ContextSourceKind
  /** Display path of the owning source. */
  readonly path: string
  /** Enclosing headings from the outermost to this section's own heading; empty for text before the first heading. */
  readonly headingPath: readonly string[]
  /** `path#Heading > Subheading`, or just `path` for text before the first heading; headings are shortened to `maxHeadingBytes`. */
  readonly anchor: string
  /** Heading level 1–6, or 0 for text before the first heading. */
  readonly level: number
  /** 1-based part number of an oversized section split at paragraph boundaries; 1 when the section is not split. */
  readonly part: number
  /** Number of parts this section was split into. */
  readonly partCount: number
  /** UTF-8 byte size of the section text. */
  readonly bytes: number
  /** `sha256:` digest of the section text; changes whenever the text changes, while `id` stays. */
  readonly hash: string
  /** Position in the snapshot's section list. */
  readonly order: number
}

/** Why a file or directory is absent from the index although it exists or was expected. */
export type ContextDiagnosticCode =
  | 'unreadable'
  | 'too-large'
  | 'not-utf8'
  | 'limit-exceeded'
  | 'directory-unreadable'

/** A typed report about a file or directory the index could not use. */
export interface ContextDiagnostic {
  readonly code: ContextDiagnosticCode
  /** Display path of the affected file or directory. */
  readonly path: string
  readonly message: string
}

/** Section metadata of one working directory; contains no section bodies. */
export interface ContextIndexSnapshot {
  readonly scope: ContextIndexScope
  /** Increases whenever a source is added, removed, or changed or a diagnostic changes; unchanged refreshes return the same snapshot. */
  readonly revision: number
  readonly sources: readonly ContextSourceMeta[]
  readonly sections: readonly ContextSectionMeta[]
  readonly diagnostics: readonly ContextDiagnostic[]
}

/** The snapshot a refresh committed, with that refresh's ordinal; see `ContextIndexService.latest`. */
export interface ContextIndexRefresh {
  readonly snapshot: ContextIndexSnapshot
  /** Ordinal of the committing refresh across every working directory; compare with `refreshes()`. */
  readonly refresh: number
}

/** Byte bound for one {@link ContextReadResult}; values above the configured ceiling are lowered to it. */
export interface ContextReadBudget {
  /** Total UTF-8 bytes of returned section text; defaults to the configured `maxReadBytes`. */
  readonly maxBytes?: number
}

/** One section body returned by a read. */
export interface ContextSectionBody {
  readonly id: ContextSectionId
  readonly path: string
  readonly anchor: string
  /** `sha256:` digest of the complete section text, even when `text` is truncated. */
  readonly hash: string
  /** UTF-8 byte size of the complete section text. */
  readonly totalBytes: number
  /** UTF-8 byte size of `text`. */
  readonly bytes: number
  /** True when `text` is a prefix of the complete section text. */
  readonly truncated: boolean
  /** The section text, cut at a character boundary when truncated. */
  readonly text: string
}

/** Bodies for the requested ids within a byte budget. */
export interface ContextReadResult {
  /** Revision of the index the ids were resolved against. */
  readonly revision: number
  /** Bodies in request order; the last may be truncated. */
  readonly sections: readonly ContextSectionBody[]
  /** Requested ids the index does not contain, in request order. */
  readonly missing: readonly ContextSectionId[]
  /** Requested ids left out because the budget was exhausted, in request order. */
  readonly omitted: readonly ContextSectionId[]
  /** Sum of `bytes` over `sections`. */
  readonly usedBytes: number
  /** The effective byte bound that applied. */
  readonly maxBytes: number
  /** Diagnostics of the index at read time. */
  readonly diagnostics: readonly ContextDiagnostic[]
}

/** Byte bound for a rendered catalog; values above the configured ceiling are lowered to it. */
export interface ContextCatalogBudget {
  /** UTF-8 bytes of the complete rendered text; defaults to the configured `maxCatalogBytes`. */
  readonly maxBytes?: number
}

/** A compact model-facing listing of sections. */
export interface ContextCatalog {
  /** Header, one line per listed section, and a final line counting unlisted sections; empty when not even the header fits. */
  readonly text: string
  /** UTF-8 byte size of `text`. */
  readonly bytes: number
  /** Sections listed in `text`. */
  readonly included: number
  /** Sections not listed. */
  readonly omitted: number
  /** The effective byte bound that applied. */
  readonly maxBytes: number
}

/**
 * Index configuration. Every field has a working default, so no configuration is required.
 * Misconfigured values make the service fail at mount.
 */
export interface Config {
  /** Directory entries that mark the project root while walking up from the working directory (default `['.git']`). */
  projectRootMarkers?: string[]
  /** Same-directory instruction file names, all indexed (default `['AGENTS.md', 'CLAUDE.md']`, as agent-instructions). */
  instructionFileCandidates?: string[]
  /** Same-directory local overlay names, indexed after the base files (default `['AGENTS.local.md', 'CLAUDE.local.md']`). */
  localInstructionFileCandidates?: string[]
  /** Working-directory-relative documentation roots (default `['docs', 'doc']`). */
  docRoots?: string[]
  /** Case-insensitive extensions of documentation files (default `['.md', '.markdown']`). */
  docExtensions?: string[]
  /** Largest source file in UTF-8 bytes; larger files get a `too-large` diagnostic (default 1,048,576, as agent-instructions). */
  maxSourceBytes?: number
  /** Largest section body in UTF-8 bytes before it is split at paragraph boundaries (default 8,192). */
  maxSectionBytes?: number
  /** Longest heading text shown in an anchor, in UTF-8 bytes (default 120). */
  maxHeadingBytes?: number
  /** Most documentation files per working directory (default 1,024). */
  maxDocFiles?: number
  /** Deepest documentation directory level below a root (default 8). */
  maxDocDepth?: number
  /** Total UTF-8 bytes of all sources per working directory (default 16,777,216). */
  maxTotalSourceBytes?: number
  /** Ceiling and default for a read's byte budget (default 65,536, the agent-instructions chain budget). */
  maxReadBytes?: number
  /** Ceiling and default for a catalog's byte budget (default 8,192). */
  maxCatalogBytes?: number
  /** Working directories kept in memory; the least recently used is evicted (default 16). */
  maxIndexedDirectories?: number
}
