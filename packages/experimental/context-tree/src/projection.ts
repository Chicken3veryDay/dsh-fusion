/**
 * Session projection of what the context tree has put into a conversation: loaded sections,
 * activated tools, and the published catalog. Compaction removes the entries it shadows, so
 * the service intersects these candidates with the Session surface for other replacements.
 *
 * Tool admission for a step runs after the step claims its inbox batch and before that batch
 * is logged, so an activation counts from the moment its message is durably queued for the next
 * step, through the claim, until the logged message takes over. Queue entries leave the state
 * when the queue drops them, and claimed entries when their turn ends without logging them.
 */
import { z } from 'zod'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const seq = z.number().int().nonnegative()
const names = z.array(z.string().min(1))
const grant = z.object({
  seq, key: z.string().min(1), hash: z.string().min(1), truncated: z.boolean(),
  coreBytes: z.number().int().nonnegative().nullable(), path: z.string().min(1),
}).strict()
const pendingGrant = z.object({
  key: z.string().min(1), hash: z.string().min(1), truncated: z.boolean(), coreBytes: z.number().int().nonnegative().nullable(),
}).strict()
const logged = z.object({ seq, id: z.string().min(1), key: z.string().min(1), tools: names, nodes: names }).strict()
const dropped = z.object({ key: z.string().min(1), paths: names, tools: names }).strict()
const queued = z.object({ id: z.string().min(1), tools: names, grants: z.array(pendingGrant) }).strict()
const catalog = z.object({ seq, digest: z.string().min(1) }).strict()

const stateSchema = z.object({
  /** Loaded-section candidates after compaction, including earlier eager grants still charged to the core budget. */
  grants: z.array(grant),
  /** Activation-message candidates after compaction, in log order. */
  activations: z.array(logged),
  /** Messages waiting for the next step, in queue order; `tools` and `grants` are empty for other messages. */
  inbox: z.array(queued),
  /** Activation and grant messages a step claimed and has not logged yet. */
  claimed: z.array(queued),
  /** The newest catalog candidate after compaction, if any. */
  catalog: catalog.nullable(),
  /** Loaded material that compaction removed and nothing has loaded again, oldest first, at most {@link DROPPED_RETAINED}. */
  dropped: z.array(dropped),
  /** Whether any catalog was ever published, so a republication can say it replaces an earlier one. */
  published: z.boolean(),
}).strict()

/** Private checkpoint state; consumers read through `ContextTreeService`. */
export type ContextTreeProjectionState = z.infer<typeof stateSchema>

const grantSource = z.object({ kind: z.literal('context-grant'), key: z.string().min(1), hash: z.string().min(1), path: z.string().min(1), truncated: z.boolean().optional(), coreBytes: z.number().int().nonnegative().optional() })
const activationSource = z.object({ kind: z.literal('context-activation'), key: z.string().min(1), tools: names, nodes: names })
const catalogSource = z.object({ kind: z.literal('context-tree-catalog'), digest: z.string().min(1) })

/**
 * The section a queued grant message carries.
 * @param message - any logged or queued message.
 * @returns the key and hash, empty when the message is not a readable grant.
 */
export function grantsOf(
  message: { readonly source: unknown },
): { key: string; hash: string; truncated: boolean; coreBytes: number | null }[] {
  const parsed = grantSource.safeParse(message.source)
  return parsed.success ? [{
    key: parsed.data.key, hash: parsed.data.hash, truncated: parsed.data.truncated === true, coreBytes: parsed.data.coreBytes ?? null,
  }] : []
}

/**
 * Tool names an activation message carries.
 * @param message - any logged or queued message.
 * @returns the names, empty when the message is not a readable activation.
 */
function activationTools(message: { readonly source: unknown }): string[] {
  const parsed = activationSource.safeParse(message.source)
  return parsed.success ? parsed.data.tools : []
}

/**
 * Most dropped entries the state keeps. A second compaction folds the stubs of the first into its
 * summary, so the state is the only place that still names older drops; the catalog lists the
 * newest of them within its own byte bound.
 */
export const DROPPED_RETAINED = 64

/** Projection key; host-only, so no client sees it. */
export const CONTEXT_TREE_PROJECTION_KEY = 'contextTree'

/**
 * Unit that follows context tree messages, the queue they pass through, and the compaction events
 * that shadow them. A record whose source fields cannot be read is not this plugin's message and is
 * ignored, because resumed or foreign logs may carry any source of a known kind name.
 */
