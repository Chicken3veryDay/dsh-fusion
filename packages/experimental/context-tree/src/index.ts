/**
 * Experimental context tree: one browsable tree of instructions, sources, and tools that an
 * agent loads from on demand.
 *
 * `ctx.contextTree` builds the tree from `ctx.contextIndex` sections and the registered tools,
 * logs every catalog, section grant, and tool activation as a message, hides tools that have
 * not been loaded through a tool admission policy, and registers its messages as revocable so
 * compaction drops them and the catalog is published again. It makes no model calls.
 *
 * @module @deepseek-ai/dsh-experimental-context-tree
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { orderedAdmission } from '@deepseek-ai/dsh-tools'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { ContextSectionId, ContextSectionMeta } from '@deepseek-ai/dsh-experimental-context-index/types'
import '@deepseek-ai/dsh-experimental-context-index'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-compaction'
import { ConfigSchema, resolveConfig, type ResolvedConfig } from './config.ts'
import { ContextTreeError } from './error.ts'
import {
  activationMessage,
  activationStub,
  catalogDigest,
  catalogMessage,
  grantMessage,
  grantStub,
  type CatalogBranch,
} from './messages.ts'
import { formatPath, parsePath, splitPath } from './paths.ts'
import { byteLength, clip } from './text.ts'
import {
  activeToolNames,
  contextTreeProjectionDefinition,
  grantedHashes,
  type ContextTreeProjectionState,
} from './projection.ts'
import { browseFooter, browseHeader, browseLine, listingBytes } from './render.ts'
import { buildTree, findNode, isEmptyBranch, leavesOf, viewOf, type ContextTree, type TreeNode } from './tree.ts'
import type {
  Config,
  ContextActivation,
  ContextBrowseResult,
  ContextGrantedSection,
  ContextLoadResult,
  CuratedGroupProvider,
  EagerCoreProvider,
  ToolFacts,
  ToolGroupHint,
  ToolPlacementAssigner,
} from './types.ts'

export { ContextTreeError } from './error.ts'
export type { ContextTreeErrorCode } from './error.ts'
export { ContextTreeTools } from './tools.ts'
export { DEFAULT_BASE_TOOLS } from './config.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextTree: ContextTreeService
  }
}

/** A load request: the paths to load. */
export interface ContextLoadRequest {
  readonly paths: readonly string[]
}

/** A browse request. */
export interface ContextBrowseRequest {
  /** Node to list; omitted or empty lists from the root. */
  readonly path?: string
  /** Levels to list below the node (default 1), lowered to the configured maximum. */
  readonly depth?: number
  /** Descendants to skip before listing (default 0). */
  readonly offset?: number
}

/** The messages a load wants logged and the report for the model. */
export interface ContextLoadOutcome {
  /** Section grants first, then at most one activation message; the caller logs them in order. */
  readonly contexts: readonly UserMessage[]
  readonly result: ContextLoadResult
}

/** Service that builds the context tree and loads from it. */
export class ContextTreeService extends Service {
  static inject = ['tools', 'compaction', 'contextIndex', 'sessionProjections', 'workingDirectory']
  static Config: z<Config> = ConfigSchema

