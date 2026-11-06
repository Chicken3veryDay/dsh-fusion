/**
 * Browser-safe types for the experimental context tree: the browsable tree of
 * instructions, sources, and tools, its load results, and the message sources
 * the service logs.
 *
 * @module @deepseek-ai/dsh-experimental-context-tree/types
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContextSectionId, ContextSourceKind } from '@deepseek-ai/dsh-experimental-context-index/types'
import type { ToolOrigin } from '@deepseek-ai/dsh-tools'

/**
 * Where a registration or file comes from. `global` is user-level or harness-level
 * origin and `project` is this workspace's origin.
 */
export type ContextOrigin = 'global' | 'project'

/** The three top-level branches of the tree, in display order. */
export type ContextRoot = 'Instructions' | 'Sources' | 'Tools'

/** What a tree node stands for. */
export type ContextNodeKind =
  /** The tree root, a branch, or an origin folder. */
  | 'folder'
  /** One instruction or documentation file. */
  | 'source'
  /** One addressable section of a file. */
  | 'section'
  /** A group of related tools. */
  | 'tool-group'
  /** One tool. */
  | 'tool'

/** One node as `context_browse` returns it; the body or schema is not included. */
export interface ContextNodeView {
  /** `/`-separated path accepted by `context_browse` and `context_load`; empty for the root. */
  readonly path: string
  readonly kind: ContextNodeKind
  /** Short name of the node. */
  readonly title: string
  /** One line saying when to use what is under the node. */
  readonly summary: string
  /** Number of direct children. */
  readonly children: number
}

/** A bounded listing of the subtree under one node. */
export interface ContextBrowseResult {
  /** The node that was listed; empty for the root. */
  readonly path: string
  /** Byte-bounded path for display when the full machine-readable path cannot fit. */
  readonly displayPath?: string
  /** The depth that applied, after capping. */
  readonly depth: number
  /** True when the requested depth was lowered to the configured maximum. */
  readonly depthCapped: boolean
  /** Descendants to `depth` levels in tree order, starting at `offset`, cut by the node and byte bounds. */
  readonly nodes: readonly ContextNodeView[]
  /** Descendants to `depth` levels in total. */
  readonly total: number
  /** Position of the first listed node among those descendants. */
  readonly offset: number
  /** Descendants after the listed ones; pass `offset + nodes.length` to continue. */
  readonly remaining: number
}

/** One section whose text a load injected. */
export interface ContextGrantedSection {
  readonly path: string
  readonly anchor: string
  /** UTF-8 bytes of the injected text. */
  readonly bytes: number
  /** True when the text is a prefix of the section because the load budget ended inside it. */
  readonly truncated: boolean
}

/** Tools one load node activated. */
export interface ContextActivation {
  /** The node the caller named. */
  readonly path: string
  /** Tools under the node that were not yet available, in tree order. */
  readonly tools: readonly string[]
}

/** What one `context_load` call did. */
export interface ContextLoadResult {
  readonly granted: readonly ContextGrantedSection[]
  readonly activated: readonly ContextActivation[]
  /** Section paths whose text is already in the conversation with the same hash. */
  readonly alreadyLoaded: readonly string[]
  /** Tools that were already activated by an earlier load. */
  readonly alreadyActive: readonly string[]
  /** Requested paths that name no node. */
  readonly missing: readonly string[]
  /** Section paths left out because the byte bound was reached. */
  readonly omittedSections: readonly string[]
  /** Tools left out because the per-load activation bound was reached. */
  readonly omittedTools: readonly string[]
}

/** Facts about one registered tool that a placement decision may use. */
export interface ToolFacts {
  readonly name: string
  readonly description: string
  /** Origin the registering producer recorded; `unknown` when it recorded none. */
  readonly origin: ToolOrigin
}

/** Where one tool appears in the tree. */
export interface ToolPlacement {
  /** Which origin folder holds the group. */
  readonly origin: ContextOrigin
  /** Group name, a single path segment without `/`. */
  readonly group: string
  /** Group title shown by browse; defaults to the group name. */
  readonly title?: string
  /** One line saying when to use the group; defaults to a listing of its tools. */
  readonly summary?: string
}

/**
 * Decide the placement of one tool. Return `undefined` to leave the decision to later
 * assigners and then to the deterministic default. Opinions conflicting with a recorded origin are ignored.
 * @param tool - name and description of the registered tool.
 * @returns the placement, or `undefined` for no opinion.
 */
