/** Required delivery records and deterministic log-only recovery state. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const sessionId = z.string().min(1).transform(SessionId)
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)
/** Stable caller retry identity, independent of the generated message identity. */
export const deliveryIdSchema = z.string().min(1).max(256).brand<'FusionDeliveryId'>()
/** Host-ingress delivery identity. */
export type DeliveryId = z.infer<typeof deliveryIdSchema>
const hash = z.string().regex(/^[a-f0-9]{64}$/u).brand<'FusionContentHash'>()
const ordinal = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).brand<'FusionDeliveryOrder'>()
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).brand<'FusionInputRevision'>()
const originSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('peer'), sessionId }),
])
/** Authenticated original author; the root remains the transport owner. */
export type DeliveryOrigin = z.infer<typeof originSchema>
const fields = {
  rootSessionId: sessionId, deliveryId: deliveryIdSchema, origin: originSchema,
  targetParticipantId: sessionId, inboxTarget: z.enum(['next-turn', 'next-step']),
  correlationId: z.string().nullable(), contentHash: hash, order: ordinal, decisionInputRevision: revision,
}
const sourceSchema = z.strictObject({ kind: z.literal('fusion-delivery'), form: z.literal('relay'), ...fields })
/** Producer-owned source retained unchanged in root, receiver, inbox and SDK logs. */
export type DeliverySource = z.infer<typeof sourceSchema>
const instructionSchema = z.strictObject({
  id: z.string().min(1).transform(MessageId), role: z.literal('user'),
  content: z.tuple([z.strictObject({ type: z.literal('text'), text: z.string() })]), source: sourceSchema,
})
/** Complete reconstruction record; unknown fields and inconsistent hashes refuse replay. */
export const intentSchema = z.strictObject({
  version: z.literal(1), ...fields, text: z.string(), instruction: instructionSchema,
}).superRefine((value, ctx) => {
  const { instruction, version: _version, text, ...source } = value
  if (contentHash(value) !== value.contentHash || instruction.content[0].text !== text
    || !same(instruction.source, { kind: 'fusion-delivery', form: 'relay', ...source })
    || String(instruction.id) === String(value.deliveryId)) ctx.addIssue({ code: 'custom', message: 'inconsistent delivery reconstruction' })
})
/** Immutable root intent and receiver acceptance payload. */
export type DeliveryIntent = z.infer<typeof intentSchema>
/** Root completion references a structurally paired receiver prefix, never a reusable writer proof. */
export const completionSchema = z.strictObject({
  deliveryId: deliveryIdSchema, contentHash: hash, order: ordinal, decisionInputRevision: revision,
  targetParticipantId: sessionId, acceptanceSeq: seq, instructionSeq: seq,
  receiverBoundary: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).refine(value => value.instructionSeq > value.acceptanceSeq && value.receiverBoundary > value.instructionSeq)
/** Durable sender receipt data. */
export type DeliveryCompletion = z.infer<typeof completionSchema>
const rootEntry = z.strictObject({ intent: intentSchema, intentSeq: seq, completion: completionSchema.nullable() })
const rootStateSchema = z.strictObject({ sessionId, entries: z.array(rootEntry) })
/** All ordinary text stays classification-pending independently of transport completion. */
export type AdmissionState = z.infer<typeof rootStateSchema>
const receiverEntry = z.strictObject({ intent: intentSchema, acceptanceSeq: seq, instructionSeq: seq.nullable() })
const receiverStateSchema = z.strictObject({ sessionId, entries: z.array(receiverEntry) })
/** Permanent delivery identities survive inbox consumption, cancellation and model compaction. */
export type ReceiverState = z.infer<typeof receiverStateSchema>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'fusion-delivery': DeliverySource }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required root input and sender outbox intent; log-only. */
    'fusion/delivery-intent': DeliveryIntent
    /** Required receiver reconstruction data, pending until its matching inbox insertion. */
    'fusion/delivery-accepted': DeliveryIntent
    /** Required root transport completion; neither classification nor effect settlement. */
    'fusion/delivery-completed': DeliveryCompletion
  }
}

/**
 * Compare JSON facts independent of object property insertion order.
 * @param left - first retained JSON value.
 * @param right - second retained JSON value.
 * @returns whether both values carry identical fields and scalar values.
 */
export function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value: unknown, index) => same(value, right[index]))
  }
  const l = Object.entries(left)
  const r = Object.entries(right)
  return l.length === r.length && l.every(([key, value]) => r.some(([other, v]) => key === other && same(value, v)))
}

/**
 * Hash exact text, authenticated origin and routing as a positional UTF-8 tuple.
 * @param input - immutable caller facts and owning root.
 * @returns SHA256 hex digest; no text normalization occurs.
 */
export function contentHash(input: {
  rootSessionId: SessionId
  origin: DeliveryOrigin
  targetParticipantId: SessionId
  inboxTarget: 'next-turn' | 'next-step'
  correlationId: string | null
  text: string
}): string {
  const origin = input.origin.kind === 'user' ? ['user'] : ['peer', input.origin.sessionId]
  return createHash('sha256').update(JSON.stringify([1, input.rootSessionId, origin,
    input.targetParticipantId, input.inboxTarget, input.correlationId, input.text])).digest('hex')
}

