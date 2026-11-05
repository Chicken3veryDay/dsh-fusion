import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionChangeRequest } from '@deepseek-ai/dsh-experimental-forge-session'

/** Logical identity of one evidence artifact. */
export type WorkstreamEvidenceArtifactId = Branded<'WorkstreamEvidenceArtifactId'>

/** Stable operation identity for idempotent execution. */
export type WorkstreamEvidenceOperationId = Branded<'WorkstreamEvidenceOperationId'>

/** Durable record for one published immutable version of an evidence artifact. */
export interface WorkstreamEvidenceVersionRecord {
  readonly artifactId: WorkstreamEvidenceArtifactId
  readonly version: number
  readonly name: string
  readonly ref: string
  readonly digest: string
  readonly bytes: number
  readonly authorSessionId: SessionId
  readonly operationId: WorkstreamEvidenceOperationId
  readonly createdAt: string
}

/** Grouping of all retained versions for one artifact logical identity. */
export interface WorkstreamEvidenceArtifactRecord {
  readonly artifactId: WorkstreamEvidenceArtifactId
  readonly latestVersion: number
  readonly versions: readonly WorkstreamEvidenceVersionRecord[]
}

/** Complete bounded durable state of all evidence owned by one root Workstream session. */
export interface WorkstreamEvidenceSnapshot {
  readonly ownerSessionId: SessionId
  readonly revision: number
  readonly artifacts: readonly WorkstreamEvidenceArtifactRecord[]
}

/** Deployment bounds and limits for Workstream Evidence. */
export interface Config {
  /** Maximum byte size accepted for a single evidence payload (default: 10 MiB). */
  readonly maxBytesPerArtifact?: number
  /** Maximum number of distinct artifact logical identities per Workstream (default: 256). */
  readonly maxArtifacts?: number
  /** Maximum number of versions per artifact (default: 64). */
  readonly maxVersionsPerArtifact?: number
  /** Maximum aggregate byte size of all stored artifacts in a Workstream (default: 100 MiB). */
  readonly maxTotalBytes?: number
  /** Maximum byte length of a serialized context packet (default: 65,536). */
  readonly maxContextPacketBytes?: number
  /** Maximum byte size of one evidence version returned as text to a model tool (default: 65,536). */
  readonly maxToolTextBytes?: number
}

/** Request to publish an immutable version of an evidence artifact. */
export interface PublishEvidenceRequest {
  readonly operationId: WorkstreamEvidenceOperationId
  readonly artifactId: WorkstreamEvidenceArtifactId
  readonly name?: string | undefined
  readonly expectedVersion: number
  readonly content: string | Uint8Array
  readonly signal?: AbortSignal | undefined
}

/** Request to construct a WorkstreamContextPacket from exact retained evidence versions. */
export interface PrepareContextRequest {
  readonly requirements: string
  readonly decisions: readonly string[]
  readonly cursor: string
  readonly changes: string
  readonly artifacts: readonly { readonly artifactId: string; readonly version: number }[]
}

/** One Session's binding to an aggregated change request. */
export interface ChangeRequestContribution {
  readonly sessionId: SessionId
  readonly origin: SessionChangeRequest['origin']
  /** That Session's latest polling result, including head revision and checks when the provider reports them. */
  readonly update: SessionChangeRequest['update']
}

/** Change request bound in one or more Workstream Sessions, keyed by its first recorded URL. */
export interface AggregatedChangeRequest {
  readonly url: string
  readonly ref: SessionChangeRequest['ref']
  /** Every contributing Session, in root-then-member order. */
  readonly contributions: readonly ChangeRequestContribution[]
}

/** Result of aggregating member forge bindings. */
export interface AggregatedChangeRequestsResult {
  /** False when the forge service is absent or any Session could not be read. */
  readonly complete: boolean
  readonly changeRequests: readonly AggregatedChangeRequest[]
  readonly diagnostics: readonly string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Complete Workstream Evidence state after one admitted mutation. */
    'plugin:workstream-evidence/state': { readonly version: 1; readonly snapshot: WorkstreamEvidenceSnapshot }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Null for Sessions without owned Workstream Evidence. */
    workstreamEvidence: WorkstreamEvidenceSnapshot | null
  }
}
