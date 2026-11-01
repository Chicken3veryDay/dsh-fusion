/** Required log-only task execution facts; folding never invokes a host adapter. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const sessionId = z.string().min(1).transform(SessionId)
const incarnation = z.uuid().brand<'FusionIncarnation'>()
const run = z.uuid().brand<'FusionRun'>()
const attempt = z.uuid().brand<'FusionAttempt'>()
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).brand<'FusionGeneration'>()
const identity = { rootSessionId: sessionId, incarnation }
const attemptIdentity = { ...identity, participantId: sessionId, runId: run, attemptId: attempt, generation: generation.nullable() }
/** Task incarnation and opening nonce, not OS boot identity; recovery never revives old grants. */
export const openedSchema = z.strictObject({ version: z.literal(1), ...identity, openingId: z.uuid(), previous: incarnation.nullable() })
/** Durable grant facts carry no executable authority. */
export const grantedSchema = z.strictObject({ ...identity, generation, participantId: sessionId, previousRevoke: generation.nullable() })
/** A synchronous memory cut precedes this record's durable acknowledgement. */
export const revokedSchema = z.strictObject({ ...identity, generation: generation.nullable(), reason: z.enum(['handoff', 'stop', 'cancel']), stopped: z.boolean() })
  .refine(row => row.stopped === (row.reason === 'stop'))
/** Host-classified effect intent, persisted on its originating Session before dispatch. */
export const startedSchema = z.strictObject({
  ...attemptIdentity, adapter: z.string().min(1).max(128), revision: z.string().min(1).max(128),
  classification: z.enum(['read', 'mutation', 'infrastructure']), requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).refine(row => row.classification === 'mutation' ? row.generation !== null : row.generation === null)
/** Producer settlement; an uncertain outcome never certifies cleanup. */
export const settledSchema = z.strictObject({ ...attemptIdentity, outcome: z.enum(['not-dispatched', 'completed', 'failed', 'uncertain']) })
/** Independent evidence preserves the absent producer outcome. */
export const reconciledSchema = z.strictObject({ ...attemptIdentity, evidenceId: z.uuid(), source: z.string().min(1).max(128),
  disposition: z.enum(['completed', 'not-executed']) })
/** Persisted execution incarnation identity. */
export type ExecutionIncarnation = z.infer<typeof incarnation>
/** Persisted attempt identity; never a live capability. */
export type ExecutionAttemptId = z.infer<typeof attempt>
/** Durable start facts. */
export type EffectStarted = z.infer<typeof startedSchema>
/** Durable producer outcome. */
export type EffectSettled = z.infer<typeof settledSchema>

const entrySchema = z.strictObject({
  start: startedSchema, settlement: settledSchema.nullable(), reconciliation: reconciledSchema.nullable(),
})
const rootRecordSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('opened'), data: openedSchema }),
  z.strictObject({ type: z.literal('granted'), data: grantedSchema }),
  z.strictObject({ type: z.literal('revoked'), data: revokedSchema }),
])
const baseStateSchema = z.strictObject({
  sessionId, opened: openedSchema.nullable(), lastGeneration: generation.nullable(),
  grant: grantedSchema.nullable(), revoke: revokedSchema.nullable(), entries: z.array(entrySchema),
  history: z.array(rootRecordSchema),
})
type BaseState = z.infer<typeof baseStateSchema>

function emptyState(id: SessionId): BaseState {
  return { sessionId: id, opened: null, lastGeneration: null, grant: null, revoke: null, entries: [], history: [] }
}

function applyRoot(state: BaseState, record: z.infer<typeof rootRecordSchema>): BaseState {
  switch (record.type) {
    case 'opened': {
      const opened = record.data
      if (opened.rootSessionId !== state.sessionId || opened.previous !== (state.opened?.incarnation ?? null)
        || state.history.some(row => row.type === 'opened' && row.data.incarnation === opened.incarnation)) throw new Error('invalid execution incarnation')
      return { ...state, opened, grant: null, revoke: null, history: [...state.history, record] }
    }
    case 'granted': {
      const grant = record.data
      if (state.opened === null || grant.rootSessionId !== state.sessionId || grant.incarnation !== state.opened.incarnation
        || grant.generation !== (state.lastGeneration ?? 0) + 1 || state.grant !== null
        || grant.previousRevoke !== (state.revoke?.generation ?? null) || state.revoke?.stopped === true) throw new Error('invalid execution grant')
      return { ...state, lastGeneration: grant.generation, grant, history: [...state.history, record] }
    }
    case 'revoked': {
      const revoke = record.data
      if (state.opened === null || revoke.rootSessionId !== state.sessionId || revoke.incarnation !== state.opened.incarnation
        || revoke.generation !== (state.grant?.generation ?? null) || state.revoke?.stopped === true) throw new Error('invalid execution revoke')
      return { ...state, grant: null, revoke, history: [...state.history, record] }
    }
  }
}