export type ToolPlacementAssigner = (tool: ToolFacts) => ToolPlacement | undefined

/** A registration-time statement of where a set of tools belongs. */
export interface ToolGroupHint extends ToolPlacement {
  /** Exact tool names the hint covers. */
  readonly names?: readonly string[]
  /** Name prefix the hint covers. */
  readonly prefix?: string
}

/**
 * A curated group: a named folder of sections or tools that a curator placed in the tree. A group
 * under `Instructions` or `Sources` holds sections and replaces the file nodes for them; a group
 * under `Tools` holds tool names and acts as a placement for them.
 */
export interface CuratedGroup {
  /** Top-level branch the group sits under. */
  readonly root: ContextRoot
  /** Origin folder the group sits under. */
  readonly origin: ContextOrigin
  /** Group name, a single path segment without `/`. */
  readonly name: string
  /** Title shown by browse. */
  readonly title: string
  /** One line saying when to use the group. */
  readonly summary: string
  /** Member sections; used only under `Instructions` and `Sources`. */
  readonly sections: readonly ContextSectionId[]
  /** Member tool names; used only under `Tools`. */
  readonly tools: readonly string[]
}

/**
 * Supply the curated groups that apply to one agent.
 * @param agent - the agent whose tree is built.
 * @returns the groups; ones that name a missing section, tool, or a mismatched origin are skipped.
 */
export type CuratedGroupProvider = (agent: Agent) => readonly CuratedGroup[]

/**
 * Supply the sections that stay loaded up front for one agent.
 * @param agent - the agent about to take a step.
 * @returns section ids in priority order.
 */
export type EagerCoreProvider = (agent: Agent) => readonly ContextSectionId[]

/** Section grant message source; revocable at compaction. */
export interface ContextGrantSource {
  readonly kind: 'context-grant'
  readonly form: 'instructions'
  /** Section id; stubs for equal keys collapse. */
  readonly key: string
  /** Tree path the section was loaded from. */
  readonly path: string
  /** Anchor of the section, `file#Heading > Subheading`. */
  readonly anchor: string
  /** Where the file comes from. */
  readonly sourceKind: ContextSourceKind
  /** `sha256:` digest of the whole section at load time. */
  readonly hash: string
  /** True when the injected text is a prefix of the section. */
  readonly truncated?: true
  /** Bytes charged to the eager-core budget until revocation; zero for explicit loads, absent in earlier records. */
  readonly coreBytes?: number
}

/** Tool activation message source; revocable at compaction. */
export interface ContextActivationSource {
  readonly kind: 'context-activation'
  readonly form: 'notice'
  /** One-line account shown by clients. */
  readonly summary: string
  /** Digest of the activated tool names. */
  readonly key: string
  /** Nodes the caller named. */
  readonly nodes: readonly string[]
  /** Tools activated by this message, in tree order. */
  readonly tools: readonly string[]
}

/** Tree catalog message source; republished when it is no longer in the conversation. */
export interface ContextCatalogSource {
  readonly kind: 'context-tree-catalog'
  readonly form: 'catalog'
  /** Marks a republication after the earlier catalog left the conversation. */
  readonly update?: true
  /** Digest of the listed branches. */
  readonly digest: string
  /** Paths of the non-empty origin folders the catalog lists, in order. */
  readonly branches: readonly string[]
}

/**
 * Context tree configuration. Every field has a working default, so no configuration is
 * required. Misconfigured values make the service fail at mount.
 */
export interface Config {
  /** Tools that are always exposed and never appear in the tree; names that are not registered are absent. */
  baseTools?: string[]
  /** Deepest `depth` a browse may ask for; larger requests are lowered to it (default 3). */
  maxBrowseDepth?: number
  /** Most nodes one browse lists (default 64). */
  maxBrowseNodes?: number
  /** UTF-8 bytes of the rendered browse listing (default 8,192). */
  maxBrowseBytes?: number
  /** Most paths one load accepts (default 16). */
  maxLoadPaths?: number
  /** UTF-8 bytes of section text one load injects (default 32,768). */
  maxLoadBytes?: number
  /** Most tools one load activates (default 32). */
  maxActivatedTools?: number
  /** Longest summary line a node shows, in UTF-8 bytes (default 160). */
  maxSummaryBytes?: number
  /** UTF-8 bytes of the dropped-by-compaction list a republished catalog carries (default 1,024). */
  maxDroppedBytes?: number
  /** UTF-8 bytes of eager-core section text granted before the first step and after each compaction (default 4,096). */
  coreBytes?: number
}
