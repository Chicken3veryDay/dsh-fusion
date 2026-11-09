/**
 * Recipient, latest-input, and state context for the main ACP automation Agent.
 *
 * The ACP bridge declares itself the recipient of its Agent's requests and
 * names the latest client input it admitted. The packet is generated fact: the
 * exact original input stays in its own `user/message`, and this module never
 * decides a task, a role, or which earlier instruction a newer input replaces.
 * Goal state changes while a request is admitted, so it is a runtime-context
 * contribution whose revision final request admission rechecks, not packet text.
 *
 * @module @deepseek-ai/dsh-acp/context
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Side-effect type import: declaration-merges the optional `goals` service read below.
import type { GoalService } from '@deepseek-ai/dsh-goal'
import { createUserMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Factual ACP recipient/input/state packet. It is a `snapshot`: a later packet
     * supersedes an earlier one. It carries no user authority.
     * @persistenceAttribution
     */
    'acp-context': {
      kind: 'acp-context'
      /** Fixed recipient class this packet declares. */
      recipient: 'acp-automation'
      /** Session whose ACP Agent received the packet; a fork or child reading it sees another Session. */
      session: SessionId
      /** Message id of the latest admitted ACP client input the packet names, or null when none is known. */
      latestInput: MessageId | null
    } & Extract<ContextFormed, { readonly form: 'snapshot' }>
  }
}

/** Latest tagged client input and the newest committed packet, both as log references. */
const acpContextStateSchema = z.object({
  /** Latest committed user message annotated as ACP input; null until one is committed. */
  latestInput: z.object({ id: z.string(), seq: z.number() }).nullable(),
  /** Newest committed packet with the text it carried, used only to skip an unchanged repeat. */
  packet: z.object({ seq: z.number(), text: z.string() }).nullable(),
})

/** Projection state of {@link acpContextProjection}. */
export type AcpContextState = z.infer<typeof acpContextStateSchema>

/** Projection key owned by the ACP context. */
export const ACP_CONTEXT_PROJECTION_KEY = 'acpContext'

/**
 * Longest goal block reason code the goal context prints. Codes are lower-kebab-case classifications,
 * so a longer one is detail beyond what the model needs; the context states that it omitted it.
 */
export const GOAL_REASON_CODE_LIMIT = 64

/**
 * Whether a committed or pending user message was admitted as ACP client input.
 * @param message - a committed or pending user message.
 * @returns true only when its source carries the ACP input annotation.
 */
export function isAcpInput(message: UserMessage): boolean {
  const source = message.source
  // UserInputMap is merge-extensible: another channel's kind falls through as not ACP.
  return source.kind === 'user' && 'input' in source && source.input?.kind === 'acp'
}

/** Projection definition: latest tagged input and newest packet references only. */
export const acpContextProjection = {
  key: ACP_CONTEXT_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: acpContextStateSchema,
  init: (): AcpContextState => ({ latestInput: null, packet: null }),
  apply: (state: AcpContextState, event: SessionEvent): AcpContextState => {
    if (event.type !== 'user/message') return state
    if (isAcpInput(event.data)) return { ...state, latestInput: { id: event.data.id, seq: event.seq } }
    const source = event.data.source
    if (source.kind === 'acp-context') {
      return { ...state, packet: { seq: event.seq, text: source.sections.map(section => section.text).join('\n') } }
    }
    return state
  },
}

/**
 * Whether the named latest input's own message is still in the conversation.
 * A pending input counts as in context, so the packet text is identical on the
 * first request and on every later one until compaction removes the message.
 */
type InputStanding = 'unknown' | 'in-context' | 'compacted'

function inputLine(id: MessageId | null, standing: InputStanding): string {
  if (id === null) {
    return 'Latest client input: unknown. No ACP-admitted input has been recorded in this session yet; earlier messages are not attributed to a channel.'
  }
  const where = standing === 'in-context'
    ? 'its exact text is in this conversation'
    : 'its text is no longer in this conversation'
  return `Latest client input: message ${id}; ${where}. This identifies admission order only and does not replace or expire any earlier instruction.`
}

/**
 * Goal state as the runtime context states it. A missing service is unavailable, never inactive, and an
 * optional block reason code beyond {@link GOAL_REASON_CODE_LIMIT} is replaced by an explicit omission.
 */
