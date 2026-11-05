/** Model tools preserve caller identity and select an explicit Workstream root. */
import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TicketId } from '@deepseek-ai/dsh-experimental-ticket'
import { WorkstreamOperationId } from './ids.ts'

function caller(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('Workstream tools require a live calling Agent')
  return agent
}
const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown): [{ type: 'text'; text: string }] => [{ type: 'text', text: JSON.stringify(value) }],
}
const root = { type: 'string' as const, required: true as const, description: 'Stable technical owner Session id.' }
const operation = { type: 'string' as const, required: true as const, description: 'Stable operation id; reuse exactly for retries.' }

const contextPacket = {
  type: 'object' as const, additionalProperties: false, description: 'Optional context for the recipient; every field is logged.',
  properties: {
    requirements: { type: 'string' as const, required: true as const, description: 'Current requirements the recipient must work from.' },
    decisions: { type: 'array' as const, required: true as const, items: { type: 'string' as const }, description: 'Relevant decisions.' },
    cursor: { type: 'string' as const, required: true as const, description: 'Opaque cursor this packet is current to.' },
    changes: { type: 'string' as const, required: true as const, description: 'Changes since the recipient\'s recorded cursor.' },
    artifacts: { type: 'array' as const, required: true as const, description: 'Selected artifact refs with digests.', items: {
      type: 'object' as const, additionalProperties: false, properties: { ref: { type: 'string' as const, required: true as const,
        description: 'Artifact reference.' }, digest: { type: 'string' as const, required: true as const, description:
        'Content digest.' } } } },
  },
}

/** Opt-in Workstream tool registration with reversible Cordis ownership. */
export class WorkstreamTools extends Service {
  static inject = ['tools', 'workstreams']
  constructor(ctx: Context) { super(ctx, 'workstreamTools') }