/** Root input/outbox projection; transport completion never removes the original input. */
export const admissionProjection = {
  key: 'fusionAdmissions', stateVersion: 1, stateSchema: rootStateSchema,
  init: header => ({ sessionId: header.id, entries: [] }),
  apply(state, event) {
    if (event.type === 'fusion/delivery-intent') {
      const intent = intentSchema.parse(event.data)
      const last = state.entries.at(-1)
      if (intent.rootSessionId !== state.sessionId || state.entries.some(row => row.intent.deliveryId === intent.deliveryId)
        || intent.order !== (last?.intent.order ?? 0) + 1
        || intent.decisionInputRevision !== (last?.intent.decisionInputRevision ?? 0) + 1) throw new Error('invalid root delivery intent')
      return { ...state, entries: [...state.entries, { intent, intentSeq: event.seq, completion: null }] }
    }
    if (event.type === 'fusion/delivery-completed') {
      const completion = completionSchema.parse(event.data)
      const entry = state.entries.find(row => row.intent.deliveryId === completion.deliveryId)
      if (entry === undefined || entry.completion !== null
        || completion.contentHash !== entry.intent.contentHash || completion.order !== entry.intent.order
        || completion.decisionInputRevision !== entry.intent.decisionInputRevision
        || completion.targetParticipantId !== entry.intent.targetParticipantId) throw new Error('invalid root delivery completion')
      return { ...state, entries: state.entries.map(row => row === entry ? { ...row, completion } : row) }
    }
    return state
  },
} satisfies ProjectionDefinition<'fusionAdmissions', AdmissionState>

/** Receiver projection tracks the original insertion, never just the current pending inbox. */
export const receiverProjection = {
  key: 'fusionDeliveries', stateVersion: 1, stateSchema: receiverStateSchema,
  init: header => ({ sessionId: header.id, entries: [] }),
  apply(state, event) {
    const pending = state.entries.find(row => row.instructionSeq === null)
    if (event.type === 'fusion/delivery-accepted') {
      const intent = intentSchema.parse(event.data)
      if (pending !== undefined || intent.targetParticipantId !== state.sessionId
        || state.entries.some(row => row.intent.deliveryId === intent.deliveryId)) throw new Error('invalid receiver acceptance')
      return { ...state, entries: [...state.entries, { intent, acceptanceSeq: event.seq, instructionSeq: null }] }
    }
    if (event.type === 'agent/inbox/spliced') {
      const inserted = event.data.inserted.filter(message => message.source.kind === 'fusion-delivery')
      if (inserted.length > 0) {
        if (pending === undefined || inserted.length !== 1 || event.data.inserted.length !== 1
          || event.data.target !== pending.intent.inboxTarget || (event.data.removedCount ?? 0) !== 0
          || !same(inserted[0], pending.intent.instruction)) throw new Error('orphan or conflicting delivery instruction')
        return { ...state, entries: state.entries.map(row => row === pending ? { ...row, instructionSeq: event.seq } : row) }
      }
    }
    if (pending !== undefined && event.type !== 'session/end-seed') throw new Error('interleaving pending delivery')
    return state
  },
} satisfies ProjectionDefinition<'fusionDeliveries', ReceiverState>

/**
 * Admit a retry identity at host ingress.
 * @param value - stable caller identity, retained across retries.
 * @returns validated delivery identity.
 */
export function DeliveryId(value: string): DeliveryId { return deliveryIdSchema.parse(value) }

/** Trusted host text admission; no caller-supplied source, order or classification. */
export interface TextDelivery {
  readonly deliveryId: DeliveryId
  readonly targetParticipantId: SessionId
  readonly inboxTarget: 'next-turn' | 'next-step'
  readonly correlationId: string | null
  readonly text: string
}

/**
 * Construct an immutable instruction once from trusted typed host facts.
 * @param input - captured ingress text and routing.
 * @param rootSessionId - owning task root.
 * @param origin - authenticated author.
 * @param order - reserved root order.
 * @returns complete reconstructable intent with a fresh independent MessageId.
 */
export function createIntent(input: TextDelivery, rootSessionId: SessionId, origin: DeliveryOrigin, order: number): DeliveryIntent {
  const source: DeliverySource = {
    kind: 'fusion-delivery', form: 'relay', rootSessionId, deliveryId: input.deliveryId, origin,
    targetParticipantId: input.targetParticipantId, inboxTarget: input.inboxTarget, correlationId: input.correlationId,
    contentHash: hash.parse(contentHash({ ...input, rootSessionId, origin })),
    order: ordinal.parse(order), decisionInputRevision: revision.parse(order),
  }
  const content: [{ type: 'text'; text: string }] = [{ type: 'text', text: input.text }]
  const instruction = createUserMessage({ content, source })
  const { kind: _kind, form: _form, ...facts } = source
  return { version: 1, ...facts, text: input.text, instruction }
}
