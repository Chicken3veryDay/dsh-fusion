/**
 * Loader entry that mounts `ticket_*` tools. The Ticket package exports `TicketTools` by name,
 * and the Loader mounts only a module's default export. The profile keeps Workstream's assignment rule on the
 * direct `ticket_assign` path: Ticket accepts any Session as an assignee, so the profile refuses
 * a root's non-members and members that are not active before the call reaches Ticket.
 * @module @deepseek-ai/dsh-experimental-workstream-profile/ticket-tools
 */

import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { TicketTools as BaseTicketTools } from '@deepseek-ai/dsh-experimental-ticket'

/** Ticket tools whose `ticket_assign` obeys the Workstream's active-member rule. */
export default class TicketTools extends BaseTicketTools {
  static override inject = [...BaseTicketTools.inject, 'workstreams']

  protected override [Service.init](): void {
    super[Service.init]()
    this.ctx.tools.guard(exec => this.assignmentRefusal(exec))
  }

  /** @returns the refusal for a `ticket_assign` call whose assignee is not an active child member of the root's Workstream. */
  private assignmentRefusal(exec: Readonly<ToolExecution>): string | undefined {
    if (exec.name !== 'ticket_assign' || exec.agent === undefined) return undefined
    const args = exec.arguments as { readonly root_session_id?: unknown; readonly owner_id?: unknown }
    const root = args.root_session_id, assignee = args.owner_id
    if (typeof root !== 'string' || typeof assignee !== 'string') return undefined
    const snapshot = this.workstreamOf(exec.agent, root as SessionId)
    if (snapshot === undefined) return undefined
    const member = snapshot.members.find(candidate => candidate.id === assignee)
    if (member?.phase === 'active' && member.id !== snapshot.ownerSessionId) return undefined
    return `${assignee} is not an active member of this Workstream; use workstream_assign_ticket with an active member`
  }

  private workstreamOf(caller: Agent, root: SessionId) {
    try { return this.ctx.workstreams.get(caller, root) } catch (cause) {
      // A caller that is not a member, or a root with no Workstream, is not governed by Workstream; Ticket decides.
      if (cause instanceof Error) return undefined
      throw cause
    }
  }
}