  protected [Service.init](): void {
    const register = (tool: Parameters<Context['tools']['register']>[0]): void => { this.ctx.tools.register(tool) }
    register(defineTool({
      name: 'workstream_open', description: 'Open a durable Workstream in your root Session. Tickets are its only work board.',
      parameters: { operation_id: operation, title: { type: 'string', required: true, description: 'Workstream title.' } }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.open(caller(exec.agent), { operationId:
        WorkstreamOperationId(args.operation_id), title: args.title })),
    }))
    register(defineTool({
      name: 'workstream_get', description: 'Read members, coordinator and durable message receipts for one Workstream.',
      parameters: { root_session_id: root }, output,
      execute: (args, exec) => Promise.resolve(z.json().parse(this.ctx.workstreams.get(caller(exec.agent),
        SessionId(args.root_session_id)))),
    }))
    register(defineTool({
      name: 'workstream_list', description: 'List your live Workstream memberships.', parameters: {}, output,
      execute: (_args, exec) => Promise.resolve(z.json().parse(this.ctx.workstreams.list(caller(exec.agent)))),
    }))
    register(defineTool({
      name: 'workstream_add_member', description:
        'Provision or reuse a continuable member. An uncertain operation is never launched twice.',
      parameters: { root_session_id: root, operation_id: operation, name: { type: 'string', required: true, description:
        'Unique member name.' }, description: { type: 'string', required: true, description: 'Member responsibility.' }, provider: {
        type: 'string', required: true, description: 'Configured continuable Subagent provider.' }, prompt: { type: 'string',
        required: true, description: 'Initial member instructions.' } }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.addMember(caller(exec.agent),
        SessionId(args.root_session_id), { operationId: WorkstreamOperationId(args.operation_id), name: args.name, description:
        args.description, provider: args.provider, prompt: args.prompt, signal: exec.signal })),
    }))
    register(defineTool({
      name: 'workstream_send', description:
        'Send a peer message, optionally with a context packet (current requirements, decisions, changes since your cursor, artifact refs). '
        + 'The recipient sees and the log keeps the whole packet; the complete message is bounded by maxMessageBytes. '
        + 'Accepted means durable inbox acceptance; only recipient acknowledgement marks processed.',
      parameters: { root_session_id: root, operation_id: operation, target_id: { type: 'string', required: true, description:
        'Recipient member Session id.' }, text: { type: 'string', required: true, description: 'Message content.' }, context:
        contextPacket }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.sendMessage(caller(exec.agent),
        SessionId(args.root_session_id), { operationId: WorkstreamOperationId(args.operation_id), targetId:
        SessionId(args.target_id), text: args.text, ...args.context === undefined ? {} : { context: args.context },
        signal: exec.signal })),
    }))
    register(defineTool({
      name: 'workstream_acknowledge', description: 'Explicitly acknowledge processing a message addressed to you.',
      parameters: { root_session_id: root, operation_id: operation }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.acknowledge(caller(exec.agent),
        SessionId(args.root_session_id), WorkstreamOperationId(args.operation_id))),
    }))
    register(defineTool({
      name: 'workstream_handoff', description:
        'Transfer coordinator role to an active member while keeping the original technical owner and child parents.',
      parameters: { root_session_id: root, expected_revision: { type: 'integer', required: true, description:
        'Revision read from workstream_get.' }, coordinator_id: { type: 'string', required: true, description:
        'New coordinator member Session id.' } }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.handoff(caller(exec.agent),
        SessionId(args.root_session_id), { expectedRevision: args.expected_revision, coordinatorId: SessionId(args.coordinator_id) })),
    }))
    register(defineTool({
      name: 'workstream_wait', description:
        'Wait for a durable Workstream or Ticket event with cancellation and a finite timeout. Unrelated Ticket work may continue.',
      parameters: { root_session_id: root, after_revision: { type: 'integer', required: true, description:
        'Last Workstream revision.' }, timeout_ms: { type: 'integer', required: true, description:
        'Positive timeout bounded by maxWaitMs.' } }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.waitForChange(caller(exec.agent),
        SessionId(args.root_session_id), { afterRevision: args.after_revision, timeoutMs: args.timeout_ms, signal: exec.signal })),
    }))
    register(defineTool({
      name: 'workstream_interrupt', description: 'Interrupt a member current turn while retaining its pending inbox.',
      parameters: { root_session_id: root, target_id: { type: 'string', required: true, description: 'Child member Session id.' } }, output,
      execute: (args, exec) => { this.ctx.workstreams.interrupt(caller(exec.agent), SessionId(args.root_session_id),
        SessionId(args.target_id)); return Promise.resolve({ interrupted: true }) },
    }))
    register(defineTool({
      name: 'workstream_stop', description: 'Stop one child and await actual producer settlement before releasing it.',
      parameters: { root_session_id: root, target_id: { type: 'string', required: true, description:
        'Child member other than the coordinator.' } }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.stop(caller(exec.agent),
        SessionId(args.root_session_id), SessionId(args.target_id))),
    }))
    register(defineTool({
      name: 'workstream_create_ticket', description: 'Propose a Ticket in the Workstream root. All work is tracked as Tickets.',
      parameters: { root_session_id: root, subject: { type: 'string', required: true, description: 'Ticket subject.' },
        description: { type: 'string', required: true, description: 'Requirements and acceptance criteria.' } }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.createTicket(caller(exec.agent),
        SessionId(args.root_session_id), { subject: args.subject, description: args.description })),
    }))
    register(defineTool({
      name: 'workstream_assign_ticket', description:
        'Assign root-owned Ticket work to an active Workstream member under coordinator authority.',
      parameters: { root_session_id: root, ticket_id: { type: 'string', required: true, description: 'Root-owned Ticket id.',
      }, expected_revision: { type: 'integer', required: true, description: 'Current Ticket revision.' }, owner_id: { type:
        'string', required: true, description: 'Active child member Session id.' }, subject: { type: 'string', required: true,
        description: 'Assignment responsibility.' } }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.assignTicket(caller(exec.agent),
        SessionId(args.root_session_id), { ticketId: TicketId(args.ticket_id), expectedRevision: args.expected_revision, ownerId:
        SessionId(args.owner_id), subject: args.subject })),
    }))
    register(defineTool({
      name: 'workstream_end_ticket', description:
        'Complete a root-owned Ticket through its existing acceptance checks under coordinator authority.',
      parameters: { root_session_id: root, ticket_id: { type: 'string', required: true, description: 'Root-owned Ticket id.',
      }, expected_revision: { type: 'integer', required: true, description: 'Current Ticket revision.' }, summary: { type:
        'string', required: true, description: 'Integration acceptance summary.' } }, output,
      execute: async (args, exec) => z.json().parse(await this.ctx.workstreams.endTicket(caller(exec.agent),
        SessionId(args.root_session_id), { ticketId: TicketId(args.ticket_id), expectedRevision: args.expected_revision, summary:
        args.summary })),
    }))
  }
}
