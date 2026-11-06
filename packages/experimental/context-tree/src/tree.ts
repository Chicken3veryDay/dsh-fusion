/**
 * Pure construction of the context tree from index sections and registered tools. The tree
 * has no model input: titles come from file and heading text, summaries from fixed templates,
 * and tool groups from placement assigners or the name-based default.
 */
import type {
  ContextSectionMeta,
  ContextSourceKind,
  ContextSourceMeta,
} from '@deepseek-ai/dsh-experimental-context-index/types'
import { clip, firstSentence, oneLine } from './text.ts'
import { formatPath } from './paths.ts'
import type {
  ContextNodeKind,
  ContextNodeView,
  ContextOrigin,
  ContextRoot,
  ToolFacts,
  ToolPlacement,
  ToolPlacementAssigner,
  CuratedGroup,
} from './types.ts'

/** One node of the built tree. */
export interface TreeNode {
  readonly segments: readonly string[]
  readonly kind: ContextNodeKind
  readonly title: string
  readonly summary: string
  readonly children: readonly TreeNode[]
  /** Section behind a `section` node. */
  readonly section?: ContextSectionMeta
  /** Tool behind a `tool` node. */
  readonly tool?: string
}

/** Inputs of one tree build. */
export interface TreeInput {
  readonly sources: readonly ContextSourceMeta[]
  readonly sections: readonly ContextSectionMeta[]
  /** Registered tools in registration order. */
  readonly tools: readonly ToolFacts[]
  /** Always-exposed tool names; they never appear in the tree. */
  readonly baseTools: ReadonlySet<string>
  /** Placement assigners in registration order; the first opinion wins. */
  readonly assigners: readonly ToolPlacementAssigner[]
  readonly maxSummaryBytes: number
  /** Curated section groups; a section in a valid group leaves its file node. */
  readonly groups?: readonly CuratedGroup[]
}

/** The built tree. */
export interface ContextTree {
  readonly root: TreeNode
  /** Tools placed under Global only because neither an assigner nor the registry recorded their origin, in registration order. */
  readonly unresolvedOrigin: readonly string[]
}

/** Section and tool leaf nodes under one node, in tree order. */
export interface Leaves {
  readonly sections: readonly { readonly node: TreeNode; readonly section: ContextSectionMeta }[]
  readonly tools: readonly { readonly node: TreeNode; readonly tool: string }[]
}

const ROOTS: readonly ContextRoot[] = ['Instructions', 'Sources', 'Tools']
const ORIGINS: readonly [ContextOrigin, string][] = [['global', 'Global'], ['project', 'Project']]

const ROOT_SUMMARIES: Readonly<Record<ContextRoot, string>> = {
  Instructions: 'Use when you need the rules for working for this user or in this workspace.',
  Sources: 'Use when you need this workspace\'s reference documentation.',
  Tools: 'Use when you need a capability beyond the always-available tools.',
}

const ORIGIN_SUMMARIES: Readonly<Record<ContextRoot, Readonly<Record<ContextOrigin, string>>>> = {
  Instructions: {
    global: 'Use for rules that apply to every project: the user-level instruction files.',
    project: 'Use for rules specific to this workspace: its instruction files from the project root down.',
  },
  Sources: {
    global: 'Use for reference material available everywhere; nothing provides it yet.',
    project: 'Use for this workspace\'s documentation files.',
  },
  Tools: {
    global: 'Use for tools available everywhere: harness plugins, user-level servers, and tools whose origin is not recorded.',
    project: 'Use for tools this workspace contributes.',
  },
}

function node(
  segments: readonly string[],
  kind: ContextNodeKind,
  title: string,
  summary: string,
  children: readonly TreeNode[] = [],
  extra: { section?: ContextSectionMeta; tool?: string } = {},
): TreeNode {
  return { segments, kind, title, summary, children, ...extra }
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '.' : path.slice(0, index)
}

function headingsOf(sections: readonly ContextSectionMeta[], limit: number): string {
  const seen: string[] = []
  for (const section of sections) {
    const heading = section.headingPath[section.headingPath.length - 1]
    if (heading === undefined || section.level > 2 || seen.includes(heading)) continue
    seen.push(heading)
    if (seen.length === limit) break
  }
  return seen.join('; ')
}

function sourceSummary(source: ContextSourceMeta, sections: readonly ContextSectionMeta[], max: number): string {
  const headings = headingsOf(sections, 4)
  const topics = headings === '' ? `${sections.length} section${sections.length === 1 ? '' : 's'}` : headings
  let prefix: string
  if (source.kind === 'user-instructions') prefix = 'Use for your personal rules'
  else if (source.kind === 'project-instructions') {
    const dir = dirname(source.path)
    prefix = `Use for rules that apply ${dir === '.' ? 'at the project root' : `under ${dir}`}`
  } else prefix = 'Use for'
  return clip(`${prefix}: ${topics}`, max)
}

