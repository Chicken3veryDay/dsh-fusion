/**
 * Session projection of what the context tree has put into a conversation: loaded sections,
 * activated tools, and the published catalog. Compaction removes the entries it shadows, so
 * the state always describes material still in the model's history.
 *
 * Tool admission for a step runs after the step claims its inbox batch and before that batch
 * is logged, so an activation counts from the moment its message is durably queued for the next
 * step, through the claim, until the logged message takes over. Queue entries leave the state
 * when the queue drops them, and claimed entries when their turn ends without logging them.
 */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const seq = z.number().int().nonnegative()
const names = z.array(z.string().min(1))
const grant = z.object({ seq, key: z.string().min(1), hash: z.string().min(1) }).strict()
const logged = z.object({ seq, id: z.string().min(1), tools: names }).strict()
const queued = z.object({ id: z.string().min(1), tools: names }).strict()
const catalog = z.object({ seq, digest: z.string().min(1) }).strict()

const stateSchema = z.object({
  /** Loaded sections still in history, one entry per section id. */
  grants: z.array(grant),
  /** Activation messages still in history, in log order. */
  activations: z.array(logged),
  /** Messages waiting for the next step, in queue order; `tools` is empty for other messages. */
  inbox: z.array(queued),
  /** Activation messages a step claimed and has not logged yet. */
  claimed: z.array(queued),
  /** The catalog message still in history, if any. */
  catalog: catalog.nullable(),
  /** Whether any catalog was ever published, so a republication can say it replaces an earlier one. */
  published: z.boolean(),
}).strict()

/** Private checkpoint state; consumers read through `ContextTreeService`. */
export type ContextTreeProjectionState = z.infer<typeof stateSchema>

const grantSource = z.object({ kind: z.literal('context-grant'), key: z.string().min(1), hash: z.string().min(1) })
const activationSource = z.object({ kind: z.literal('context-activation'), tools: names })
const catalogSource = z.object({ kind: z.literal('context-tree-catalog'), digest: z.string().min(1) })

/**
 * Tool names an activation message carries.
 * @param message - any logged or queued message.
 * @returns the names, empty when the message is not a readable activation.
 */
function activationTools(message: { readonly source: unknown }): string[] {
  const parsed = activationSource.safeParse(message.source)
  return parsed.success ? parsed.data.tools : []
}

/** Projection key; host-only, so no client sees it. */
export const CONTEXT_TREE_PROJECTION_KEY = 'contextTree'

/**
 * Unit that follows context tree messages, the queue they pass through, and the compaction events
 * that shadow them. A record whose source fields cannot be read is not this plugin's message and is
 * ignored, because resumed or foreign logs may carry any source of a known kind name.
 */
export const contextTreeProjectionDefinition = {
  key: CONTEXT_TREE_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => ({ grants: [], activations: [], inbox: [], claimed: [], catalog: null, published: false }),
  apply: (state, event) => {
    if (event.type === 'agent/inbox/spliced') {
      if (event.data.target !== 'next-step') return state
      const start = Math.min(Math.max(event.data.start, 0), state.inbox.length)
      const removed = state.inbox.slice(start, start + (event.data.removedCount ?? 0))
      const inserted = event.data.inserted.map(message => ({ id: message.id, tools: activationTools(message) }))
      const taken = removed.filter(entry => entry.tools.length > 0)
      return {
        ...state,
        inbox: state.inbox.toSpliced(start, removed.length, ...inserted),
        claimed: event.data.outcome === 'canceled' || taken.length === 0 ? state.claimed : [...state.claimed, ...taken],
      }
    }
    if (event.type === 'user/message') {
      const source: unknown = event.data.source
      const granted = grantSource.safeParse(source)
      if (granted.success) {
        const entry = { seq: event.seq, key: granted.data.key, hash: granted.data.hash }
        return { ...state, grants: [...state.grants.filter(existing => existing.key !== entry.key), entry] }
      }
      const activated = activationSource.safeParse(source)
      if (activated.success) {
        return {
          ...state,
          activations: [...state.activations, { seq: event.seq, id: event.data.id, tools: activated.data.tools }],
          claimed: state.claimed.filter(entry => entry.id !== event.data.id),
        }
      }
      const cataloged = catalogSource.safeParse(source)
      if (cataloged.success) return { ...state, catalog: { seq: event.seq, digest: cataloged.data.digest }, published: true }
      return state
    }
    if (event.type === 'turn/end') return state.claimed.length === 0 ? state : { ...state, claimed: [] }
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      const shadowed = new Set<number>(event.data.shadowedSeqs)
      const grants = state.grants.filter(entry => !shadowed.has(entry.seq))
      const activations = state.activations.filter(entry => !shadowed.has(entry.seq))
      const kept = state.catalog !== null && !shadowed.has(state.catalog.seq)
      if (grants.length === state.grants.length && activations.length === state.activations.length && (kept || state.catalog === null)) {
        return state
      }
      return { ...state, grants, activations, catalog: kept ? state.catalog : null }
    }
    return state
  },
} satisfies ProjectionDefinition<typeof CONTEXT_TREE_PROJECTION_KEY, ContextTreeProjectionState>

/**
 * Tool names the conversation has activated, deduplicated, in the order their messages were
 * logged, claimed, or queued.
 * @param state - projection state.
 * @returns the active names.
 */
export function activeToolNames(state: ContextTreeProjectionState): ReadonlySet<string> {
  const active = new Set<string>()
  for (const entry of [...state.activations, ...state.claimed, ...state.inbox]) for (const name of entry.tools) active.add(name)
  return active
}
