/** Byte-bounded text helpers shared by the tree builder and the renderers. */

const encoder = new TextEncoder()

/**
 * UTF-8 byte size of a string.
 * @param text - the string.
 * @returns its encoded length.
 */
export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/**
 * Collapse whitespace so a value fits on one line.
 * @param text - arbitrary text.
 * @returns the text with every whitespace run replaced by one space and the ends trimmed.
 */
export function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

/**
 * Cut a string to a UTF-8 byte bound on a character boundary, ending with an ellipsis when cut.
 * @param text - the string.
 * @param maxBytes - bound for the result, ellipsis included.
 * @returns the string, or its longest prefix that fits together with `…`.
 */
export function clip(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  const room = Math.max(0, maxBytes - byteLength('…'))
  let out = ''
  let used = 0
  for (const character of text) {
    const size = byteLength(character)
    if (used + size > room) break
    out += character
    used += size
  }
  return `${out}…`
}

/**
 * First sentence of a description, on one line.
 * @param text - arbitrary description.
 * @returns the text up to and including the first sentence end, or all of it.
 */
export function firstSentence(text: string): string {
  const line = oneLine(text)
  const end = line.search(/[.!?](\s|$)/)
  return end === -1 ? line : line.slice(0, end + 1)
}