function sectionTitle(section: ContextSectionMeta): string {
  const base = section.headingPath.length === 0 ? '(intro)' : section.headingPath.join(' > ')
  return section.partCount > 1 ? `${base} [part ${section.part}/${section.partCount}]` : base
}

function sourceNodes(
  origin: ContextOrigin,
  root: ContextRoot,
  input: TreeInput,
  accepts: (kind: ContextSourceKind) => boolean,
): TreeNode[] {
  const nodes: TreeNode[] = []
  const originName = origin === 'global' ? 'Global' : 'Project'
  const grouped = new Set<string>()
  const groupedFrom = new Set<string>()
  for (const group of input.groups ?? []) {
    if (group.root !== root || group.origin !== origin) continue
    const members = group.sections
      .map(id => input.sections.find(section => section.id === id))
      .filter((section): section is ContextSectionMeta => section !== undefined && accepts(section.kind) && !grouped.has(section.id))
    if (members.length === 0) continue
    for (const section of members) {
      grouped.add(section.id)
      groupedFrom.add(section.sourceId)
    }
    const base = [root, originName, group.name]
    nodes.push(node(base, 'folder', group.title, clip(group.summary, input.maxSummaryBytes), members.map(section => node(
      [...base, section.id],
      'section',
      sectionTitle(section),
      clip(`Use when you need "${sectionTitle(section)}" (${section.bytes} bytes) from ${section.path}.`, input.maxSummaryBytes),
      [],
      { section },
    ))))
  }
  const bySource = new Map<string, ContextSectionMeta[]>()
  for (const section of input.sections) {
    if (grouped.has(section.id)) continue
    const list = bySource.get(section.sourceId)
    if (list === undefined) bySource.set(section.sourceId, [section])
    else list.push(section)
  }
  for (const source of input.sources) {
    if (!accepts(source.kind)) continue
    const sections = bySource.get(source.id) ?? []
    if (sections.length === 0 && groupedFrom.has(source.id)) continue
    const base = [root, origin === 'global' ? 'Global' : 'Project', source.path]
    const children = sections.map(section => node(
      [...base, section.id],
      'section',
      sectionTitle(section),
      clip(`Use when you need "${sectionTitle(section)}" (${section.bytes} bytes).`, input.maxSummaryBytes),
      [],
      { section },
    ))
    const existing = nodes.findIndex(entry => formatPath(entry.segments) === formatPath(base))
    const group = nodes[existing]
    if (group === undefined) nodes.push(node(base, 'source', source.path, sourceSummary(source, sections, input.maxSummaryBytes), children))
    else {
      nodes[existing] = { ...group, children: [...group.children, ...children] }
    }
  }
  return nodes
}

function defaultGroupKey(name: string): string {
  const mcp = /^mcp__([^_].*?)__/.exec(name)
  if (mcp?.[1] !== undefined) return `mcp-${mcp[1]}`
  const index = name.indexOf('_')
  return index > 0 ? name.slice(0, index) : name
}

interface GroupDraft {
  readonly placement: ToolPlacement
  readonly tools: ToolFacts[]
}

function placeTools(input: TreeInput): { groups: Record<ContextOrigin, Map<string, GroupDraft>>; unresolved: string[] } {
  const groups: Record<ContextOrigin, Map<string, GroupDraft>> = { global: new Map(), project: new Map() }
  const defaults: ToolFacts[] = []
  const placed = new Map<string, ToolPlacement>()
  for (const tool of input.tools) {
    if (input.baseTools.has(tool.name)) continue
    let placement: ToolPlacement | undefined
    for (const assign of input.assigners) {
      placement = assign(tool)
      if (placement !== undefined && (tool.origin === 'unknown' || placement.origin === tool.origin)) break
      placement = undefined
    }
    if (placement === undefined) defaults.push(tool)
    else placed.set(tool.name, placement)
  }
  // A recorded registration origin places a tool; `unknown` stays under Global and is reported.
  const defaultOrigin = (tool: ToolFacts): ContextOrigin => (tool.origin === 'project' ? 'project' : 'global')
  const defaultKeys: Record<ContextOrigin, string[]> = { global: [], project: [] }
  for (const tool of defaults) defaultKeys[defaultOrigin(tool)].push(defaultGroupKey(tool.name))
  const shared = (origin: ContextOrigin, key: string): boolean => defaultKeys[origin].indexOf(key) !== defaultKeys[origin].lastIndexOf(key)
  const unresolved: string[] = []
  for (const tool of input.tools) {
    if (input.baseTools.has(tool.name)) continue
    let placement = placed.get(tool.name)
    if (placement === undefined) {
      const origin = defaultOrigin(tool)
      const key = defaultGroupKey(tool.name)
      placement = { origin, group: shared(origin, key) ? key : 'other' }
      if (tool.origin === 'unknown') unresolved.push(tool.name)
    }
    const byGroup = groups[placement.origin]
    const draft = byGroup.get(placement.group)
    if (draft === undefined) byGroup.set(placement.group, { placement, tools: [tool] })
    else draft.tools.push(tool)
  }
  return { groups, unresolved }
}

