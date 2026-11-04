/** Runtime constructors for Workstream operation identities. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkstreamOperationId as OperationId } from './types.ts'

/** Validate a stable operation identity.
 * @param value - opaque caller-generated key.
 * @returns branded key, at most 200 UTF-16 code units.
 */
export function WorkstreamOperationId(value: string): OperationId {
  if (value.trim().length === 0 || value.length > 200) throw new Error('Workstream operation id must contain 1–200 characters')
  return brandString<OperationId>(value)
}
