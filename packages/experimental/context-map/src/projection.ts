/**
 * Deterministic recovery of the project map from `context-map/state` events. Every edit logs the
 * complete snapshot; replay keeps its content and the last explicitly acknowledged index digest,
 * counts the claims made for the same curation work, and checks that revisions are contiguous.
 */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContextSectionId } from '@deepseek-ai/dsh-experimental-context-index/types'
import type { MapGroupId, MapNoteId, MapOp, MapPendingId, MapSnapshot } from './types.ts'

const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
const sectionId = z.string().regex(/^sec_[0-9a-f]{16}$/).transform(value => brandString<ContextSectionId>(value))
const groupId = z.string().min(1).transform(value => brandString<MapGroupId>(value))
const noteId = z.string().min(1).transform(value => brandString<MapNoteId>(value))
const pendingId = z.string().min(1).transform(value => brandString<MapPendingId>(value))

const cite = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('section'), id: sectionId, hash: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('evidence'), ref: z.string().min(1) }).strict(),
])

const snapshotSchema: z.ZodType<MapSnapshot> = z.object({
  ownerSessionId: sessionId,
  revision: z.number().int().positive(),
  curatorId: sessionId.nullable(),
  route: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
  }).strict().nullable(),
  indexDigest: z.string().min(1).nullable(),
  core: z.array(sectionId),
  groups: z.array(z.object({
    id: groupId,
    path: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
    sections: z.array(sectionId),
    tools: z.array(z.string().min(1)),
    notes: z.array(z.object({ id: noteId, text: z.string().min(1), cites: z.array(cite).min(1) }).strict()),
  }).strict()),
  pending: z.array(z.object({ id: pendingId, text: z.string().min(1), cites: z.array(cite), by: sessionId }).strict()),
}).strict() as z.ZodType<MapSnapshot>

const opSchema: z.ZodType<MapOp> = z.object({
  kind: z.enum([
    'claim', 'release', 'index-ack', 'group-set', 'group-merge', 'group-retire', 'note-add', 'note-verify',
    'note-retire', 'note-pending', 'note-file', 'pending-drop', 'core-set',
  ]),
  actor: sessionId,
  target: z.string().min(1).optional(),
  work: z.string().min(1).optional(),
}).strict() as z.ZodType<MapOp>

const stateSchema = z.object({
  ownerSessionId: sessionId,
  snapshot: snapshotSchema.nullable(),
  /** Claims made for the newest curation work, so retries stay bounded across restarts. */
  attempts: z.object({ work: z.string().min(1), count: z.number().int().positive() }).strict().nullable(),
}).strict()

/** Private checkpoint state; consumers read through `ContextMapService`. */
export type ContextMapProjectionState = z.infer<typeof stateSchema>

/** Projection key; host-only, so no client sees it. */
export const CONTEXT_MAP_PROJECTION_KEY = 'contextMap'

/**
 * Unit that follows `context-map/state`. Records for another root Session, such as the ones a seeded
 * child inherits, are ignored; a record that skips a revision or fails the schema is an error.
 */
export const contextMapProjectionDefinition = {
  key: CONTEXT_MAP_PROJECTION_KEY,
  stateVersion: 3,
  stateSchema,
  init: header => ({ ownerSessionId: header.id, snapshot: null, attempts: null }),
  apply: (state, event) => {
    if (event.type !== 'context-map/state' || event.data.snapshot.ownerSessionId !== state.ownerSessionId) return state
    const data = z.object({ version: z.literal(1), op: opSchema, snapshot: snapshotSchema }).strict().parse(event.data)
    if (data.snapshot.revision !== (state.snapshot?.revision ?? 0) + 1) throw new Error('Context map revision is not contiguous')
    // Older claims stamped their observed digest before curation completed. Only an explicit
    // acknowledgement establishes completion, including when refolding an older checkpoint.
    const indexDigest = data.op.kind === 'index-ack' ? data.snapshot.indexDigest : state.snapshot?.indexDigest ?? null
    // A claim names the work it serves; the same work claimed again is a retry, anything else starts a count.
    const work = data.op.kind === 'claim' ? data.op.work : undefined
    const attempts = work === undefined ? state.attempts
      : { work, count: state.attempts?.work === work ? state.attempts.count + 1 : 1 }
    return { ownerSessionId: state.ownerSessionId, snapshot: { ...data.snapshot, indexDigest }, attempts }
  },
} satisfies ProjectionDefinition<typeof CONTEXT_MAP_PROJECTION_KEY, ContextMapProjectionState>
