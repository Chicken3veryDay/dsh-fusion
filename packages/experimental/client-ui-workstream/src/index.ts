/** Host Remote of the Workstream panel: authenticated Ticket commands and change request aggregation. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TicketError } from '@deepseek-ai/dsh-experimental-ticket'
import type { TicketErrorCode } from '@deepseek-ai/dsh-experimental-ticket'
import { WorkstreamError } from '@deepseek-ai/dsh-experimental-workstream'
import type { AggregatedChangeRequestsResult } from '@deepseek-ai/dsh-experimental-workstream-evidence'
import type { Session } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteErrorDetailsMap } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkstreamAttentionTarget, WorkstreamQuestionAnswer, WorkstreamQuestionTarget } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote that serves the Workstream panel of the GUI. */
    workstreamPanel: WorkstreamPanelController
  }
}

type PanelErrorCode = Extract<keyof RemoteErrorDetailsMap, `workstreamPanel/${string}`>

function ticketCode(code: TicketErrorCode): PanelErrorCode {
  switch (code) {
    case 'TICKET_STALE_REVISION': return 'workstreamPanel/stale-revision'
    case 'TICKET_AUTHORITY': return 'workstreamPanel/denied'
    default: return 'workstreamPanel/rejected'
  }
}

function workstreamFailure(error: WorkstreamError): RemoteError {
  const options = { cause: error }
  switch (error.code) {
    case 'WORKSTREAM_UNAUTHORIZED': return new RemoteError('workstreamPanel/denied', error.message, { reason: 'not-member' }, options)
    case 'WORKSTREAM_NOT_FOUND': return new RemoteError('workstreamPanel/unavailable', error.message, {}, options)
    case 'WORKSTREAM_DISPOSED': return new RemoteError('workstreamPanel/rejected', error.message, { reason: 'workstream-stopping' }, options)
    default: return new RemoteError('workstreamPanel/rejected', error.message, { reason: 'workstream' }, options)
  }
}

/**
 * Translate a Ticket or Workstream domain failure into a typed panel failure; other failures propagate unchanged.
 * @param error - caught domain failure.
 * @returns the typed failure the Remote rejects with.
 */
function panelError(error: unknown): unknown {
  if (error instanceof TicketError) {
    // Workstream's commit-time authority refuses a revoked member inside Ticket's queue; it reads as the same membership denial.
    if (error.code === 'TICKET_AUTHORITY' && error.cause instanceof WorkstreamError && error.cause.code === 'WORKSTREAM_UNAUTHORIZED') {
      return new RemoteError('workstreamPanel/denied', error.message, { reason: 'not-member' }, { cause: error })
    }
    return new RemoteError(ticketCode(error.code), error.message, {}, { cause: error })
  }
  if (error instanceof WorkstreamError) return workstreamFailure(error)
  return error
}

/**
 * Serves the Workstream panel. Every method takes the Agent of the Session the
 * caller displays, which the Gateway resolves and access-checks as that
 * Session's resource; no wire field names another Session as authority. The
 * controller derives the Workstream root from the caller's own Session header,
 * checks Remote access to the root, requires active membership through `ctx.workstreams`, and runs Ticket
 * commands on the root's Ticket log with the caller as actor and initiating Agent, so the Ticket
 * service applies its coordinator and author rules to the live caller.
 */
export class WorkstreamPanelController extends TypertRemoteService {
  static inject = ['agents', 'tickets', 'workstreams', 'workstreamEvidence', 'remoteAccess']

  constructor(ctx: Context) {
    super(ctx, 'workstreamPanel')
  }

  /**
   * Aggregate the change requests that the caller's Workstream members bind.
   * @param agent - displayed Session's Agent, supplied by the Gateway.
   * @returns aggregated change requests; `complete` is false when a Session or the forge service could not be read.
   * @throws `workstreamPanel/forbidden` unless every contributing Session is granted for this action.
   * @throws `workstreamPanel/denied` or `workstreamPanel/unavailable` unless the caller is an active member of a live Workstream.
   */
  @Remote
  changeRequests(agent: Agent): AggregatedChangeRequestsResult {
    try {
      const root = rootOf(agent)
      this.requireAccess(root)
      const { snapshot } = this.ctx.workstreams.requireMembership(agent, root)
      // Aggregation reads every retained member, stopped ones included.
      for (const member of snapshot.members) this.requireAccess(member.id)
      return this.ctx.workstreamEvidence.aggregateChangeRequests(agent, root)
    } catch (error) {
      throw panelError(error)
    }
  }

