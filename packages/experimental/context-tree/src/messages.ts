/**
 * The three kinds of message the context tree logs: section grants, tool activations, and the
 * catalog. Each carries a typed source so the Session projection and compaction can recognize it.
 */
import { createHash } from 'node:crypto'
import type { RevocableSourceStub } from '@deepseek-ai/dsh-compaction'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ContextSectionBody, ContextSourceKind } from '@deepseek-ai/dsh-experimental-context-index/types'
import { clip } from './text.ts'
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

/**
 * The message that injects one section's text.
 * @param path - tree path the section was loaded from.
 * @param body - the section body from the index.
 * @param sourceKind - where the file comes from.
 * @param coreBytes - bytes charged to the eager-core budget until compaction; defaults to zero for explicit loads.
 * @returns a user message whose source marks it revocable.
 */
export function grantMessage(path: string, body: ContextSectionBody, sourceKind: ContextSourceKind, coreBytes?: number): UserMessage {
  const tail = body.truncated ? '\n[Cut here: the load budget ended inside this section; the rest is in the file.]' : ''
  return createUserMessage({
    content: [{
      type: 'text',
      text: `<context-grant path="${attribute(path)}" section="${attribute(body.anchor)}" hash="${body.hash}">\n${body.text}${tail}\n</context-grant>`,
    }],
    source: {
      kind: 'context-grant',
      form: 'instructions',
      key: body.id,
      path,
      anchor: body.anchor,
      sourceKind,
      hash: body.hash,
      coreBytes: coreBytes ?? 0,
      ...body.truncated ? { truncated: true as const } : {},
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

/** One origin folder the catalog lists. */
export interface CatalogBranch {
  readonly path: string
  readonly summary: string
}

/**
 * Identity of a catalog's content.
 * @param branches - the non-empty origin folders, in order.
 * @returns a stable digest; it changes only when a branch appears or disappears.
 */
export function catalogDigest(branches: readonly CatalogBranch[]): string {
  return digestOf(branches.flatMap(branch => [branch.path, branch.summary]))
}

/**
 * The catalog message.
 * @param branches - the non-empty origin folders, in order.
 * @param update - whether an earlier catalog existed in this session.
 * @param dropped - paths compaction removed and nothing has loaded again, oldest first; a later checkpoint cannot fold them away.
 * @returns a user message that records its digest and branches.
 */
export function catalogMessage(
  branches: readonly CatalogBranch[],
  update: boolean,
  dropped: readonly string[] = [],
): UserMessage {
  const lines = branches.map(branch => `- ${branch.path}: ${branch.summary}`)
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
