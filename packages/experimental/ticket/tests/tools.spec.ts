import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import TicketService, { TicketTools } from '../src/index.ts'

function agent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return {
    id: session.id,
    session,
    options: {},
    status: 'idle',
    ctx,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
  } satisfies Agent
}

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(TicketService)
  await ctx.plugin(TicketTools)
  return ctx
}

async function call(ctx: Context, name: string, argumentsValue: Record<string, unknown>, caller: Agent): Promise<unknown> {
  const definition = ctx.tools.get(name)
  if (definition === undefined) throw new Error(`missing Ticket tool ${name}`)
  const exec = { agent: caller, signal: new AbortController().signal } as ToolRunContext
  return definition.execute(argumentsValue, exec)
}

it('registers direct-worker tools and preserves actor identity plus CAS failures', async () => {
  const ctx = await harness()
  const root = agent(ctx, 'ticket-coordinator')
  const worker = agent(ctx, 'ticket-worker')
  const names = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('ticket_')).sort()
  expect(names).toEqual([
    'ticket_ask', 'ticket_assign', 'ticket_block', 'ticket_cancel', 'ticket_claim', 'ticket_complete',
    'ticket_create', 'ticket_fail', 'ticket_get', 'ticket_handoff', 'ticket_list', 'ticket_release',
    'ticket_report', 'ticket_attention',
  ].sort())

  const created = await call(ctx, 'ticket_create', {
    subject: 'Coordinate the change',
    description: 'The worker must report a durable result.',
  }, root) as { id: string; revision: number; coordinatorId: string }
  expect(created).toMatchObject({ revision: 1, coordinatorId: root.id })

  const assigned = await call(ctx, 'ticket_assign', {
    root_session_id: root.id,
    ticket_id: created.id,
    expected_revision: created.revision,
    owner_id: worker.id,
    subject: 'Implement the change',
    execution_mode: 'dedicated-process',
  }, root) as { revision: number; assignments: [{ id: string; status: string }] }
  expect(assigned.assignments[0]).toMatchObject({ status: 'assigned' })

  await expect(call(ctx, 'ticket_claim', {
    root_session_id: root.id,
    ticket_id: created.id,
    assignment_id: assigned.assignments[0].id,
    expected_revision: assigned.revision,
  }, root)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })

  const claimed = await call(ctx, 'ticket_claim', {
    root_session_id: root.id,
    ticket_id: created.id,
    assignment_id: assigned.assignments[0].id,
    expected_revision: assigned.revision,
  }, worker) as { revision: number; assignments: [{ status: string }] }
  expect(claimed).toMatchObject({ revision: 3, assignments: [{ status: 'running' }] })

  await expect(call(ctx, 'ticket_report', {
    root_session_id: root.id,
    ticket_id: created.id,
    assignment_id: assigned.assignments[0].id,
    expected_revision: assigned.revision,
    kind: 'progress',
    summary: 'stale report',
  }, worker)).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })

  const read = await call(ctx, 'ticket_get', { root_session_id: root.id, ticket_id: created.id }, worker) as {
    revision: number
    assignments: [{ ownerId: string; status: string }]
  }
  expect(read).toMatchObject({ revision: claimed.revision, assignments: [{ ownerId: worker.id, status: 'running' }] })
})
