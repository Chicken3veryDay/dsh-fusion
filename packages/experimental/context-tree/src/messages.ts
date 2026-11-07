/**
 * The three kinds of message the context tree logs: section grants, tool activations, and the
 * catalog. Each carries a typed source so the Session projection and compaction can recognize it.
 */
import { createHash } from 'node:crypto'
import type { RevocableSourceStub } from '@deepseek-ai/dsh-compaction'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ContextSectionBody, ContextSourceKind } from '@deepseek-ai/dsh-experimental-context-index/types'
import { byteLength, clip } from './text.ts'
import type { ContextActivationSource, ContextCatalogSource, ContextGrantSource } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A section of an instruction or documentation file loaded on demand; revocable at compaction. */
    'context-grant': ContextGrantSource
    /** Tools made callable on demand; revocable at compaction. */
    'context-activation': ContextActivationSource
    /** The context tree catalog; republished when it leaves the conversation. */
    'context-tree-catalog': ContextCatalogSource
  }
}

function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function digestOf(parts: readonly string[]): string {
  return createHash('sha256').update(parts.map(part => JSON.stringify(part)).join('\n')).digest('hex')
}

/** What a grant message says about its section, apart from the text. */
export interface GrantFrame {
  /** Tree path the section was loaded from. */
  readonly path: string
  /** Section anchor, `file#Heading > Subheading`. */
  readonly anchor: string
  /** `sha256:` digest of the complete section text. */
  readonly hash: string
  /** Digest of an earlier grant of the same section that the conversation still holds and that no longer matches the file. */
  readonly supersedes?: string
}

/**
 * The frame of one grant.
 * @param path - tree path the section was loaded from.
 * @param anchor - section anchor.
 * @param hash - digest of the complete section text.
 * @param supersedes - digest of an out-of-date earlier copy, if any.
 * @returns the frame.
 */
export function grantFrame(path: string, anchor: string, hash: string, supersedes: string | undefined): GrantFrame {
  return { path, anchor, hash, ...supersedes === undefined ? {} : { supersedes } }
}

/**
 * How much of the frame a grant message shows, from most to least. A load whose byte budget
 * cannot hold the full frame drops the anchor and digest first, then the path; the message
 * source keeps every field either way.
 */
export type GrantForm = 'full' | 'compact' | 'bare'

/** Grant forms from the most to the least detailed. */
export const GRANT_FORMS: readonly GrantForm[] = ['full', 'compact', 'bare']

const FULL_TAIL = '\n[Cut here: the load budget ended inside this section; the rest is in the file.]'
const SHORT_TAIL = '\n[cut]'
const STALE_LINE = '[An earlier copy of this section in the conversation is out of date; this text replaces it.]\n'

/**
 * The text of a grant message.
 * @param frame - the section's path, anchor, digest, and any superseded digest.
 * @param text - the section text, possibly a prefix.
 * @param truncated - whether `text` is a prefix of the section.
 * @param form - how much of the frame to show.
 * @returns the complete message text.
 */
export function grantText(frame: GrantFrame, text: string, truncated: boolean, form: GrantForm): string {
  const replaces = frame.supersedes === undefined || form === 'bare' ? '' : ` replaces="${frame.supersedes}"`
  let open: string
  if (form === 'full') open = `<context-grant path="${attribute(frame.path)}" section="${attribute(frame.anchor)}" hash="${frame.hash}"${replaces}>`
  else if (form === 'compact') open = `<context-grant path="${attribute(frame.path)}"${replaces}>`
  else open = '<context-grant>'
  const stale = frame.supersedes === undefined || form !== 'full' ? '' : STALE_LINE
  const tail = truncated ? (form === 'full' ? FULL_TAIL : SHORT_TAIL) : ''
  return `${open}\n${stale}${text}${tail}\n</context-grant>`
}

/**
 * UTF-8 bytes a grant message adds around its section text.
 * @param frame - the section's frame.
 * @param truncated - whether the text will be a prefix.
 * @param form - how much of the frame to show.
 * @returns the message bytes minus the text bytes.
 */
export function grantOverhead(frame: GrantFrame, truncated: boolean, form: GrantForm): number {
  return byteLength(grantText(frame, '', truncated, form))
}

/**
 * The message that injects one section's text.
 * @param path - tree path the section was loaded from.
 * @param body - the section body from the index.
 * @param sourceKind - where the file comes from.
 * @param options - bytes charged to the eager-core budget until compaction (zero for explicit loads),
 *   the digest of an out-of-date earlier copy, and the frame form (default `full`).
 * @returns a user message whose source marks it revocable.
 */
export function grantMessage(
  path: string,
  body: ContextSectionBody,
  sourceKind: ContextSourceKind,
  options: { readonly coreBytes?: number; readonly supersedes?: string | undefined; readonly form?: GrantForm },
): UserMessage {
  const frame = grantFrame(path, body.anchor, body.hash, options.supersedes)
  return createUserMessage({
    content: [{ type: 'text', text: grantText(frame, body.text, body.truncated, options.form ?? 'full') }],
    source: {
      kind: 'context-grant',
      form: 'instructions',
      key: body.id,
      path,
      anchor: body.anchor,
      sourceKind,
      hash: body.hash,
      coreBytes: options.coreBytes ?? 0,
      ...body.truncated ? { truncated: true as const } : {},
      ...options.supersedes === undefined ? {} : { supersedes: options.supersedes },
    },
  })
}

