/** Model-facing text of browse and load results. */
import { byteLength } from './text.ts'
import { parsePath } from './paths.ts'
import type { ContextBrowseResult, ContextLoadResult, ContextNodeView } from './types.ts'

/**
 * One listing line.
 * @param view - the node.
 * @returns `- path (children): title — summary`, leaving out a title that repeats the last path segment.
 */
export function browseLine(view: ContextNodeView): string {
  const path = view.path === '' ? '(root)' : view.path
  const count = view.children > 0 ? ` (${view.children})` : ''
  const title = view.path !== '' && parsePath(view.path).at(-1) === view.title ? '' : `${view.title} — `
  return `- ${path}${count}: ${title}${view.summary}`
}

/**
 * Header line of a listing.
 * @param path - listed node path.
 * @param depth - effective depth.
 * @param capped - whether the requested depth was lowered.
 * @returns the line.
 */
export function browseHeader(path: string, depth: number, capped: boolean): string {
  return `Context tree at ${path === '' ? '(root)' : path}, depth ${depth}${capped ? ' (capped)' : ''}; (n) counts children:`
}

/**
 * Footer line of a listing.
 * @param shown - listed nodes.
 * @param offset - position of the first listed node.
 * @param remaining - descendants after the listed ones.
 * @returns the line, empty when nothing remains and something is listed.
 */
export function browseFooter(shown: number, offset: number, remaining: number): string {
  if (remaining > 0) return `${remaining} more not listed; continue with offset ${offset + shown}, or browse a narrower path.`
  return shown === 0 ? 'Nothing here.' : ''
}

/**
 * UTF-8 bytes of the complete rendered listing for a candidate node count, used to enforce the byte bound.
 * @param header - header line.
 * @param lines - node lines listed so far.
 * @param footer - footer line.
 * @returns the byte length of {@link renderBrowse}'s output for these parts.
 */
export function listingBytes(header: string, lines: readonly string[], footer: string): number {
  return byteLength([header, ...lines, ...footer === '' ? [] : [footer]].join('\n'))
}

/**
 * Render a browse result.
 * @param result - the bounded listing.
 * @returns text for the model.
 */
export function renderBrowse(result: ContextBrowseResult): string {
  const footer = browseFooter(result.nodes.length, result.offset, result.remaining)
  return [
    browseHeader(result.path, result.depth, result.depthCapped),
    ...result.nodes.map(browseLine),
    ...footer === '' ? [] : [footer],
  ].join('\n')
}

/**
 * Render a load result.
 * @param result - what the load did.
 * @returns text for the model.
 */
export function renderLoad(result: ContextLoadResult): string {
  const lines: string[] = []
  for (const section of result.granted) {
    lines.push(`Loaded ${section.path} (${section.bytes} bytes${section.truncated ? ', cut at the load budget' : ''}); its text follows in the conversation.`)
  }
  for (const activation of result.activated) {
    lines.push(`Activated from ${activation.path}: ${activation.tools.join(', ')}. Callable from your next step.`)
  }
  if (result.alreadyLoaded.length > 0) lines.push(`Already in the conversation: ${result.alreadyLoaded.join(', ')}.`)
  if (result.alreadyActive.length > 0) lines.push(`Already callable: ${result.alreadyActive.join(', ')}.`)
  if (result.omittedSections.length > 0) lines.push(`Not loaded, byte budget reached: ${result.omittedSections.join(', ')}. Load them in a separate call.`)
  if (result.omittedTools.length > 0) lines.push(`Not activated, per-load limit reached: ${result.omittedTools.join(', ')}. Load them in a separate call.`)
  if (result.missing.length > 0) lines.push(`No such node: ${result.missing.join(', ')}. Use context_browse to find paths.`)
  return lines.length === 0 ? 'Nothing was loaded.' : lines.join('\n')
}
