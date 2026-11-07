/** Byte-size and one-line text helpers shared by the edit validators and the map store. */

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
