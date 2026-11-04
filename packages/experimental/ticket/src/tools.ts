/** Model-facing Ticket coordination tools over the Host Ticket service. */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TicketError } from './errors.ts'
import type { TicketSnapshot } from './types.ts'
import {
  AssignmentId,
  TicketId,
  TicketQuestionId,
  TicketAttentionId,
  type WorkScope,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'ticket-tools'
/** Services required by the Ticket tool plugin. */
export const inject = ['tools', 'tickets', 'sessions', 'systemPrompt']

function agentOf(agent: Agent | undefined, tool: string): Agent {
  if (agent === undefined) throw new Error(`${tool} requires a calling Agent`)
  return agent
}

function sessionOf(ctx: Context, id: string | undefined, agent: Agent): import('@deepseek-ai/dsh-session').Session {
  const session = ctx.sessions.get(SessionId(id ?? agent.id))
  if (session === undefined) throw new Error(`Ticket Session "${id ?? agent.id}" is not live`)
  return session
}

function canRead(ticket: TicketSnapshot, actorId: SessionId): boolean {
  return ticket.coordinatorId === actorId || ticket.assignments.some(assignment => assignment.ownerId === actorId)
}

const JSON_OUTPUT_SCHEMA = { type: 'json' } as const
type JsonObjectOutput = InferValue<typeof JSON_OUTPUT_SCHEMA>

function jsonOutput(): {
  schema: typeof JSON_OUTPUT_SCHEMA
  render: (args: unknown, value: JsonObjectOutput) => [{ type: 'text'; text: string }]
} {
  return { schema: JSON_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function workScopes(value: readonly Record<string, JsonValue>[]): WorkScope[]
function workScopes(value: undefined): undefined
function workScopes(value: readonly Record<string, JsonValue>[] | undefined): WorkScope[] | undefined {
  if (value === undefined) return undefined
  return value.map((row) => {
    const path = row.path
    const access = row.access
    const exclusive = row.exclusive
    if (typeof path !== 'string' || (access !== 'read' && access !== 'write')
      || exclusive !== undefined && typeof exclusive !== 'boolean') {
      throw new Error('work_scopes must contain path, access, and optional exclusive fields')
    }
    return { path, access, ...exclusive === undefined ? {} : { exclusive } }
  })
}

/** Register the direct-worker Ticket tools. */
export class TicketTools extends Service {
  static inject = inject

  constructor(ctx: Context) {
    super(ctx, 'ticketTools')
  }

  protected [Service.init](): void {
    this.ctx.systemPrompt.section({
      name: 'ticket-tools:policy',
      order: this.ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: 'Ticket tools coordinate one durable work item between a soft coordinator and direct workers. '
        + 'Read the Ticket before mutating it, pass the current expected_revision, keep assignments narrow, '
        + 'and report results or questions instead of silently changing ownership.',
    })
    const register = (tool: Parameters<Context['tools']['register']>[0]): void => { this.ctx.tools.register(tool) }
    register(defineTool({
      name: 'ticket_list',
      description: 'List durable Tickets in a Session. Pass root_session_id when a worker is acting on a coordinator-owned Ticket.',
      parameters: {
        root_session_id: {
          type: 'string',
          description: 'Session id that owns the Ticket log. Defaults to the calling Agent Session.',
        },
      },
      output: jsonOutput(),
      execute: (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_list')
        const session = sessionOf(this.ctx, args.root_session_id, agent)
        const tickets = this.ctx.tickets.list(session).filter(ticket => session.id === agent.id || canRead(ticket, agent.id))
        if (session.id !== agent.id && tickets.length === 0) throw new TicketError('caller has no Ticket in this Session', 'TICKET_AUTHORITY')
        return Promise.resolve(asJson({ tickets }))
      },
    }))
    register(defineTool({
      name: 'ticket_get',
      description: 'Read one complete Ticket before claiming, reporting, or changing it.',
      parameters: {
        root_session_id: { type: 'string', description: 'Session id that owns the Ticket log.' },
        ticket_id: { type: 'string', required: true, description: 'Ticket id.' },
      },
      output: jsonOutput(),
      execute: (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_get')
        const session = sessionOf(this.ctx, args.root_session_id, agent)
        const ticket = this.ctx.tickets.get(session, TicketId(args.ticket_id))
        if (session.id !== agent.id && !canRead(ticket, agent.id)) throw new TicketError('caller is not a Ticket participant', 'TICKET_AUTHORITY')
        return Promise.resolve(asJson(ticket))
      },
    }))
    register(defineTool({
      name: 'ticket_create',
      description: 'Create a durable Ticket owned by the calling Session. Use this for a concrete unit of work '
        + 'that may need direct workers, execution slots, reports, or human attention.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Concise work subject.' },
        description: { type: 'string', required: true, description: 'Acceptance criteria and context.' },
        root_session_id: { type: 'string', description: 'Must be the calling Agent Session when supplied.' },
        coordinator_id: { type: 'string', description: 'Must be the caller when supplied. Use ticket_handoff to transfer authority.' },
        work_scopes: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'Declared path access for the Ticket.',
        },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_create')
        const session = sessionOf(this.ctx, args.root_session_id, agent)
        if (session.id !== agent.id || (args.coordinator_id !== undefined && args.coordinator_id !== agent.id)) {
          throw new TicketError('create Tickets in the calling Session with the caller as coordinator; use handoff to transfer authority', 'TICKET_AUTHORITY')
        }
        return asJson(await this.ctx.tickets.create(session, {
          subject: args.subject,
          description: args.description,
          ...args.coordinator_id === undefined ? {} : { coordinatorId: SessionId(args.coordinator_id) },
          ...args.work_scopes === undefined ? {} : { workScopes: workScopes(args.work_scopes) },
        }))
      },
    }))
    register(defineTool({
      name: 'ticket_assign',
      description: 'Assign one direct worker under coordinator authority and reserve an execution slot.',
      parameters: {
        root_session_id: { type: 'string', required: true, description: 'Session that owns the Ticket log.' },
        ticket_id: { type: 'string', required: true, description: 'Ticket id.' },
        expected_revision: { type: 'integer', required: true, description: 'Revision returned by ticket_get or the previous command.' },
        owner_id: { type: 'string', required: true, description: 'Direct worker Session id.' },
        subject: { type: 'string', required: true, description: 'Assignment subject.' },
        instructions: { type: 'string', description: 'Worker-specific instructions.' },
        role: { type: 'string', enum: ['worker', 'reviewer', 'integrator', 'observer'] },
        execution_mode: { type: 'string', enum: ['shared-workspace', 'isolated-worktree', 'dedicated-process'] },
        work_scopes: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_assign')
        return asJson(await this.ctx.tickets.assign(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id), expectedRevision: args.expected_revision, actorId: agent.id,
          ownerId: SessionId(args.owner_id), subject: args.subject,
          ...args.instructions === undefined ? {} : { instructions: args.instructions },
          ...args.role === undefined ? {} : { role: args.role },
          ...args.execution_mode === undefined ? {} : { executionMode: args.execution_mode },
          ...args.work_scopes === undefined ? {} : { workScopes: workScopes(args.work_scopes) },
        }))
      },
    }))
    register(defineTool({
      name: 'ticket_claim',
      description: 'Claim the calling worker’s assigned Ticket responsibility and start its execution slot.',
      parameters: {
        root_session_id: { type: 'string', required: true },
        ticket_id: { type: 'string', required: true },
        assignment_id: { type: 'string', required: true },
        expected_revision: { type: 'integer', required: true },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_claim')
        return asJson(await this.ctx.tickets.claim(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id),
          assignmentId: AssignmentId(args.assignment_id),
          expectedRevision: args.expected_revision,
          actorId: agent.id,
        }))
      },
    }))
    register(defineTool({
      name: 'ticket_release',
      description: 'Release a Ticket assignment while retaining its worker owner for later resumption.',
      parameters: {
        root_session_id: { type: 'string', required: true },
        ticket_id: { type: 'string', required: true },
        assignment_id: { type: 'string', required: true },
        expected_revision: { type: 'integer', required: true },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_release')
        return asJson(await this.ctx.tickets.release(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id),
          assignmentId: AssignmentId(args.assignment_id),
          expectedRevision: args.expected_revision,
          actorId: agent.id,
        }))
      },
    }))
    register(defineTool({
      name: 'ticket_report',
      description: 'Publish a bounded worker progress, result, or failure report for a Ticket assignment.',
      parameters: {
        root_session_id: { type: 'string', required: true },
        ticket_id: { type: 'string', required: true },
        assignment_id: { type: 'string', required: true },
        expected_revision: { type: 'integer', required: true },
        kind: { type: 'string', required: true, enum: ['progress', 'result', 'failure'] },
        summary: { type: 'string', required: true },
        evidence: { type: 'array', items: { type: 'string' } },
        next_steps: { type: 'array', items: { type: 'string' } },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_report')
        return asJson(await this.ctx.tickets.report(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id),
          assignmentId: AssignmentId(args.assignment_id),
          expectedRevision: args.expected_revision,
          actorId: agent.id,
          kind: args.kind,
          summary: args.summary,
          ...args.evidence === undefined ? {} : { evidence: args.evidence },
          ...args.next_steps === undefined ? {} : { nextSteps: args.next_steps },
        }))
      },
    }))
    register(defineTool({
      name: 'ticket_ask',
      description: 'Ask one durable question that moves the Ticket into waiting for a response.',
      parameters: {
        root_session_id: { type: 'string', required: true },
        ticket_id: { type: 'string', required: true },
        assignment_id: { type: 'string' },
        expected_revision: { type: 'integer', required: true },
        question: { type: 'string', required: true },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_ask')
        return asJson(await this.ctx.tickets.ask(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id),
          expectedRevision: args.expected_revision,
          actorId: agent.id,
          question: args.question,
          ...args.assignment_id === undefined ? {} : { assignmentId: AssignmentId(args.assignment_id) },
        }))
      },
    }))
    register(defineTool({
      name: 'ticket_answer',
      description: 'Answer an open Ticket question as its current coordinator.',
      parameters: {
        root_session_id: { type: 'string', required: true },
        ticket_id: { type: 'string', required: true },
        question_id: { type: 'string', required: true },
        expected_revision: { type: 'integer', required: true },
        answer: { type: 'string', required: true },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_answer')
        return asJson(await this.ctx.tickets.answer(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id), questionId: TicketQuestionId(args.question_id),
          expectedRevision: args.expected_revision, actorId: agent.id, answer: args.answer,
        }))
      },
    }))
    register(defineTool({
      name: 'ticket_close_question',
      description: 'Close an open or answered Ticket question as its author or current coordinator.',
      parameters: {
        root_session_id: { type: 'string', required: true },
        ticket_id: { type: 'string', required: true },
        question_id: { type: 'string', required: true },
        expected_revision: { type: 'integer', required: true },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_close_question')
        return asJson(await this.ctx.tickets.closeQuestion(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id), questionId: TicketQuestionId(args.question_id),
          expectedRevision: args.expected_revision, actorId: agent.id,
        }))
      },
    }))
    for (const [toolName, action] of [['ticket_acknowledge_attention', 'acknowledgeAttention'], ['ticket_resolve_attention', 'resolveAttention']] as const) {
      register(defineTool({
        name: toolName,
        description: action === 'acknowledgeAttention'
          ? 'Acknowledge an open Ticket attention item as coordinator; it remains unresolved.'
          : 'Resolve a Ticket attention item as coordinator while preserving other blockers.',
        parameters: {
          root_session_id: { type: 'string', required: true },
          ticket_id: { type: 'string', required: true },
          attention_id: { type: 'string', required: true },
          expected_revision: { type: 'integer', required: true },
        },
        output: jsonOutput(),
        execute: async (args, exec) => {
          const agent = agentOf(exec.agent, toolName)
          return asJson(await this.ctx.tickets[action](sessionOf(this.ctx, args.root_session_id, agent), {
            ticketId: TicketId(args.ticket_id), attentionId: TicketAttentionId(args.attention_id),
            expectedRevision: args.expected_revision, actorId: agent.id,
          }))
        },
      }))
    }
    register(defineTool({
      name: 'ticket_attention',
      description: 'Raise a human-visible review, question, blocked, or decision item for a Ticket.',
      parameters: {
        root_session_id: { type: 'string', required: true },
        ticket_id: { type: 'string', required: true },
        assignment_id: { type: 'string' },
        expected_revision: { type: 'integer', required: true },
        kind: { type: 'string', required: true, enum: ['review', 'question', 'blocked', 'decision'] },
        message: { type: 'string', required: true },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_attention')
        return asJson(await this.ctx.tickets.attention(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id),
          expectedRevision: args.expected_revision,
          actorId: agent.id,
          kind: args.kind,
          message: args.message,
          ...args.assignment_id === undefined ? {} : { assignmentId: AssignmentId(args.assignment_id) },
        }))
      },
    }))
    register(defineTool({
      name: 'ticket_block',
      description: 'Block a Ticket with a durable reason under coordinator or worker authority.',
      parameters: {
        root_session_id: { type: 'string', required: true },
        ticket_id: { type: 'string', required: true },
        expected_revision: { type: 'integer', required: true },
        reason: { type: 'string', required: true },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_block')
        return asJson(await this.ctx.tickets.block(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id),
          expectedRevision: args.expected_revision,
          actorId: agent.id,
          reason: args.reason,
        }))
      },
    }))
    register(defineTool({
      name: 'ticket_handoff',
      description: 'Transfer soft coordinator authority to another direct Session.',
      parameters: {
        root_session_id: { type: 'string', required: true },
        ticket_id: { type: 'string', required: true },
        expected_revision: { type: 'integer', required: true },
        new_coordinator_id: { type: 'string', required: true },
      },
      output: jsonOutput(),
      execute: async (args, exec) => {
        const agent = agentOf(exec.agent, 'ticket_handoff')
        return asJson(await this.ctx.tickets.handoff(sessionOf(this.ctx, args.root_session_id, agent), {
          ticketId: TicketId(args.ticket_id),
          expectedRevision: args.expected_revision,
          actorId: agent.id,
          newCoordinatorId: SessionId(args.new_coordinator_id),
        }))
      },
    }))
    for (const [toolName, action] of [['ticket_complete', 'complete'], ['ticket_fail', 'fail'], ['ticket_cancel', 'cancel'] as const]) {
      register(defineTool({
        name: toolName,
        description: `End a Ticket as ${action} with a durable terminal summary.`,
        parameters: {
          root_session_id: { type: 'string', required: true },
          ticket_id: { type: 'string', required: true },
          expected_revision: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
        },
        output: jsonOutput(),
        execute: async (args, exec) => {
          const agent = agentOf(exec.agent, toolName)
          const session = sessionOf(this.ctx, args.root_session_id, agent)
          const request = {
            ticketId: TicketId(args.ticket_id),
            expectedRevision: args.expected_revision,
            actorId: agent.id,
            summary: args.summary,
          }
          if (action === 'complete') return asJson(await this.ctx.tickets.complete(session, request))
          if (action === 'fail') return asJson(await this.ctx.tickets.fail(session, request))
          return asJson(await this.ctx.tickets.cancel(session, request))
        },
      }))
    }
  }
}

export default TicketTools