/**
 * The message that announces newly callable tools.
 * @param nodes - the nodes the caller named.
 * @param tools - the tools activated by this message, in tree order.
 * @returns a user message whose source marks it revocable.
 */
export function activationMessage(nodes: readonly string[], tools: readonly string[]): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `<context-activation>Callable from your next step: ${tools.join(', ')}. Loaded from: ${nodes.join('; ')}. They stay callable until the conversation is compacted.</context-activation>`,
    }],
    source: {
      kind: 'context-activation',
      form: 'notice',
      summary: boundContextSummary(`Activated ${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.join(', ')}`),
      key: digestOf(tools),
      nodes: [...nodes],
      tools: [...tools],
    },
  })
}

/** One curated group the catalog lists under its origin folder. */
export interface CatalogGroup {
  readonly path: string
  readonly summary: string
}

/** One origin folder the catalog lists. */
export interface CatalogBranch {
  readonly path: string
  readonly summary: string
  /** Curated groups under the folder, in tree order; absent when there are none. */
  readonly groups?: readonly CatalogGroup[]
}

/**
 * Identity of a catalog's content.
 * @param branches - the non-empty origin folders, in order, with their curated groups.
 * @returns a stable digest; it changes only when a branch or a curated group appears, disappears, or changes its summary.
 */
export function catalogDigest(branches: readonly CatalogBranch[]): string {
  return digestOf(branches.flatMap(branch => [
    branch.path, branch.summary, ...(branch.groups ?? []).flatMap(group => [group.path, group.summary]),
  ]))
}

/**
 * Curated group lines within a byte bound, in catalog order; the groups left out are counted on a last line.
 * @param branches - the branches and their groups.
 * @param maxBytes - UTF-8 bytes of all group lines together, the count line included.
 * @returns the lines to show under each branch path.
 */
function groupLines(branches: readonly CatalogBranch[], maxBytes: number): ReadonlyMap<string, readonly string[]> {
  const all = branches.flatMap(branch => (branch.groups ?? []).map(group => ({ branch: branch.path, line: `  - ${group.path}: ${group.summary}` })))
  const moreLine = (count: number): string => `  - and ${count} more curated group${count === 1 ? '' : 's'}; context_browse lists them`
  const shown = new Map<string, string[]>()
  let used = 0
  for (const [index, entry] of all.entries()) {
    const left = all.length - index - 1
    const reserve = left === 0 ? 0 : byteLength(moreLine(left)) + 1
    const size = byteLength(entry.line) + 1
    if (used + size + reserve > maxBytes) {
      const count = all.length - index
      if (used + byteLength(moreLine(count)) + 1 <= maxBytes) shown.set(entry.branch, [...shown.get(entry.branch) ?? [], moreLine(count)])
      break
    }
    used += size
    shown.set(entry.branch, [...shown.get(entry.branch) ?? [], entry.line])
  }
  return shown
}

/**
 * The catalog message.
 * @param branches - the non-empty origin folders, in order, with their curated groups.
 * @param update - whether an earlier catalog existed in this session.
 * @param dropped - paths compaction removed and nothing has loaded again, oldest first; a later checkpoint cannot fold them away.
 * @param maxGroupBytes - UTF-8 bytes the curated group lines may take together.
 * @returns a user message that records its digest and branches.
 */
export function catalogMessage(
  branches: readonly CatalogBranch[],
  update: boolean,
  dropped: readonly string[] = [],
  maxGroupBytes = 0,
): UserMessage {
  const groups = groupLines(branches, maxGroupBytes)
  const lines = branches.flatMap(branch => [`- ${branch.path}: ${branch.summary}`, ...groups.get(branch.path) ?? []])
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        update
          ? 'This context tree listing replaces any earlier one in this conversation.'
          : 'Instructions, reference documents, and extra tools are not loaded up front; they sit in a context tree you load from on demand.',
        '',
        '<context_tree>',
        ...lines,
        '</context_tree>',
        ...dropped.length === 0 ? [] : ['', `Dropped by compaction (load again with context_load if you still need them): ${dropped.join('; ')}`],
        '',
        'Call `context_browse` (a path and a depth) to see titles and when to use each node; call `context_load` with paths to load them.',
        'Loading an instruction or source node adds its text to the conversation. Loading a tool node makes those tools callable from your next step; tools you have not loaded cannot be called.',
        'Loaded text and tools are dropped when the conversation is compacted, and a one-line note records what was dropped. Load again if you still need it.',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'context-tree-catalog',
      form: 'catalog',
      ...update ? { update: true as const } : {},
      digest: catalogDigest(branches),
      branches: branches.map(branch => branch.path),
    },
  })
}

/**
 * Compaction stub for a revoked section grant.
 * @param source - the grant's source.
 * @returns the line that replaces the text.
 */
export function grantStub(source: ContextGrantSource): RevocableSourceStub {
  return {
    key: source.key,
    text: `loaded ${clip(source.anchor, 120)}; reload with context_load("${source.key}") if needed`,
  }
}

/**
 * Compaction stub for a revoked tool activation.
 * @param source - the activation's source.
 * @returns the line that replaces the message.
 */
export function activationStub(source: ContextActivationSource): RevocableSourceStub {
  const shown = source.tools.slice(0, 4).join(', ')
  const more = source.tools.length > 4 ? ` and ${source.tools.length - 4} more` : ''
  return {
    key: source.key,
    text: `tools no longer callable: ${shown}${more}; load ${source.tools.map(name => `Tools/@/${encodeURIComponent(name)}`).join(', ')} again with context_load if needed`,
  }
}
