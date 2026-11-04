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
    'ticket_report', 'ticket_attention', 'ticket_answer', 'ticket_close_question',
    'ticket_acknowledge_attention', 'ticket_resolve_attention',
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

it('runs question and attention tools with caller authority and current revisions', async () => {
  const ctx = await harness()
  const root = agent(ctx, 'resolution-coordinator')
  const worker = agent(ctx, 'resolution-worker')
  const created = await ctx.tickets.create(root.session, { subject: 'Resolve', description: '' })
  const assigned = await ctx.tickets.assign(root.session, { ticketId: created.id, expectedRevision: 1, actorId: root.id, ownerId: worker.id, subject: 'Work' })
  const common = { root_session_id: root.id, ticket_id: created.id }
  const asked = await call(ctx, 'ticket_ask', { ...common, expected_revision: assigned.revision, assignment_id: assigned.assignments[0]!.id, question: 'Which API?' }, worker) as { revision: number; questions: [{ id: string }] }
  const question = { ...common, question_id: asked.questions[0].id }
  await expect(call(ctx, 'ticket_answer', { ...question, expected_revision: asked.revision, answer: 'Use mine' }, worker)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  const answered = await call(ctx, 'ticket_answer', { ...question, expected_revision: asked.revision, answer: 'Use public API' }, root) as { revision: number; questions: [{ status: string; answeredBy: string }] }
  expect(answered.questions[0]).toMatchObject({ status: 'answered', answeredBy: root.id })
  await expect(call(ctx, 'ticket_close_question', { ...question, expected_revision: asked.revision }, worker)).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
  const closed = await call(ctx, 'ticket_close_question', { ...question, expected_revision: answered.revision }, worker) as { revision: number; questions: [{ status: string }] }
  expect(closed.questions[0].status).toBe('closed')
  const blocked = await call(ctx, 'ticket_block', { ...common, expected_revision: closed.revision, reason: 'Access required' }, worker) as { revision: number; attentions: [{ id: string }] }
  const attention = { ...common, attention_id: blocked.attentions[0].id }
  await expect(call(ctx, 'ticket_resolve_attention', { ...attention, expected_revision: blocked.revision }, worker)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  const acknowledged = await call(ctx, 'ticket_acknowledge_attention', { ...attention, expected_revision: blocked.revision }, root) as { revision: number; status: string }
  expect(acknowledged.status).toBe('blocked')
  const resolved = await call(ctx, 'ticket_resolve_attention', { ...attention, expected_revision: acknowledged.revision }, root) as { revision: number; status: string; attentions: [{ status: string }] }
  expect(resolved).toMatchObject({ status: 'executing', attentions: [{ status: 'resolved' }] })
})

it('restricts cross-root reads to participants and creation to the calling Session', async () => {
  const ctx = await harness()
  const root = agent(ctx, 'private-root')
  const worker = agent(ctx, 'participant')
  const stranger = agent(ctx, 'unrelated')
  const ticket = await ctx.tickets.create(root.session, { subject: 'Visible to worker', description: '' })
  await ctx.tickets.assign(root.session, { ticketId: ticket.id, expectedRevision: 1, actorId: root.id, ownerId: worker.id, subject: 'Work' })
  const privateTicket = await ctx.tickets.create(root.session, { subject: 'Other work', description: '' })
  const events = root.session.snapshotEvents()
  await expect(call(ctx, 'ticket_get', { root_session_id: root.id, ticket_id: ticket.id }, stranger)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(call(ctx, 'ticket_list', { root_session_id: root.id }, stranger)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(call(ctx, 'ticket_get', { root_session_id: root.id, ticket_id: privateTicket.id }, worker)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(call(ctx, 'ticket_create', { root_session_id: root.id, subject: 'Injected', description: '' }, stranger)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(call(ctx, 'ticket_create', { coordinator_id: root.id, subject: 'Forged coordinator', description: '' }, stranger)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  const listed = await call(ctx, 'ticket_list', { root_session_id: root.id }, worker) as { tickets: [{ id: string }] }
  expect(listed.tickets.map(item => item.id)).toEqual([ticket.id])
  expect(root.session.snapshotEvents()).toEqual(events)
  expect(ctx.tickets.list(stranger.session)).toEqual([])
})
