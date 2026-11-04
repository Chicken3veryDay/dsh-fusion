/** Deterministic Workstream recovery and schema-validated browser projection. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { WorkstreamOperationId } from './ids.ts'
import type { WorkstreamSnapshot } from './types.ts'

const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
const operationId = z.string().min(1).max(200).transform(WorkstreamOperationId)
const messageId = z.string().min(1).transform(value => brandString<MessageId>(value))
const snapshotSchema: z.ZodType<WorkstreamSnapshot> = z.object({
  ownerSessionId: sessionId,
  coordinatorId: sessionId,
  operationId,
  revision: z.number().int().positive(),
  title: z.string().min(1),
  members: z.array(z.object({
    id: sessionId, name: z.string().min(1), role: z.enum(['owner', 'member']), diagnostic: z.string().nullable(),
    description: z.string(), provider: z.string().min(1),
    operationId, prompt: z.string(), phase: z.enum(['provisioning', 'active', 'stopping', 'stopped']),
  }).strict()),
  messages: z.array(z.object({
    operationId, senderId: sessionId, targetId: sessionId, text: z.string(), diagnostic: z.string().nullable(),
    context: z.object({ requirements: z.string(), decisions: z.array(z.string()), cursor: z.string(), changes: z.string(),
      artifacts: z.array(z.object({ ref: z.string(), digest: z.string() }).strict()) }).strict().nullable(),
    delivery: z.discriminatedUnion('phase', [
      z.object({ phase: z.literal('intent') }).strict(),
      z.object({ phase: z.literal('accepted'), messageId }).strict(),
      z.object({ phase: z.literal('processed'), messageId }).strict(),
    ]),
  }).strict()),
}).strict()

const stateSchema = z.object({ ownerSessionId: sessionId, snapshot: snapshotSchema.nullable() }).strict()

/** Private checkpoint state; consumers read through WorkstreamService. */
export type WorkstreamProjectionState = z.infer<typeof stateSchema>

/** Workstream events are selected by immutable root id; inherited records are ignored. */
export const workstreamProjectionDefinition = {
  key: 'workstream', stateVersion: 1, stateSchema,
  init: header => ({ ownerSessionId: header.id, snapshot: null }),
  apply: (state, event) => {
    if (event.type !== 'workstream/state' || event.data.snapshot.ownerSessionId !== state.ownerSessionId) return state
    const data = z.object({ version: z.literal(1), snapshot: snapshotSchema }).strict().parse(event.data)
    if (data.snapshot.revision !== (state.snapshot?.revision ?? 0) + 1) throw new Error('Workstream revision is not contiguous')
    if (state.snapshot !== null && data.snapshot.operationId !== state.snapshot.operationId) throw new
    Error('Workstream creation identity changed')
    return { ownerSessionId: state.ownerSessionId, snapshot: data.snapshot }
  },
  wire: { viewSchema: snapshotSchema.nullable(), view: state => state.snapshot },
} satisfies ProjectionDefinition<'workstream', WorkstreamProjectionState>
