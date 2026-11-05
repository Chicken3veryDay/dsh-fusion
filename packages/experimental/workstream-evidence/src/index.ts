/** Durable Workstream Evidence keeps immutable artifact versions and aggregated forge bindings. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentId, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { appendPluginRecord, type SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { WorkstreamContextPacket } from '@deepseek-ai/dsh-experimental-workstream'
import { WorkstreamEvidenceError } from './error.ts'
import { aggregateChangeRequests } from './forge-adapter.ts'
import { WorkstreamEvidenceArtifactId, WorkstreamEvidenceOperationId } from './ids.ts'
import { WORKSTREAM_EVIDENCE_RECORD, workstreamEvidenceProjectionDefinition } from './projection.ts'
import type { WorkstreamEvidenceProjectionState } from './projection.ts'
import type {
  AggregatedChangeRequestsResult,
  Config,
  PrepareContextRequest,
  PublishEvidenceRequest,
  WorkstreamEvidenceArtifactRecord,
  WorkstreamEvidenceSnapshot,
  WorkstreamEvidenceVersionRecord,
} from './types.ts'

export { WorkstreamEvidenceArtifactId, WorkstreamEvidenceOperationId } from './ids.ts'
export { WorkstreamEvidenceError } from './error.ts'
export type { WorkstreamEvidenceErrorCode } from './error.ts'
export type * from './types.ts'
export { WorkstreamEvidenceTools } from './tools.ts'
export { aggregateChangeRequests } from './forge-adapter.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workstreamEvidence: WorkstreamEvidenceService
  }
}

const defaults: Required<Config> = {
  maxBytesPerArtifact: 10 * 1024 * 1024,
  maxArtifacts: 256,
  maxVersionsPerArtifact: 64,
  maxTotalBytes: 100 * 1024 * 1024,
  maxContextPacketBytes: 65_536,
  maxToolTextBytes: 65_536,
}

function computeDigest(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/** Service managing durable, immutable Workstream evidence versions. */
export class WorkstreamEvidenceService extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'attachments', 'workstreams']
  static Config: z<Config> = z.object({
    maxBytesPerArtifact: z.number().step(1).min(1).default(defaults.maxBytesPerArtifact),
    maxArtifacts: z.number().step(1).min(1).default(defaults.maxArtifacts),
    maxVersionsPerArtifact: z.number().step(1).min(1).default(defaults.maxVersionsPerArtifact),
    maxTotalBytes: z.number().step(1).min(1).default(defaults.maxTotalBytes),
    maxContextPacketBytes: z.number().step(1).min(1).default(defaults.maxContextPacketBytes),
    maxToolTextBytes: z.number().step(1).min(1).default(defaults.maxToolTextBytes),
  })

  private readonly config: Required<Config>
  private projection!: ProjectionHandle<WorkstreamEvidenceProjectionState>
  private readonly tails = new Map<SessionId, Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workstreamEvidence')
    this.config = { ...defaults, ...config }
    for (const [key, value] of Object.entries(this.config)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new WorkstreamEvidenceError(`${key} must be a positive safe integer`, 'WORKSTREAM_EVIDENCE_INVALID_INPUT')
      }
    }
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(workstreamEvidenceProjectionDefinition)
    this.ctx.effect(() => () => this.shutdown(), 'workstreamEvidence.runtime()')
  }

  /**
   * Publish an immutable evidence version in the owning Workstream session.
   * Idempotent retry with same payload returns the existing version; changed payload is rejected.
   * @param caller - live Workstream member.
   * @param rootSessionId - Workstream root Session id.
   * @param request - artifact id, expected next version, operation id, and bounded content.
   * @returns The retained version record.
   */
  async publish(
    caller: Agent,
    rootSessionId: SessionId,
    request: PublishEvidenceRequest,
  ): Promise<WorkstreamEvidenceVersionRecord> {
    this.live(caller)
    const { owner } = this.ctx.workstreams.requireMembership(caller, rootSessionId)

    return this.enqueue(rootSessionId, async () => {
      this.live(caller)
      const artifactId = WorkstreamEvidenceArtifactId(request.artifactId)
      const operationId = WorkstreamEvidenceOperationId(request.operationId)

      if (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1) {
        throw new WorkstreamEvidenceError('expectedVersion must be a positive integer', 'WORKSTREAM_EVIDENCE_INVALID_INPUT')
      }

      const rawBytes = typeof request.content === 'string'
        ? Buffer.from(request.content, 'utf8')
        : request.content
      const bytes = new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength)

      if (bytes.byteLength > this.config.maxBytesPerArtifact) {
        throw new WorkstreamEvidenceError(
          `Artifact content exceeds maxBytesPerArtifact (${bytes.byteLength} > ${this.config.maxBytesPerArtifact})`,
          'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED',
        )
      }

      const digest = computeDigest(bytes)
      const snapshot = this.projection.stateOf(owner.session).snapshot ?? {
        ownerSessionId: owner.id,
        revision: 0,
        artifacts: [],
      }

      // Idempotency check across all versions in this workstream
      for (const existingArt of snapshot.artifacts) {
        for (const ver of existingArt.versions) {
          if (ver.operationId === operationId) {
            if (
              ver.artifactId === artifactId
              && ver.version === request.expectedVersion
              && ver.digest === digest
            ) {
              return structuredClone(ver)
            }
            throw new WorkstreamEvidenceError(
              `Operation ${operationId} already completed with different payload or version`,
              'WORKSTREAM_EVIDENCE_PAYLOAD_MISMATCH',
            )
          }
        }
      }

      const existingArtifact = snapshot.artifacts.find(a => a.artifactId === artifactId)
      if (existingArtifact === undefined) {
        if (request.expectedVersion !== 1) {
          throw new WorkstreamEvidenceError(
            `Expected version ${request.expectedVersion} but artifact ${artifactId} has no prior versions (expected 1)`,
            'WORKSTREAM_EVIDENCE_STALE_VERSION',
          )
        }
        if (snapshot.artifacts.length >= this.config.maxArtifacts) {
          throw new WorkstreamEvidenceError('Workstream exceeds maxArtifacts', 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED')
        }
      } else {
        const nextVersion = existingArtifact.latestVersion + 1
        if (request.expectedVersion !== nextVersion) {
          throw new WorkstreamEvidenceError(
            `Expected version ${request.expectedVersion} does not match next version ${nextVersion}`,
            'WORKSTREAM_EVIDENCE_STALE_VERSION',
          )
        }
        if (existingArtifact.versions.length >= this.config.maxVersionsPerArtifact) {
          throw new WorkstreamEvidenceError('Artifact exceeds maxVersionsPerArtifact', 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED')
        }
      }

      const totalExistingBytes = snapshot.artifacts.reduce(
        (sum, a) => sum + a.versions.reduce((s, v) => s + v.bytes, 0),
        0,
      )
      if (totalExistingBytes + bytes.byteLength > this.config.maxTotalBytes) {
        throw new WorkstreamEvidenceError('Workstream exceeds maxTotalBytes', 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED')
      }

      const displayName = request.name?.trim() || artifactId
      const fileRef = await this.ctx.attachments.saveFile({
        data: bytes,
        name: displayName,
      })

      const newVersion: WorkstreamEvidenceVersionRecord = {
        artifactId,
        version: request.expectedVersion,
        name: displayName,
        ref: String(fileRef.attachmentId),
        digest,
        bytes: bytes.byteLength,
        authorSessionId: caller.id,
        operationId,
        createdAt: new Date().toISOString(),
      }

      let newArtifacts: WorkstreamEvidenceArtifactRecord[]
      if (existingArtifact === undefined) {
        const newArtifactRecord: WorkstreamEvidenceArtifactRecord = {
          artifactId,
          latestVersion: 1,
          versions: [newVersion],
        }
        newArtifacts = [...snapshot.artifacts, newArtifactRecord]
      } else {
        const updatedArtifactRecord: WorkstreamEvidenceArtifactRecord = {
          ...existingArtifact,
          latestVersion: newVersion.version,
          versions: [...existingArtifact.versions, newVersion],
        }
        newArtifacts = snapshot.artifacts.map(a => (a.artifactId === artifactId ? updatedArtifactRecord : a))
      }

      const updatedSnapshot: WorkstreamEvidenceSnapshot = {
        ownerSessionId: owner.id,
        revision: snapshot.revision + 1,
        artifacts: newArtifacts,
      }

      appendPluginRecord(owner.session, WORKSTREAM_EVIDENCE_RECORD, { version: 1, snapshot: structuredClone(updatedSnapshot) })
      await this.ctx.sessions.flush(owner.session)

      return structuredClone(newVersion)
    })
  }

  /**
   * Get metadata for one retained evidence artifact version.
   * @param caller - live Workstream member.
   * @param rootSessionId - Workstream root Session id.
   * @param artifactId - logical artifact id.
   * @param version - version number, or undefined for the latest.
   * @returns The retained version record.
   */
  get(
    caller: Agent,
    rootSessionId: SessionId,
    artifactId: string,
    version?: number,
  ): WorkstreamEvidenceVersionRecord {
    this.live(caller)
    const { owner } = this.ctx.workstreams.requireMembership(caller, rootSessionId)
    const snapshot = this.projection.stateOf(owner.session).snapshot
    if (snapshot === null) {
      throw new WorkstreamEvidenceError(`Artifact ${artifactId} not found`, 'WORKSTREAM_EVIDENCE_NOT_FOUND')
    }

    const artifact = snapshot.artifacts.find(a => a.artifactId === artifactId)
    if (artifact === undefined) {
      throw new WorkstreamEvidenceError(`Artifact ${artifactId} not found`, 'WORKSTREAM_EVIDENCE_NOT_FOUND')
    }

    const targetVersion = version ?? artifact.latestVersion
    const record = artifact.versions.find(v => v.version === targetVersion)
    if (record === undefined) {
      throw new WorkstreamEvidenceError(
        `Version ${targetVersion} of artifact ${artifactId} not found`,
        'WORKSTREAM_EVIDENCE_NOT_FOUND',
      )
    }

    return structuredClone(record)
  }

  /**
   * List all evidence artifacts and version histories for one Workstream.
   * @param caller - live Workstream member.
   * @param rootSessionId - Workstream root Session id.
   * @returns Every retained artifact with its complete version history.
   */
  list(caller: Agent, rootSessionId: SessionId): readonly WorkstreamEvidenceArtifactRecord[] {
    this.live(caller)
    const { owner } = this.ctx.workstreams.requireMembership(caller, rootSessionId)
    const snapshot = this.projection.stateOf(owner.session).snapshot
    return structuredClone(snapshot?.artifacts ?? [])
  }

  /**
   * Read and verify immutable evidence content from attachments.
   * Validates digest and byte length before returning.
   * @param caller - live Workstream member.
   * @param rootSessionId - Workstream root Session id.
   * @param artifactId - logical artifact id.
   * @param version - version number, or undefined for the latest.
   * @param signal - aborts the attachment read.
   * @returns Version metadata and the verified bytes.
   */
  async read(
    caller: Agent,
    rootSessionId: SessionId,
    artifactId: string,
    version?: number,
    signal?: AbortSignal,
  ): Promise<{ metadata: WorkstreamEvidenceVersionRecord; data: Uint8Array }> {
    const metadata = this.get(caller, rootSessionId, artifactId, version)

    const fileRef: FileAttachmentRef = {
      attachmentId: metadata.ref as AttachmentId,
      name: metadata.name,
      bytes: metadata.bytes,
    }

    const chunks: Uint8Array[] = []
    let totalBytes = 0

    try {
      for await (const chunk of this.ctx.attachments.readFileStream(fileRef, signal)) {
        chunks.push(chunk)
        totalBytes += chunk.byteLength
        if (totalBytes > this.config.maxBytesPerArtifact) {
          throw new WorkstreamEvidenceError('Read content exceeds maxBytesPerArtifact', 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED')
        }
      }
    } catch (error) {
      if (error instanceof WorkstreamEvidenceError) throw error
      throw new WorkstreamEvidenceError(
        `Failed to read evidence bytes for ${artifactId} v${metadata.version}: ${error instanceof Error ? error.message : String(error)}`,
        'WORKSTREAM_EVIDENCE_CORRUPT',
        { cause: error },
      )
    }

    const combined = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }

    if (combined.byteLength !== metadata.bytes) {
      throw new WorkstreamEvidenceError(
        `Integrity failure: expected ${metadata.bytes} bytes, read ${combined.byteLength}`,
        'WORKSTREAM_EVIDENCE_CORRUPT',
      )
    }

    const computed = computeDigest(combined)
    if (computed !== metadata.digest) {
      throw new WorkstreamEvidenceError(
        `Digest mismatch: expected ${metadata.digest}, computed ${computed}`,
        'WORKSTREAM_EVIDENCE_CORRUPT',
      )
    }

    return { metadata: structuredClone(metadata), data: combined }
  }

  /**
   * Read one verified evidence version as UTF-8 text for model-visible output.
   * @param caller - live Workstream member.
   * @param rootSessionId - Workstream root Session id.
   * @param artifactId - logical artifact id.
   * @param version - version number, or undefined for the latest.
   * @param signal - aborts the attachment read.
   * @returns Version metadata and decoded text.
   * @throws WorkstreamEvidenceError `WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED` above `maxToolTextBytes`;
   * `WORKSTREAM_EVIDENCE_INVALID_INPUT` for bytes that are not valid UTF-8.
   */
  async readText(
    caller: Agent,
    rootSessionId: SessionId,
    artifactId: string,
    version?: number,
    signal?: AbortSignal,
  ): Promise<{ metadata: WorkstreamEvidenceVersionRecord; text: string }> {
    const metadata = this.get(caller, rootSessionId, artifactId, version)
    if (metadata.bytes > this.config.maxToolTextBytes) {
      throw new WorkstreamEvidenceError(
        `Evidence ${artifactId} v${metadata.version} has ${metadata.bytes} bytes, above the ${this.config.maxToolTextBytes}-byte text read limit`,
        'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED',
      )
    }
    const { data } = await this.read(caller, rootSessionId, artifactId, metadata.version, signal)
    try {
      return { metadata, text: new TextDecoder('utf-8', { fatal: true }).decode(data) }
    } catch (error) {
      throw new WorkstreamEvidenceError(`Evidence ${artifactId} v${metadata.version} is not UTF-8 text`, 'WORKSTREAM_EVIDENCE_INVALID_INPUT', { cause: error })
    }
  }

  /**
   * Construct a bounded WorkstreamContextPacket from exact retained evidence versions.
   * Rejects mutable or foreign links.
   * @param caller - live Workstream member.
   * @param rootSessionId - Workstream root Session id.
   * @param request - packet fields and the exact artifact versions to include.
   * @returns A packet whose artifacts carry retained refs and digests.
   */
  prepareContext(
    caller: Agent,
    rootSessionId: SessionId,
    request: PrepareContextRequest,
  ): WorkstreamContextPacket {
    this.live(caller)
    this.ctx.workstreams.requireMembership(caller, rootSessionId)

    const resolvedArtifacts: { ref: string; digest: string }[] = []
    for (const item of request.artifacts) {
      if (
        item.artifactId.includes('/')
        || item.artifactId.includes('\\')
        || item.artifactId.startsWith('file:')
        || item.artifactId.includes('..')
      ) {
        throw new WorkstreamEvidenceError(
          `Mutable or foreign link rejected in context packet: ${item.artifactId}`,
          'WORKSTREAM_EVIDENCE_INVALID_INPUT',
        )
      }

      const meta = this.get(caller, rootSessionId, item.artifactId, item.version)
      resolvedArtifacts.push({
        ref: meta.ref,
        digest: meta.digest,
      })
    }

    const packet: WorkstreamContextPacket = {
      requirements: request.requirements,
      decisions: [...request.decisions],
      cursor: request.cursor,
      changes: request.changes,
      artifacts: resolvedArtifacts,
    }

    const packetBytes = Buffer.byteLength(JSON.stringify(packet), 'utf8')
    if (packetBytes > this.config.maxContextPacketBytes) {
      throw new WorkstreamEvidenceError(
        `Context packet exceeds maxContextPacketBytes (${packetBytes} > ${this.config.maxContextPacketBytes})`,
        'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED',
      )
    }

    return packet
  }

  /**
   * Aggregate change request bindings across the root and active member Sessions.
   * @param caller - live Workstream member.
   * @param rootSessionId - Workstream root Session id.
   * @returns Deduplicated change requests, diagnostics, and whether every Session was read.
   */
  aggregateChangeRequests(
    caller: Agent,
    rootSessionId: SessionId,
  ): AggregatedChangeRequestsResult {
    return aggregateChangeRequests(this.ctx, caller, rootSessionId)
  }

  private live(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new WorkstreamEvidenceError('Caller Agent is not live', 'WORKSTREAM_EVIDENCE_UNAUTHORIZED')
    }
  }

  private enqueue<T>(root: SessionId, action: () => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) {
      return Promise.reject(new WorkstreamEvidenceError('Workstream evidence service has stopped', 'WORKSTREAM_EVIDENCE_DISPOSED'))
    }
    const prior = this.tails.get(root) ?? Promise.resolve()
    const run = prior.then(action)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(root, tail)
    this.pending.add(run)
    void tail.then(() => {
      this.pending.delete(run)
      if (this.tails.get(root) === tail) this.tails.delete(root)
    })
    return run
  }

  private async shutdown(): Promise<void> {
    this.lifetime.abort(new WorkstreamEvidenceError('Workstream evidence service is stopping', 'WORKSTREAM_EVIDENCE_DISPOSED'))
    await Promise.allSettled([...this.pending])
  }
}

export default WorkstreamEvidenceService
