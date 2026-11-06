/** Live Agent fixture for direct Ticket commands. */
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Execute a fixture command as a registered actor, preserving explicit impersonation tests.
 * @param ctx - Fixture services.
 * @param id - Actor to register when absent.
 * @param operation - Direct service command.
 * @returns Command result under the live actor.
 */
export async function ticketActor<T>(ctx: Context, id: SessionId, operation: () => Promise<T>): Promise<T> {
  if (ctx.get('agents') === undefined) await ctx.plugin(AgentRegistry)
  const inherited = ctx.agents.currentInitiator()
  if (inherited !== undefined) return operation()
  let caller = ctx.agents.get(id)
  if (caller === undefined) {
    const session = ctx.sessions.get(id) ?? ctx.sessions.create(id)
    caller = { id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
      send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
      runMaintenance: async <R>(task: (signal: AbortSignal) => Promise<R>) => task(new AbortController().signal),
    } satisfies Agent
    await ctx.agents.register(caller)
  }
  return ctx.agents.withInitiator(caller, operation)
}