const stateSchema = baseStateSchema.refine((state) => {
  let replay = emptyState(state.sessionId)
  try {
    for (const record of state.history) replay = applyRoot(replay, record)
  } catch (_error: unknown) {
    // Invalid persisted transitions cannot restore a usable checkpoint.
    return false
  }
  return isDeepStrictEqual({ ...state, entries: [] }, replay)
    && new Set(state.entries.map(entry => entry.start.attemptId)).size === state.entries.length
    && state.entries.every(row => row.start.participantId === state.sessionId
      && (row.settlement === null || sameAttempt(row.start, row.settlement))
      && (row.reconciliation === null || (row.settlement === null || row.settlement.outcome === 'uncertain')
        && row.reconciliation.source === row.start.adapter
        && sameAttempt(row.start, { ...row.reconciliation, outcome: 'uncertain' })))
})
/** Historical facts only; current authority belongs exclusively to the live owner. */
export type ExecutionState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required root incarnation; log-only, never activation. */
    'fusion/execution-opened': z.infer<typeof openedSchema>
    /** Required historical grant; recovery initializes admission closed. */
    'fusion/execution-granted': z.infer<typeof grantedSchema>
    /** Required root revocation; drain remains a live obligation. */
    'fusion/execution-revoked': z.infer<typeof revokedSchema>
    /** Required originating Session intent before external invocation. */
    'fusion/effect-started': EffectStarted
    /** Required originating producer outcome, independently durable. */
    'fusion/effect-settled': EffectSettled
    /** Required independent evidence; never fabricates a producer settlement. */
    'fusion/effect-reconciled': z.infer<typeof reconciledSchema>
  }
}

function sameAttempt(left: EffectStarted, right: EffectSettled): boolean {
  return left.rootSessionId === right.rootSessionId && left.participantId === right.participantId
    && left.incarnation === right.incarnation && left.runId === right.runId
    && left.attemptId === right.attemptId && left.generation === right.generation
}

/** Strict local history; the owner verifies root/participant links after all retained leases load. */
export const executionProjection = {
  key: 'fusionExecution', stateVersion: 1, stateSchema,
  init: header => emptyState(header.id),
  apply(state, event) {
    switch (event.type) {
      case 'fusion/execution-opened': return applyRoot(state, { type: 'opened', data: openedSchema.parse(event.data) })
      case 'fusion/execution-granted': return applyRoot(state, { type: 'granted', data: grantedSchema.parse(event.data) })
      case 'fusion/execution-revoked': return applyRoot(state, { type: 'revoked', data: revokedSchema.parse(event.data) })
      case 'fusion/effect-started': {
        const start = startedSchema.parse(event.data)
        if (start.participantId !== state.sessionId || state.entries.some(entry => entry.start.attemptId === start.attemptId)) throw new Error('invalid effect start')
        return { ...state, entries: [...state.entries, { start, settlement: null, reconciliation: null }] }
      }
      case 'fusion/effect-settled': {
        const settlement = settledSchema.parse(event.data)
        const entry = state.entries.find(row => row.start.attemptId === settlement.attemptId)
        if (entry === undefined || entry.settlement !== null || entry.reconciliation !== null || !sameAttempt(entry.start, settlement)) throw new Error('invalid effect settlement')
        return { ...state, entries: state.entries.map(row => row === entry ? { ...row, settlement } : row) }
      }
      case 'fusion/effect-reconciled': {
        const reconciliation = reconciledSchema.parse(event.data)
        const entry = state.entries.find(row => row.start.attemptId === reconciliation.attemptId)
        if (entry === undefined || reconciliation.source !== entry.start.adapter || entry.reconciliation !== null || entry.settlement !== null && entry.settlement.outcome !== 'uncertain'
          || !sameAttempt(entry.start, { ...reconciliation, outcome: 'uncertain' })) throw new Error('invalid effect reconciliation')
        return { ...state, entries: state.entries.map(row => row === entry ? { ...row, reconciliation } : row) }
      }
      default: return state
    }
  },
} satisfies ProjectionDefinition<'fusionExecution', ExecutionState>