function toolNodes(origin: ContextOrigin, drafts: ReadonlyMap<string, GroupDraft>, input: TreeInput): TreeNode[] {
  const originName = origin === 'global' ? 'Global' : 'Project'
  return [...drafts].map(([group, draft]) => {
    const base = ['Tools', originName, group]
    const children = draft.tools.map(tool => node(
      [...base, tool.name],
      'tool',
      tool.name,
      clip(firstSentence(tool.description), input.maxSummaryBytes),
      [],
      { tool: tool.name },
    ))
    const listing = clip(draft.tools.map(tool => tool.name).join(', '), Math.max(16, input.maxSummaryBytes - 48))
    const summary = oneLine(draft.placement.summary ?? `Use for ${group} tools: ${listing}.`)
    return node(base, 'tool-group', draft.placement.title ?? group, clip(summary, input.maxSummaryBytes), children)
  })
}

/**
 * Build the tree for one agent.
 * @param input - index sections and sources, registered tools, base tools, and assigners.
 * @returns the root node and the tools whose origin neither an assigner nor the registry recorded.
 */
export function buildTree(input: TreeInput): ContextTree {
  const { groups, unresolved } = placeTools(input)
  const rootChildren = ROOTS.map((rootName) => {
    const originNodes = ORIGINS.map(([origin, originName]) => {
      let children: TreeNode[]
      if (rootName === 'Instructions') {
        children = sourceNodes(origin, rootName, input, kind => (
          origin === 'global' ? kind === 'user-instructions' : kind === 'project-instructions'
        ))
      } else if (rootName === 'Sources') {
        children = sourceNodes(origin, rootName, input, kind => origin === 'project' && kind === 'doc')
      } else {
        children = toolNodes(origin, groups[origin], input)
      }
      return node([rootName, originName], 'folder', originName, ORIGIN_SUMMARIES[rootName][origin], children)
    })
    return node([rootName], 'folder', rootName, ROOT_SUMMARIES[rootName], originNodes)
  })
  return { root: node([], 'folder', 'Context', 'Everything you can load on demand.', rootChildren), unresolvedOrigin: unresolved }
}

/**
 * Resolve a path to its node.
 * @param tree - the built tree.
 * @param segments - unescaped path segments.
 * @returns the node, or `undefined` when the path names none.
 */
export function findNode(tree: ContextTree, segments: readonly string[]): TreeNode | undefined {
  let current = tree.root
  for (const segment of segments) {
    const next = current.children.find(child => child.segments[child.segments.length - 1] === segment)
    if (next === undefined) return undefined
    current = next
  }
  return current
}

/**
 * Collect the sections and tools under a node in tree order.
 * @param start - the node.
 * @returns its leaves; a leaf node yields itself.
 */
export function leavesOf(start: TreeNode): Leaves {
  const sections: Leaves['sections'][number][] = []
  const tools: Leaves['tools'][number][] = []
  const visit = (current: TreeNode): void => {
    if (current.section !== undefined) sections.push({ node: current, section: current.section })
    if (current.tool !== undefined) tools.push({ node: current, tool: current.tool })
    for (const child of current.children) visit(child)
  }
  visit(start)
  return { sections, tools }
}

/**
 * Whether a node lists nothing loadable.
 * @param current - the node.
 * @returns true when no section or tool lies under it.
 */
export function isEmptyBranch(current: TreeNode): boolean {
  const leaves = leavesOf(current)
  return leaves.sections.length === 0 && leaves.tools.length === 0
}

/**
 * The model-facing view of one node.
 * @param current - the node.
 * @returns path, kind, title, summary, and child count.
 */
export function viewOf(current: TreeNode): ContextNodeView {
  return {
    path: formatPath(current.segments),
    kind: current.kind,
    title: current.title,
    summary: current.summary,
    children: current.children.length,
  }
}