  private readonly config: ResolvedConfig
  private readonly baseTools: ReadonlySet<string>
  private readonly assigners = new Set<ToolPlacementAssigner>()
  private readonly groupProviders = new Set<CuratedGroupProvider>()
  private readonly coreProviders = new Set<EagerCoreProvider>()
  private readonly managed = new Set<{ readonly names: ReadonlySet<string>; readonly admit: (agent: Agent) => boolean }>()
  private projection!: ProjectionHandle<ContextTreeProjectionState>
  private disposed = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'contextTree')
    this.config = resolveConfig(config)
    this.baseTools = new Set(this.config.baseTools)
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(contextTreeProjectionDefinition)
    this.ctx.effect(() => () => { this.disposed = true }, 'contextTree.runtime()')
    this.ctx.compaction.registerRevocableSource('context-grant', grantStub)
    this.ctx.compaction.registerRevocableSource('context-activation', activationStub)
    this.ctx.tools.registerAdmissionPolicy(({ agent, candidates }) => {
      // Base tools keep registration order; activations follow in logged order. Role tools append
      // after activations so gaining a role preserves the existing declaration prefix.
      const base = [...candidates.keys()].filter(name => this.baseTools.has(name))
      const managed = [...candidates.keys()].filter(name => !this.baseTools.has(name) && this.managedAdmits(name, agent))
      const activated = [...activeToolNames(this.stateFor(agent))]
        .filter(name => candidates.has(name) && !this.baseTools.has(name) && !managed.includes(name))
      return orderedAdmission([...base, ...activated, ...managed])
    })
    this.ctx.on('agent/pre-step', async ({ agent, signal, step }, next): Promise<PreStepDecision> => {
      const decision = await next()
      // A first step with nothing claimed is a turn that makes no request; it must stay one.
      if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) return decision
      if (decision.messages.some(message => message.source.kind === 'context-tree-catalog')) return decision
      if (this.ctx.tools.get('context_browse', agent) === undefined) return decision
      const catalog = await this.pendingCatalog(agent, signal)
      const core = await this.pendingCore(agent, signal)
      const added = [...catalog === undefined ? [] : [catalog], ...core]
      return added.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...added] }
    })
    this.ctx.on('system-prompt/request-context', async ({ agent, signal }, pending, next): Promise<UserMessage[]> => {
      const messages = await next()
      if (agent === undefined || signal === undefined) return messages
      if (this.ctx.tools.get('context_browse', agent) === undefined) return messages
      const catalog = await this.pendingCatalog(agent, signal)
      const core = await this.pendingCore(agent, signal)
      const added = [...catalog === undefined ? [] : [catalog], ...core]
      return [...messages, ...added.filter(message => ![...pending, ...messages].some(existing =>
        existing.source.kind === message.source.kind && JSON.stringify(existing.content) === JSON.stringify(message.content)))]
    })
  }

  /**
   * Say where a set of tools belongs in the tree. A registration made through the caller's
   * context lasts as long as that context.
   * @param hint - tool names or a name prefix, plus origin and group.
   * @returns the disposer.
   * @throws {@link ContextTreeError} `CONTEXT_TREE_INVALID_INPUT` for a hint that covers nothing or has an unusable group.
   */
  registerToolGroup(hint: ToolGroupHint): () => Promise<void> {
    if ((hint.names === undefined || hint.names.length === 0) && (hint.prefix === undefined || hint.prefix === '')) {
      throw new ContextTreeError('a tool group hint needs names or a prefix', 'CONTEXT_TREE_INVALID_INPUT')
    }
    if (hint.group === '' || hint.group.includes('/')) {
      throw new ContextTreeError(`tool group "${hint.group}" must be a non-empty name without "/"`, 'CONTEXT_TREE_INVALID_INPUT')
    }
    const names = new Set(hint.names ?? [])
    const { origin, group, title, summary, prefix } = hint
    return this.registerToolPlacement(tool => (
      names.has(tool.name) || (prefix !== undefined && prefix !== '' && tool.name.startsWith(prefix))
        ? { origin, group, ...title === undefined ? {} : { title }, ...summary === undefined ? {} : { summary } }
        : undefined
    ))
  }

  /**
   * Decide where tools appear in the tree. Assigners run in registration order and the first
   * opinion wins; tools nobody places go under Global, grouped by name. A later curator
   * registers here to regroup tools.
   * @param assigner - decision for one tool; must be pure and cheap, because it runs on every browse and step.
   * @returns the disposer.
   */
  registerToolPlacement(assigner: ToolPlacementAssigner): () => Promise<void> {
    return this.ctx.effect(() => {
      this.assigners.add(assigner)
      return () => { this.assigners.delete(assigner) }
    }, 'contextTree.registerToolPlacement()')
  }

  /**
   * Let a curator place sections and tools in the tree. Groups apply to the agent the provider is
   * asked about; sections in a group leave their file node and tools in a group are placed by the
   * same first-opinion-wins rule as {@link registerToolPlacement}, ahead of the other assigners.
   * @param provider - the groups for one agent; must be pure and cheap, because it runs on every browse and step.
   * @returns the disposer.
   */
  registerCuratedGroups(provider: CuratedGroupProvider): () => Promise<void> {
    return this.ctx.effect(() => {
      this.groupProviders.add(provider)
      return () => { this.groupProviders.delete(provider) }
    }, 'contextTree.registerCuratedGroups()')
  }

  /**
   * Name sections that are granted before a step and again after each compaction, within the
   * `coreBytes` budget. Sections the conversation already holds are not granted twice.
   * @param provider - the section ids for one agent, in priority order.
   * @returns the disposer.
   */
  registerEagerCore(provider: EagerCoreProvider): () => Promise<void> {
    return this.ctx.effect(() => {
      this.coreProviders.add(provider)
      return () => { this.coreProviders.delete(provider) }
    }, 'contextTree.registerEagerCore()')
  }

  /**
   * Take tools out of the tree and admit them by a role check instead of by loading. The named
   * tools never appear as nodes, and the admission policy keeps them for agents `admit` accepts.
   * The registrant stays responsible for refusing other callers when the tool runs.
   * @param names - tool names the registrant owns.
   * @param admit - whether the agent may see the tools on this step.
   * @returns the disposer.
   */
  registerManagedTools(names: Iterable<string>, admit: (agent: Agent) => boolean): () => Promise<void> {
    const entry = { names: new Set(names), admit }
    return this.ctx.effect(() => {
      this.managed.add(entry)
      return () => { this.managed.delete(entry) }
    }, 'contextTree.registerManagedTools()')
  }

  /**
   * Whether a tool is always exposed.
   * @param name - tool name.
   * @returns true for a configured base tool.
   */
  isBaseTool(name: string): boolean {
    return this.baseTools.has(name)
  }

  /**
   * Tools the conversation has activated and not yet lost to compaction.
   * @param agent - the agent.
   * @returns the names, in log order.
   */
  activeTools(agent: Agent): ReadonlySet<string> {
    return activeToolNames(this.stateFor(agent))
  }

  /**
   * Tools shown under Global only because neither an assigner nor the registry recorded their origin.
   * @param agent - the agent whose tool view applies.
   * @param signal - cancellation.
   * @returns their names, in registration order.
   */
  async unresolvedToolOrigins(agent: Agent, signal?: AbortSignal): Promise<readonly string[]> {
    return (await this.treeFor(agent, signal)).unresolvedOrigin
  }

  /**
   * List the subtree under a node: titles and summaries only.
   * @param agent - the browsing agent.
   * @param request - path, depth, and offset.
   * @param signal - cancellation.
   * @returns a listing within the node and byte bounds.
   * @throws {@link ContextTreeError} `CONTEXT_TREE_INVALID_INPUT` for an unknown path or a depth or offset that is not a valid integer.
   */
  async browse(agent: Agent, request: ContextBrowseRequest = {}, signal?: AbortSignal): Promise<ContextBrowseResult> {
    const requested = request.depth ?? 1
    const offset = request.offset ?? 0
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new ContextTreeError(`depth must be a positive integer, got ${String(requested)}`, 'CONTEXT_TREE_INVALID_INPUT')
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ContextTreeError(`offset must be a non-negative integer, got ${String(offset)}`, 'CONTEXT_TREE_INVALID_INPUT')
    }
    const depth = Math.min(requested, this.config.maxBrowseDepth)
    const tree = await this.treeFor(agent, signal)
    const requestedPath = request.path ?? ''
    const start = findNode(tree, parsePath(requestedPath))
    if (start === undefined) {
      throw new ContextTreeError(`no node at "${requestedPath}"; browse its parent to see the valid paths`, 'CONTEXT_TREE_INVALID_INPUT')
    }
    const all: TreeNode[] = []
    const collect = (current: TreeNode, level: number): void => {
      for (const child of current.children) {
        all.push(child)
        if (level < depth) collect(child, level + 1)
      }
    }
    collect(start, 1)
    const path = formatPath(start.segments)
    const capped = requested > depth
    const footer = browseFooter(0, offset, Math.max(0, all.length - offset))
    const framing = listingBytes(browseHeader('', depth, capped), [], footer)
    const displayPath = clip(path, Math.max(3, this.config.maxBrowseBytes - framing))
    const header = browseHeader(displayPath, depth, capped)
    const nodes = []
    const lines: string[] = []
    for (const candidate of all.slice(offset)) {
      if (nodes.length >= this.config.maxBrowseNodes) break
      const view = viewOf(candidate)
      const remaining = all.length - offset - nodes.length - 1
      const next = [...lines, browseLine(view)]
      if (listingBytes(header, next, browseFooter(nodes.length + 1, offset, remaining)) > this.config.maxBrowseBytes) break
      nodes.push(view)
      lines.push(browseLine(view))
    }
    return {
      path,
      ...displayPath === path ? {} : { displayPath },
      depth,
      depthCapped: capped,
      nodes,
      total: all.length,
      offset,
      remaining: Math.max(0, all.length - offset - nodes.length),
    }
  }

  /**
   * Resolve a load into the messages to log. Nothing is logged here: the caller appends
   * `contexts` in order, and the next step's admission sees the activations.
   * @param agent - the loading agent.
   * @param request - paths from a browse.
   * @param signal - cancellation.
   * @returns section grant messages, at most one activation message, and the report.
   * @throws {@link ContextTreeError} `CONTEXT_TREE_INVALID_INPUT` for no paths or more than `maxLoadPaths`.
   */
  async load(agent: Agent, request: ContextLoadRequest, signal?: AbortSignal): Promise<ContextLoadOutcome> {
    if (request.paths.length === 0 || request.paths.length > this.config.maxLoadPaths) {
      throw new ContextTreeError(`paths must hold 1 to ${this.config.maxLoadPaths} entries, got ${request.paths.length}`, 'CONTEXT_TREE_INVALID_INPUT')
    }
    const tree = await this.treeFor(agent, signal)
    const state = this.stateFor(agent)
    const active = activeToolNames(state)
    const allLeaves = leavesOf(tree.root)
    const missing: string[] = []
    const sectionNodes = new Map<ContextSectionId, { node: TreeNode; section: ContextSectionMeta }>()
    const toolOwners = new Map<string, string>()
    for (const raw of request.paths) {
      const segments = splitPath(raw)
      const found = segments === undefined || segments.length === 0 ? undefined : findNode(tree, segments)
      if (found !== undefined) {
        const leaves = leavesOf(found)
        for (const leaf of leaves.sections) if (!sectionNodes.has(leaf.section.id)) sectionNodes.set(leaf.section.id, leaf)
        for (const leaf of leaves.tools) if (!toolOwners.has(leaf.tool)) toolOwners.set(leaf.tool, formatPath(found.segments))
        continue
      }
      const identity = segments?.at(-1)
      const section = allLeaves.sections.find(leaf => leaf.section.id === identity)
      if (section !== undefined) {
        sectionNodes.set(section.section.id, section)
        continue
      }
      const names = new Set([
        ...allLeaves.tools.filter(leaf => leaf.tool === identity && (segments?.length === 1 || segments?.[0] === 'Tools')).map(leaf => leaf.tool),
        ...state.activations.filter(entry => entry.nodes.includes(raw)).flatMap(entry => entry.tools),
        ...state.dropped.filter(entry => entry.paths.includes(raw)).flatMap(entry => entry.tools),
      ])
      const tools = allLeaves.tools.filter(leaf => names.has(leaf.tool))
      if (tools.length === 0) missing.push(raw)
      for (const leaf of tools) if (!toolOwners.has(leaf.tool)) toolOwners.set(leaf.tool, raw)
    }

    const held = grantedHashes(state)
    const alreadyLoaded: string[] = []
    const toRead: ContextSectionId[] = []
    for (const [id, leaf] of sectionNodes) {
      if (held.get(id) === leaf.section.hash) alreadyLoaded.push(formatPath(leaf.node.segments))
      else toRead.push(id)
    }
    const contexts: UserMessage[] = []
    const granted: ContextGrantedSection[] = []
    const omittedSections: string[] = []
    if (toRead.length > 0) {
      const read = await this.ctx.contextIndex.read(
        { workingDirectory: await this.ctx.workingDirectory.ensure(agent, signal) },
        toRead,
        { maxBytes: this.config.maxLoadBytes },
        signal,
      )
      for (const body of read.sections) {
        const leaf = sectionNodes.get(body.id)
        if (leaf === undefined) continue
        const path = formatPath(leaf.node.segments)
        contexts.push(grantMessage(path, body, leaf.section.kind))
        granted.push({ path, anchor: body.anchor, bytes: body.bytes, truncated: body.truncated })
      }
      for (const id of [...read.omitted]) omittedSections.push(formatPath(sectionNodes.get(id)?.node.segments ?? [id]))
      for (const id of read.missing) missing.push(formatPath(sectionNodes.get(id)?.node.segments ?? [id]))
    }

    const alreadyActive: string[] = []
    const newTools: { name: string; path: string }[] = []
    const omittedTools: string[] = []
    for (const [name, path] of toolOwners) {
      if (active.has(name)) alreadyActive.push(name)
      else if (newTools.length < this.config.maxActivatedTools) newTools.push({ name, path })
      else omittedTools.push(name)
    }
    const activated: ContextActivation[] = []
    if (newTools.length > 0) {
      const byPath = new Map<string, string[]>()
      for (const { name, path } of newTools) byPath.set(path, [...byPath.get(path) ?? [], name])
      for (const [path, tools] of byPath) activated.push({ path, tools })
      contexts.push(activationMessage(activated.map(entry => entry.path), newTools.map(tool => tool.name)))
    }
    return {
      contexts,
      result: { granted, activated, alreadyLoaded, alreadyActive, missing, omittedSections, omittedTools },
    }
  }

  /** Intersect logged candidates with the Session-owned current surface; queued grants remain eligible. */
  private stateFor(agent: Agent): ContextTreeProjectionState {
    const state = this.projection.stateOf(agent.session)
    const visible = new Set<number>(agent.session.surface.nodes)
    return {
      ...state,
      grants: state.grants.filter(entry => visible.has(entry.seq)),
      activations: state.activations.filter(entry => visible.has(entry.seq)),
      catalog: state.catalog !== null && visible.has(state.catalog.seq) ? state.catalog : null,
    }
  }

  private async treeFor(agent: Agent, signal: AbortSignal | undefined): Promise<ContextTree> {
    if (this.disposed) throw new ContextTreeError('context tree disposed', 'CONTEXT_TREE_DISPOSED')
    const snapshot = await this.ctx.contextIndex.snapshot(
      { workingDirectory: await this.ctx.workingDirectory.ensure(agent, signal) },
      signal,
    )
    const groups = [...this.groupProviders].flatMap(provider => provider(agent))
    const toolGroups = groups.filter(group => group.root === 'Tools')
    const groupAssigner: ToolPlacementAssigner = (tool: ToolFacts) => {
      const found = toolGroups.find(group => group.tools.includes(tool.name))
      return found === undefined
        ? undefined
        : { origin: found.origin, group: found.name, title: found.title, summary: found.summary }
    }
    return buildTree({
      sources: snapshot.sources,
      sections: snapshot.sections,
      tools: this.ctx.tools.definitions(agent)
        .filter(definition => !this.isManaged(definition.name))
        .map(definition => ({
          name: definition.name,
          description: definition.description,
          origin: this.ctx.tools.originOf(definition.name, agent),
        })),
      baseTools: this.baseTools,
      assigners: [groupAssigner, ...this.assigners],
      maxSummaryBytes: this.config.maxSummaryBytes,
      groups: groups.filter(group => group.root !== 'Tools'),
    })
  }

  private isManaged(name: string): boolean {
    for (const entry of this.managed) if (entry.names.has(name)) return true
    return false
  }

  private managedAdmits(name: string, agent: Agent): boolean {
    for (const entry of this.managed) if (entry.names.has(name) && entry.admit(agent)) return true
    return false
  }

  /** Grants for core sections the conversation does not hold, within `coreBytes`. */
  private async pendingCore(agent: Agent, signal: AbortSignal): Promise<UserMessage[]> {
    const wanted = [...new Set([...this.coreProviders].flatMap(provider => provider(agent)))]
    if (wanted.length === 0) return []
    const tree = await this.treeFor(agent, signal)
    const state = this.stateFor(agent)
    const held = grantedHashes(state)
    const leaves = new Map(leavesOf(tree.root).sections.map(leaf => [leaf.section.id, leaf]))
    const heldGrants = [...state.grants, ...[...state.claimed, ...state.inbox].flatMap(entry => entry.grants)]
    // Earlier writers did not distinguish explicit loads from eager grants.
    if (heldGrants.some(grant => grant.coreBytes === null)) return []
    const heldCore = heldGrants.reduce((sum, grant) => sum + (grant.coreBytes ?? 0), 0)
    const selectedHeld = wanted.reduce((sum, id) => {
      const leaf = leaves.get(id)
      if (leaf === undefined || held.get(id) !== leaf.section.hash
        || heldGrants.some(grant => (
          grant.key === id && grant.hash === leaf.section.hash && grant.coreBytes !== null && grant.coreBytes > 0
        ))) return sum
      return sum + leaf.section.bytes
    }, 0)
    let room = Math.max(0, this.config.coreBytes - heldCore - selectedHeld)
    const missing = wanted.filter((id) => {
      const leaf = leaves.get(id)
      if (leaf === undefined || held.get(id) === leaf.section.hash || leaf.section.bytes > room) return false
      room -= leaf.section.bytes
      return true
    })
    if (missing.length === 0) return []
    const read = await this.ctx.contextIndex.read(
      { workingDirectory: await this.ctx.workingDirectory.ensure(agent, signal) },
      missing,
      { maxBytes: this.config.coreBytes - heldCore - selectedHeld },
      signal,
    )
    // A section cut by the budget is not granted: its hash would count it as held without its full text.
    return read.sections.flatMap((body) => {
      const leaf = leaves.get(body.id)
      return leaf === undefined || body.truncated ? [] : [grantMessage(formatPath(leaf.node.segments), body, leaf.section.kind, body.bytes)]
    })
  }

  /** Newest dropped paths that fit `maxDroppedBytes`, oldest first, with a count of the ones left out. */
  private droppedPaths(state: ContextTreeProjectionState): string[] {
    const active = activeToolNames(state)
    const paths = [...new Set(state.dropped.flatMap(entry => entry.tools.length > 0
      ? entry.tools.filter(name => !active.has(name)).map(name => `Tools/@/${encodeURIComponent(name)}`) : entry.paths))]
    const shown: string[] = []
    let used = 0
    for (const path of paths.toReversed()) {
      used += byteLength(path) + 2
      if (used > this.config.maxDroppedBytes) break
      shown.unshift(path)
    }
    const left = paths.length - shown.length
    return left > 0 ? [...shown, `and ${left} more`] : shown
  }

  private async pendingCatalog(agent: Agent, signal: AbortSignal): Promise<UserMessage | undefined> {
    const tree = await this.treeFor(agent, signal)
    const branches: CatalogBranch[] = []
    for (const root of tree.root.children) {
      for (const origin of root.children) {
        if (isEmptyBranch(origin)) continue
        const view = viewOf(origin)
        branches.push({ path: view.path, summary: view.summary })
      }
    }
    if (branches.length === 0) return undefined
    const state = this.stateFor(agent)
    if (state.catalog?.digest === catalogDigest(branches)) return undefined
    return catalogMessage(branches, state.published, this.droppedPaths(state))
  }
}

export default ContextTreeService
