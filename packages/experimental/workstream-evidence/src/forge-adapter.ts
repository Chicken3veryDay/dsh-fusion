/** Read-only aggregation of existing per-Session forge bindings across Workstream members. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ForgeSessionService } from '@deepseek-ai/dsh-experimental-forge-session'
import type {
  AggregatedChangeRequest,
  ChangeRequestContribution,
  AggregatedChangeRequestsResult,
  ChangeRequestGap,
} from './types.ts'

/**
 * Aggregate the root and every retained member Session's change request bindings by URL, including stopped members.
 * Each contributing Session keeps its own origin and latest polling result; Sessions that cannot be read are
 * reported in `diagnostics` and `complete` is false. Never writes to a forge.
 * @param ctx - Context that injects `agents`, `sessions`, and `workstreams`; `forgeSession` is optional.
 * @param caller - live Workstream member.
 * @param rootSessionId - Workstream root Session id.
 * @returns Deduplicated change requests and diagnostics for unreadable Sessions.
 */
export function aggregateChangeRequests(
  ctx: Context,
  caller: Agent,
  rootSessionId: SessionId,
): AggregatedChangeRequestsResult {
  const { snapshot } = ctx.workstreams.requireMembership(caller, rootSessionId)
  const forge: ForgeSessionService | undefined = ctx.get('forgeSession')
  if (forge === undefined) {
    return { complete: false, changeRequests: [], diagnostics: ['Forge session service is not mounted'], gaps: [{ kind: 'forge-unavailable' }] }
  }

  const sessionIds = [...new Set<SessionId>([
    snapshot.ownerSessionId,
    ...snapshot.members.map(member => member.id),
  ])]
  const unloaded: SessionId[] = []
  const byUrl = new Map<string, { ref: AggregatedChangeRequest['ref']; contributions: ChangeRequestContribution[] }>()

  for (const sessionId of sessionIds) {
    const session = ctx.agents.get(sessionId)?.session ?? ctx.sessions.get(sessionId)
    if (session === undefined) {
      unloaded.push(sessionId)
      continue
    }
    for (const binding of forge.changeRequests(session)) {
      const entry = byUrl.get(binding.url) ?? { ref: binding.ref, contributions: [] }
      entry.ref ??= binding.ref
      entry.contributions.push({ sessionId, origin: binding.origin, update: binding.update })
      byUrl.set(binding.url, entry)
    }
  }

  const gaps: ChangeRequestGap[] = unloaded.map(sessionId => ({ kind: 'session-not-loaded', sessionId }))
  return {
    complete: gaps.length === 0,
    changeRequests: [...byUrl].map(([url, entry]) => ({ url, ref: entry.ref, contributions: entry.contributions })),
    diagnostics: unloaded.map(sessionId => `Session ${sessionId} is not loaded; its change requests are not included`),
    gaps,
  }
}