  /**
   * Answer an open Ticket question as the caller.
   * @param agent - displayed Session's Agent, supplied by the Gateway.
   * @param request - question, answer text, and the Ticket revision the panel read.
   * @throws `workstreamPanel/stale-revision` after a concurrent Ticket change.
   * @throws `workstreamPanel/forbidden` unless the Peer is granted this action on the root Session.
   * @throws `workstreamPanel/denied` unless the caller coordinates the Ticket.
   */
  @Remote
  async answerQuestion(agent: Agent, request: WorkstreamQuestionAnswer): Promise<void> {
    await this.command(agent, async (session) => {
      await this.ctx.tickets.answer(session, {
        ticketId: request.ticketId, questionId: request.questionId, expectedRevision: request.expectedRevision,
        answer: request.answer, actorId: agent.id,
      })
    })
  }

  /**
   * Close an open or answered Ticket question as the caller.
   * @param agent - displayed Session's Agent, supplied by the Gateway.
   * @param request - question and the Ticket revision the panel read.
   * @throws `workstreamPanel/stale-revision` after a concurrent Ticket change.
   * @throws `workstreamPanel/forbidden` unless the Peer is granted this action on the root Session.
   * @throws `workstreamPanel/denied` unless the caller authored the question or coordinates the Ticket.
   */
  @Remote
  async closeQuestion(agent: Agent, request: WorkstreamQuestionTarget): Promise<void> {
    await this.command(agent, async (session) => {
      await this.ctx.tickets.closeQuestion(session, {
        ticketId: request.ticketId, questionId: request.questionId, expectedRevision: request.expectedRevision, actorId: agent.id,
      })
    })
  }

  /**
   * Acknowledge an open attention item as the caller; the item keeps blocking until resolved.
   * @param agent - displayed Session's Agent, supplied by the Gateway.
   * @param request - attention item and the Ticket revision the panel read.
   * @throws `workstreamPanel/stale-revision` after a concurrent Ticket change.
   * @throws `workstreamPanel/forbidden` unless the Peer is granted this action on the root Session.
   * @throws `workstreamPanel/denied` unless the caller coordinates the Ticket.
   */
  @Remote
  async acknowledgeAttention(agent: Agent, request: WorkstreamAttentionTarget): Promise<void> {
    await this.command(agent, async (session) => {
      await this.ctx.tickets.acknowledgeAttention(session, {
        ticketId: request.ticketId, attentionId: request.attentionId, expectedRevision: request.expectedRevision, actorId: agent.id,
      })
    })
  }

  /**
   * Resolve an open or acknowledged attention item as the caller.
   * @param agent - displayed Session's Agent, supplied by the Gateway.
   * @param request - attention item and the Ticket revision the panel read.
   * @throws `workstreamPanel/stale-revision` after a concurrent Ticket change.
   * @throws `workstreamPanel/forbidden` unless the Peer is granted this action on the root Session.
   * @throws `workstreamPanel/denied` unless the caller coordinates the Ticket.
   */
  @Remote
  async resolveAttention(agent: Agent, request: WorkstreamAttentionTarget): Promise<void> {
    await this.command(agent, async (session) => {
      await this.ctx.tickets.resolveAttention(session, {
        ticketId: request.ticketId, attentionId: request.attentionId, expectedRevision: request.expectedRevision, actorId: agent.id,
      })
    })
  }

  /** Refuse access to a derived Session before reading its data or appending commands. */
  private requireAccess(sessionId: Session['id']): void {
    if (!this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId })) {
      throw new RemoteError('workstreamPanel/forbidden', 'Access to the Workstream Session is denied', {})
    }
  }

  /** Run one Ticket command on the root Ticket log after the caller's membership is confirmed.
   * The check here is an early refusal; Workstream's Ticket authority enforces membership again where Ticket commits. */
  private async command(agent: Agent, run: (root: Session) => Promise<void>): Promise<void> {
    try {
      const root = rootOf(agent)
      this.requireAccess(root)
      const { owner } = this.ctx.workstreams.requireMembership(agent, root)
      await this.ctx.agents.withInitiator(agent, () => run(owner.session))
    } catch (error) {
      throw panelError(error)
    }
  }
}

/** Workstream root of a caller: its continuable parent, else its own Session. */
function rootOf(agent: Agent): Session['id'] {
  return agent.session.header.parentSession ?? agent.id
}

export default WorkstreamPanelController
