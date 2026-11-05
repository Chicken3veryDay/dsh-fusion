/** Typed error definitions for Workstream Evidence operations. */

/** Handling-relevant Workstream Evidence failure codes. */
export type WorkstreamEvidenceErrorCode =
  | 'WORKSTREAM_EVIDENCE_NOT_FOUND'
  | 'WORKSTREAM_EVIDENCE_UNAUTHORIZED'
  | 'WORKSTREAM_EVIDENCE_STALE_VERSION'
  | 'WORKSTREAM_EVIDENCE_PAYLOAD_MISMATCH'
  | 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED'
  | 'WORKSTREAM_EVIDENCE_CORRUPT'
  | 'WORKSTREAM_EVIDENCE_INVALID_INPUT'
  | 'WORKSTREAM_EVIDENCE_DISPOSED'

/** Structured domain failure for Workstream Evidence operations. */
export class WorkstreamEvidenceError extends Error {
  constructor(message: string, readonly code: WorkstreamEvidenceErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkstreamEvidenceError'
  }
}