export const contextTreeProjectionDefinition = {
  key: CONTEXT_TREE_PROJECTION_KEY,
  stateVersion: 5,
  stateSchema,
  init: () => ({ grants: [], activations: [], inbox: [], claimed: [], catalog: null, dropped: [], published: false }),
  apply: (state, event) => {
    if (event.type === 'agent/inbox/spliced') {
      if (event.data.target !== 'next-step') return state
      const start = Math.min(Math.max(event.data.start, 0), state.inbox.length)
      const removed = state.inbox.slice(start, start + (event.data.removedCount ?? 0))
      const inserted = event.data.inserted.map(message => ({ id: message.id, tools: activationTools(message), grants: grantsOf(message) }))
      const taken = removed.filter(entry => entry.tools.length > 0 || entry.grants.length > 0)
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
        const entry = {
          seq: event.seq,
          key: granted.data.key,
          hash: granted.data.hash,
          truncated: granted.data.truncated === true,
          coreBytes: granted.data.coreBytes ?? null,
          path: granted.data.path,
        }
        return {
          ...state,
          dropped: state.dropped.filter(existing => existing.key !== entry.key),
          grants: [...state.grants.filter(existing => (
            existing.key !== entry.key || existing.coreBytes === null || existing.coreBytes > 0
          )), entry],
          claimed: state.claimed.filter(pending => pending.id !== event.data.id),
        }
      }
      const activated = activationSource.safeParse(source)
      if (activated.success) {
        const { key, tools, nodes } = activated.data
        return {
          ...state,
          dropped: state.dropped.filter(existing => existing.key !== key),
          activations: [...state.activations, { seq: event.seq, id: event.data.id, key, tools, nodes }],
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
      const retainedKeys = new Set(grants.map(entry => entry.key))
      const lost = [
        ...state.grants.filter(entry => shadowed.has(entry.seq) && !retainedKeys.has(entry.key))
          .map(entry => ({ key: entry.key, paths: [entry.path], tools: [] })),
        ...state.activations.filter(entry => shadowed.has(entry.seq))
          .map(entry => ({ key: entry.key, paths: entry.nodes, tools: entry.tools })),
      ]
      const lostKeys = new Set(lost.map(entry => entry.key))
      const remembered = [...state.dropped.filter(entry => !lostKeys.has(entry.key)), ...lost].slice(-DROPPED_RETAINED)
      return { ...state, grants, activations, dropped: remembered, catalog: kept ? state.catalog : null }
    }
    return state
  },
} satisfies ProjectionDefinition<typeof CONTEXT_TREE_PROJECTION_KEY, ContextTreeProjectionState>

/**
 * Treat accepted messages the loop has not logged yet as claimed, so grants among them keep their
 * budget charge and held hash.
 * @param state - projection state.
 * @param pending - messages accepted for the coming request.
 * @returns the state with their grants counted as claimed.
 */
export function withPendingGrants(state: ContextTreeProjectionState, pending: readonly UserMessage[]): ContextTreeProjectionState {
  const grants = pending.map(message => ({ id: message.id, tools: [], grants: grantsOf(message) })).filter(entry => entry.grants.length > 0)
  return grants.length === 0 ? state : { ...state, claimed: [...state.claimed, ...grants] }
}

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

/**
 * Section hashes the conversation holds or is about to hold: logged grants, then grants a step
 * claimed, then grants still queued. A later entry for a section replaces an earlier one.
 * Truncated grants never satisfy a complete-section load.
 * @param state - projection state.
 * @returns the hash of each section's newest complete grant, keyed by section id.
 */
export function grantedHashes(state: ContextTreeProjectionState): ReadonlyMap<string, string> {
  const hashes = new Map<string, string>()
  for (const entry of state.grants) if (!entry.truncated) hashes.set(entry.key, entry.hash)
  for (const entry of [...state.claimed, ...state.inbox]) {
    for (const grant of entry.grants) if (!grant.truncated) hashes.set(grant.key, grant.hash)
  }
  return hashes
}

/**
 * The newest grant of each section the conversation holds or is about to hold, complete or not,
 * in the order of {@link grantedHashes}.
 * @param state - projection state.
 * @returns each section's newest grant, keyed by section id.
 */
export function newestGrants(
  state: ContextTreeProjectionState,
): ReadonlyMap<string, { readonly hash: string; readonly coreBytes: number | null }> {
  const newest = new Map<string, { hash: string; coreBytes: number | null }>()
  for (const entry of [...state.grants, ...[...state.claimed, ...state.inbox].flatMap(pending => pending.grants)]) {
    newest.set(entry.key, { hash: entry.hash, coreBytes: entry.coreBytes })
  }
  return newest
}
