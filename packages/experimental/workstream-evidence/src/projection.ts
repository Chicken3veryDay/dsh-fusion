/** Deterministic Workstream Evidence recovery and schema-validated browser projection. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { pluginRecordOf, type SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { WorkstreamEvidenceArtifactId, WorkstreamEvidenceOperationId } from './ids.ts'
import type {
  WorkstreamEvidenceArtifactRecord,
  WorkstreamEvidenceSnapshot,
  WorkstreamEvidenceVersionRecord,
} from './types.ts'

const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
const artifactId = z.string().min(1).max(200).transform(WorkstreamEvidenceArtifactId)
const operationId = z.string().min(1).max(200).transform(WorkstreamEvidenceOperationId)

const versionRecordSchema: z.ZodType<WorkstreamEvidenceVersionRecord> = z.object({
  artifactId,
  version: z.number().int().positive(),
  name: z.string().min(1),
  ref: z.string().min(1),
  digest: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  authorSessionId: sessionId,
  operationId,
  createdAt: z.string().min(1),
}).strict()

const artifactRecordSchema: z.ZodType<WorkstreamEvidenceArtifactRecord> = z.object({
  artifactId,
  latestVersion: z.number().int().positive(),
  versions: z.array(versionRecordSchema),
}).strict()

const snapshotSchema: z.ZodType<WorkstreamEvidenceSnapshot> = z.object({
  ownerSessionId: sessionId,
  revision: z.number().int().positive(),
  artifacts: z.array(artifactRecordSchema),
}).strict()

const stateSchema = z.object({ ownerSessionId: sessionId, snapshot: snapshotSchema.nullable() }).strict()

/** Private checkpoint state; consumers read through WorkstreamEvidenceService. */
export type WorkstreamEvidenceProjectionState = z.infer<typeof stateSchema>

/** Plugin record type for evidence state. */
export const WORKSTREAM_EVIDENCE_RECORD = 'plugin:workstream-evidence/state'

/** Workstream evidence events are selected by immutable root id. */
export const workstreamEvidenceProjectionDefinition = {
  key: 'workstreamEvidence',
  stateVersion: 1,
  stateSchema,
  init: header => ({ ownerSessionId: header.id, snapshot: null }),
  apply: (state, event) => {
    const record = pluginRecordOf(event)
    if (record?.type !== WORKSTREAM_EVIDENCE_RECORD) return state
    const data = z.object({ version: z.literal(1), snapshot: snapshotSchema }).strict().parse(record.data)
    if (data.snapshot.ownerSessionId !== state.ownerSessionId) return state
    if (data.snapshot.revision !== (state.snapshot?.revision ?? 0) + 1) {
      throw new Error('Workstream evidence revision is not contiguous')
    }
    return { ownerSessionId: state.ownerSessionId, snapshot: data.snapshot }
  },
  wire: { viewSchema: snapshotSchema.nullable(), view: state => state.snapshot },
} satisfies ProjectionDefinition<'workstreamEvidence', WorkstreamEvidenceProjectionState>
