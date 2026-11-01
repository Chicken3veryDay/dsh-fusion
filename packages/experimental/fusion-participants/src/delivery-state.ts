/** Required delivery records and deterministic log-only recovery state. */
import { isDeepStrictEqual } from 'node:util'
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
const rootEntry = z.strictObject({ intent: intentSchema, intentSeq: seq, completion: completionSchema.nullable() }).refine(row =>
  row.completion === null || row.completion.deliveryId === row.intent.deliveryId
    && row.completion.contentHash === row.intent.contentHash && row.completion.order === row.intent.order
    && row.completion.decisionInputRevision === row.intent.decisionInputRevision
    && row.completion.targetParticipantId === row.intent.targetParticipantId)

const rootStateSchema = z.strictObject({ sessionId, entries: z.array(rootEntry) }).refine(state =>
  new Set(state.entries.map(row => row.intent.deliveryId)).size === state.entries.length
  && state.entries.every((row, index) => row.intent.rootSessionId === state.sessionId
    && row.intent.order === index + 1 && row.intent.decisionInputRevision === index + 1
    && (row.intentSeq > (state.entries[index - 1]?.intentSeq ?? -1))))
/** All ordinary text stays classification-pending independently of transport completion. */
export type AdmissionState = z.infer<typeof rootStateSchema>
const receiverEntry = z.strictObject({ intent: intentSchema, acceptanceSeq: seq, instructionSeq: seq.nullable() })
const callSchema = z.strictObject({ id: z.string(), turn: z.number(), step: z.number(), started: seq.nullable() })
const receiverStateSchema = z.strictObject({
  sessionId, entries: z.array(receiverEntry), turn: z.number().nullable(), step: z.number().nullable(), calls: z.array(callSchema),
}).refine(state => new Set(state.entries.map(row => row.intent.deliveryId)).size === state.entries.length
  && state.entries.every((row, index) => row.intent.targetParticipantId === state.sessionId
    && (row.instructionSeq === null ? index === state.entries.length - 1 : row.instructionSeq > row.acceptanceSeq)
    && (row.acceptanceSeq > (state.entries[index - 1]?.acceptanceSeq ?? -1))))
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
  return isDeepStrictEqual(left, right)
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
  init: header => ({ sessionId: header.id, entries: [], turn: null, step: null, calls: [] }),
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
    if (pending !== undefined) {
      const stepEnd = event.type === 'step/end' && state.turn === event.data.turn && state.step === event.data.step
        && state.calls.length === 0
      const turnEnd = event.type === 'turn/end' && state.turn === event.data.turn && state.step === null
        && state.calls.length === 0 && event.data.reason.kind === 'interrupted'
      const toolResult = event.type === 'tool/result' && state.calls.some(call => call.id === event.data.message.toolCallId
        && event.data.turn === call.turn && event.data.step === call.step && event.surfaceOp === 'append'
        && event.data.message.isError === true && same(event.data.message.source, { kind: 'tool', callId: call.id })
        && String(event.data.message.id) === `interrupted-tool-result-${call.id}-${event.seq}`
        && event.data.error?.code === (call.started === null ? 'TOOL_NOT_STARTED' : 'TOOL_OUTCOME_UNKNOWN')
        && same(event.sourceEventSeqs, call.started === null ? undefined : [call.started]))
      if (event.type !== 'session/end-seed' && !stepEnd && !turnEnd && !toolResult) throw new Error('interleaving pending delivery')
    }
    switch (event.type) {
      case 'turn/start': return { ...state, turn: event.data.turn, step: null, calls: [] }
      case 'step/start': return { ...state, step: event.data.step }
      case 'step/end': return { ...state, step: null, calls: [] }
      case 'turn/end': return { ...state, turn: null, step: null, calls: [] }
      case 'assistant/message': return { ...state, calls: [...state.calls,
        ...event.data.message.content.filter(block => block.type === 'tool-call').map(block => ({
          id: String(block.id), turn: event.data.turn, step: event.data.step, started: null,
        }))] }
      case 'tool/call': return { ...state, calls: state.calls.map(call => call.id === event.data.callId ? { ...call, started: event.seq } : call) }
      case 'tool/result': return { ...state, calls: state.calls.filter(call => call.id !== event.data.message.toolCallId) }
      default: return state
    }
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
