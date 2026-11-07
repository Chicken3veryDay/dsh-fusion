/** Recover card proposals from logged `propose_action` calls and decisions from plugin records. */
import { z } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ActionCardDecision } from './types.ts'

/** Model-facing name of the card tool. */
export const PROPOSE_ACTION = 'propose_action'

/** Kind-defined JSON object of a proposal or decision. */
export const fieldsSchema = z.record(z.string(), z.json())

/** Arguments of a `propose_action` call; blank titles and briefs create no card. */
export const argumentsSchema = z.object({
  action: z.string().min(1),
  title: z.string().trim().min(1),
  brief: z.string().trim().min(1),
  details: fieldsSchema,
})

const proposalSchema = z.object({
  callId: z.string().min(1).transform(ToolCallId),
  turn: z.number().int().nonnegative(),
  action: z.string().min(1),
  title: z.string().min(1),
  brief: z.string().min(1),
  details: fieldsSchema,
}).strict()

/** Recorded decision of one card. */
export const decisionSchema = z.object({
  callId: z.string().min(1).transform(ToolCallId),
  action: z.string().min(1),
  phase: z.string().min(1),
  data: fieldsSchema.optional(),
}).strict()

/**
 * Record of values by tool-call id that keeps every own key. Zod's `z.record` silently removes the reserved key
 * `__proto__`, so a card whose provider-issued call id is `__proto__` would vanish from restored state and the Client wire.
 * @param value - schema of each entry.
 * @returns schema whose output holds each own entry of a JSON object as an own data property.
 */
function recordByCallId<T>(value: z.ZodType<T>): z.ZodType<Record<string, T>> {
  return z.unknown().transform((input, ctx): Record<string, T> => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      ctx.issues.push({ code: 'custom', message: 'Expected an object keyed by call id', input })
      return z.NEVER
    }
    const entries: [string, T][] = []
    for (const [id, entry] of Object.entries(input)) {
      const parsed = value.safeParse(entry)
      if (parsed.success) entries.push([id, parsed.data])
      else {
        for (const issue of parsed.error.issues) ctx.issues.push({ code: 'custom', message: issue.message, input: entry, path: [id, ...issue.path] })
      }
    }
    return Object.fromEntries(entries)
  })
}

const viewSchema = z.object({
  proposals: recordByCallId(proposalSchema),
  decisions: recordByCallId(decisionSchema),
})

const stateSchema = z.object({
  /** Fork-inherited prefix length; inherited events create no proposals or decisions. */
  inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
  view: viewSchema,
  /** `propose_action` calls of the open turn still waiting for their result. */
  calls: recordByCallId(proposalSchema.omit({ callId: true })),
  /** Turn of the latest admitted proposal; later calls of that turn create no card. */
  admittedTurn: z.number().int().nullable(),
  /** Decisions not yet reported to the model, by call id, with the seq of their record. */
  pendingStatus: recordByCallId(z.number()),
  /** User messages still queued for later turns, folded from inbox splices; the card tool compares it with its limit. */
  queued: z.number().int().nonnegative(),
})

/** Fold state; `view` is also the Client wire value. */
export type ActionCardState = z.infer<typeof stateSchema>

/** Type of {@link actionCardProjection}: the fold plus its Client view wire. */
export type ActionCardProjectionDefinition = Omit<ProjectionDefinition<'actionCards', ActionCardState>, 'wire'> & {
  readonly wire: NonNullable<ProjectionDefinition<'actionCards', ActionCardState>['wire']>
}

/**
 * Full-Session fold. A successful `propose_action` result admits the call as a card, at most one per turn;
 * the first admitted call of a turn wins. A newer card of any kind replaces every unstarted earlier card.
 * Events inherited by a forked Session create no proposals or decisions.
 */
export const actionCardProjection: ActionCardProjectionDefinition = {
  key: 'actionCards', stateVersion: 3, stateSchema,
  init: (_header, inheritedEventCount) => ({
    inheritedEventCount, view: { proposals: {}, decisions: {} }, calls: {}, admittedTurn: null, pendingStatus: {}, queued: 0,
  }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state
    switch (event.type) {
      case 'turn/start':
        // A turn's calls settle inside it; a call left without a result never becomes a card.
        return Object.keys(state.calls).length === 0 ? state : { ...state, calls: {} }
      case 'agent/inbox/spliced':
        if (event.data.target !== 'next-turn') return state
        return { ...state, queued: Math.max(0, state.queued - (event.data.removedCount ?? 0) + event.data.inserted.length) }
      case 'user/message': {
        if (event.data.source.kind !== 'action-cards') return state
        const through = event.data.source.through
        return { ...state, pendingStatus: Object.fromEntries(Object.entries(state.pendingStatus).filter(([, seq]) => seq > through)) }
      }
      case 'tool/call': {
        if (event.data.name !== PROPOSE_ACTION) return state
        let raw: unknown
        try { raw = JSON.parse(event.data.arguments) }
        catch { return state } // Malformed model JSON failed in the tool too and creates no card.
        const parsed = argumentsSchema.safeParse(raw)
        if (!parsed.success) return state
        return { ...state, calls: { ...state.calls, [event.data.callId]: { turn: event.data.turn, ...parsed.data } } }
      }
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const call = Object.hasOwn(state.calls, callId) ? state.calls[callId] : undefined
        if (call === undefined) return state
        const calls = Object.fromEntries(Object.entries(state.calls).filter(([id]) => id !== callId))
        if (event.data.message.isError === true || state.admittedTurn === call.turn) return { ...state, calls }
        // A newer card supersedes every unstarted card; the model made that choice, so no status is reported.
        // Entries are built, not assigned: `decisions[id] = …` with id `__proto__` would call the inherited setter.
        const replaced = Object.values(state.view.proposals).filter(earlier => !Object.hasOwn(state.view.decisions, earlier.callId))
          .map((earlier): [string, ActionCardDecision] => [earlier.callId, { callId: earlier.callId, action: earlier.action, phase: 'replaced' }])
        const decisions: Record<string, ActionCardDecision> = Object.fromEntries([...Object.entries(state.view.decisions), ...replaced])
        return { ...state, calls, admittedTurn: call.turn,
          view: { proposals: { ...state.view.proposals, [callId]: { callId, ...call } }, decisions } }
      }
      default: {
        const record = pluginRecordOf(event)
        if (record?.type !== 'plugin:action-cards/decision') return state
        // A malformed or newer record is skipped; throwing here would fail every later read of this Session.
        const decision = decisionSchema.safeParse(record.data)
        if (!decision.success) return state
        return { ...state, view: { ...state.view, decisions: { ...state.view.decisions, [decision.data.callId]: decision.data } },
          pendingStatus: { ...state.pendingStatus, [decision.data.callId]: event.seq } }
      }
    }
  },
  wire: { summary: false, viewSchema, view: (state: ActionCardState) => state.view },
}
