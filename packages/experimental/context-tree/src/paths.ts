/** Tree path encoding: `/`-separated segments, with `%` and `/` inside a segment escaped. */
import { ContextTreeError } from './error.ts'

/**
 * Escape one path segment.
 * @param segment - a title or file path that may contain `/` or `%`.
 * @returns the segment with `%` as `%25` and `/` as `%2F`.
 */
export function encodeSegment(segment: string): string {
  return segment.replaceAll('%', '%25').replaceAll('/', '%2F')
}

/**
 * Join segments into a path string.
 * @param segments - unescaped segments.
 * @returns the path; the empty list is the empty path.
 */
export function formatPath(segments: readonly string[]): string {
  return segments.map(encodeSegment).join('/')
}

/**
 * Split a caller-supplied path into unescaped segments.
 * @param path - path text; surrounding `/` and whitespace are ignored.
 * @returns the segments; the empty path yields none.
 * @throws {@link ContextTreeError} `CONTEXT_TREE_INVALID_INPUT` for an empty segment inside the path.
 */
export function parsePath(path: string): string[] {
  const segments = splitPath(path)
  if (segments === undefined) throw new ContextTreeError(`path "${path}" has an empty segment`, 'CONTEXT_TREE_INVALID_INPUT')
  return segments
}

/**
 * Split a caller-supplied path without throwing.
 * @param path - path text; surrounding `/` and whitespace are ignored.
 * @returns the unescaped segments, none for the empty path, or `undefined` for an empty segment inside the path.
 */
export function splitPath(path: string): string[] | undefined {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '') return []
  const parts = trimmed.split('/')
  if (parts.includes('')) return undefined
  return parts.map(part => part.replaceAll('%2F', '/').replaceAll('%25', '%'))
}