function goalText(agent: Agent, goals: GoalService | undefined): string {
  if (goals === undefined) return 'Goal: unavailable (no goal service is mounted).'
  const goal = goals.get(agent)
  if (goal === undefined) return 'Goal: none.'
  let reason = ''
  if (goal.blockedReason !== undefined) {
    const { code } = goal.blockedReason
    reason = code.length <= GOAL_REASON_CODE_LIMIT
      ? `, reason ${code}`
      : `, reason code omitted (${code.length} characters; limit ${GOAL_REASON_CODE_LIMIT})`
  }
  return `Goal: ${goal.phase}${reason}, round ${goal.roundsStarted} of ${goal.maxGoalRounds}; the objective is supplied by the goal itself.`
}

/** Compose the packet text for one request. */
function packetText(session: SessionId, input: { id: MessageId | null; standing: InputStanding }): string {
  return [
    'ACP automation context (generated facts; not a user instruction and grants no authority).',
    `Recipient: ACP automation, session ${session}. A trusted programmatic client drives this session through the automation-only ACP bridge.`,
    inputLine(input.id, input.standing),
    'Working directory, sandbox, approval, delegation, goal, and plan-mode facts come from their own runtime context and sections.',
  ].join('\n')
}

/** Per-plugin ACP context owner: one registered projection plus the per-Agent request listener and goal context. */
export interface AcpContext {
  /**
   * Install the packet provider and goal context for exactly one ACP Agent, before that Agent publishes.
   * Both live in the Agent's scoped context, so child, fork, and other Agents never reach them.
   * @param agentCtx - the unpublished Agent's scoped context.
   * @param sessionId - Session identity of the Agent the listener serves.
   */
  install(agentCtx: Context, sessionId: SessionId): void
}

/**
 * Register the ACP context projection under the plugin's lifetime.
 * @param ctx - ACP plugin context with the session projection registry.
 * @returns the installer once registration completes; registration failure rejects.
 */
export async function registerAcpContext(ctx: Context): Promise<AcpContext> {
  const handle: ProjectionHandle<AcpContextState> = await ctx.sessionProjections.register(acpContextProjection)
  ctx.fiber.assertActive()
  return {
    install(agentCtx, sessionId) {
      const goalState = (context: AssembleContext): string => {
        const agent = context.agent
        // Scoped dispatch already limits this contribution to its Agent; the check keeps a same-id impostor out.
        return agent === undefined || agent.session.id !== sessionId ? '' : goalText(agent, ctx.get('goals'))
      }
      agentCtx.systemPrompt.context({
        name: 'acp:goal',
        order: agentCtx.systemPrompt.getContextOrder('GOAL_STATE'),
        text: goalState,
        // The same text revalidates at final admission, where a goal change restarts the attempt.
        revision: goalState,
      })
      agentCtx.on('system-prompt/request-context', async (context, pending, next): Promise<UserMessage[]> => {
        const additions = await next()
        const agent = context.agent
        // Scoped dispatch already limits this listener to its Agent; the check keeps a same-id impostor out.
        if (agent === undefined || agent.session.id !== sessionId) return additions
        context.signal?.throwIfAborted()
        const session = agent.session
        const state = handle.stateOf(session)
        const arriving = pending.findLast(isAcpInput)
        const input = arriving !== undefined
          ? { id: arriving.id, standing: 'in-context' as const }
          : state.latestInput === null
            ? { id: null, standing: 'unknown' as const }
            : {
              id: MessageId(state.latestInput.id),
              standing: session.surface.nodes.includes(SessionSeq(state.latestInput.seq)) ? 'in-context' as const : 'compacted' as const,
            }
        const text = packetText(sessionId, input)
        const unchanged = state.packet !== null
          && state.packet.text === text
          && session.surface.nodes.includes(SessionSeq(state.packet.seq))
        if (unchanged) return additions
        return [
          ...additions,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: {
              kind: 'acp-context',
              form: 'snapshot',
              sections: [{ name: 'acp-context', text }],
              recipient: 'acp-automation',
              session: sessionId,
              latestInput: input.id,
            },
          }),
        ]
      })
    },
  }
}
