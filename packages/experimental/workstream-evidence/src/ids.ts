/** Runtime constructors and validators for Workstream Evidence identifiers. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkstreamEvidenceArtifactId as ArtifactId, WorkstreamEvidenceOperationId as OperationId } from './types.ts'

/**
 * Validate and brand an artifact logical identifier.
 * Artifact IDs must be 1–200 characters and cannot contain path separators or path traversal.
 * @param value - logical artifact name or id.
 */
export function WorkstreamEvidenceArtifactId(value: string): ArtifactId {
  const trimmed = value.trim()
  if (trimmed.length === 0 || value.length > 200) {
    throw new Error('Workstream evidence artifact id must contain 1–200 characters')
  }
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error('Workstream evidence artifact id must not contain path separators or traversal')
  }
  return brandString<ArtifactId>(trimmed)
}

/**
 * Validate and brand a stable operation identifier.
 * @param value - caller-supplied idempotency key.
 */
export function WorkstreamEvidenceOperationId(value: string): OperationId {
  const trimmed = value.trim()
  if (trimmed.length === 0 || value.length > 200) {
    throw new Error('Workstream evidence operation id must contain 1–200 characters')
  }
  return brandString<OperationId>(trimmed)
}
