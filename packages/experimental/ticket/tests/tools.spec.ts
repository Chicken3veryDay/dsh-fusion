import { ticketActor } from './ticket-actor.ts'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import TicketService, { TicketAttemptId, TicketOperationId, TicketTools } from '../src/index.ts'

async function agent(ctx: Context, id: string): Promise<Agent> {
  const session = ctx.sessions.create(SessionId(id))
  const caller = {
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
  await ctx.agents.register(caller)
  return caller
}

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AgentRegistry)
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
  const root = await agent(ctx, 'ticket-coordinator')
  const worker = await agent(ctx, 'ticket-worker')
  const names = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('ticket_')).sort()
  expect(names).toEqual([
    'ticket_ask', 'ticket_assign', 'ticket_block', 'ticket_cancel', 'ticket_claim', 'ticket_complete',
    'ticket_create', 'ticket_fail', 'ticket_get', 'ticket_handoff', 'ticket_list', 'ticket_release',
    'ticket_report', 'ticket_attention', 'ticket_answer', 'ticket_close_question',
    'ticket_acknowledge_attention', 'ticket_resolve_attention',
    'ticket_revise', 'ticket_submit_candidate', 'ticket_check_candidate',
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
  const root = await agent(ctx, 'resolution-coordinator')
  const worker = await agent(ctx, 'resolution-worker')
  const created = await ticketActor(ctx, (root.session).id, () => ctx.tickets.create(root.session, { subject: 'Resolve', description: '' }))
  const assigned = await ticketActor(ctx, root.id, () =>
    ctx.tickets.assign(root.session, { ticketId: created.id, expectedRevision: 1, actorId: root.id, ownerId: worker.id, subject: 'Work' }))
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
  const root = await agent(ctx, 'private-root')
  const worker = await agent(ctx, 'participant')
  const stranger = await agent(ctx, 'unrelated')
  const ticket = await ticketActor(ctx, (root.session).id, () =>
    ctx.tickets.create(root.session, { subject: 'Visible to worker', description: '' }))
  await ticketActor(ctx, root.id, () =>
    ctx.tickets.assign(root.session, { ticketId: ticket.id, expectedRevision: 1, actorId: root.id, ownerId: worker.id, subject: 'Work' }))
  const privateTicket = await ticketActor(ctx, (root.session).id, () =>
    ctx.tickets.create(root.session, { subject: 'Other work', description: '' }))
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

it('drives specification, candidate, and independent check tools with caller authority and stale rejection', async () => {
  const ctx = await harness()
  const root = await agent(ctx, 'accept-coordinator')
  const worker = await agent(ctx, 'accept-worker')
  const created = await ticketActor(ctx, (root.session).id, () => ctx.tickets.create(root.session, { subject: 'Accept', description: '' }))
  const common = { root_session_id: root.id, ticket_id: created.id }
  const criteria = [
    { id: 'built', description: 'Work is built', required: true, independent: false },
    { id: 'validated', description: 'Independently validated', required: true, independent: true },
  ]
  await expect(call(ctx, 'ticket_revise', { ...common, expected_revision: 1, acceptance_criteria: criteria }, worker)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  const revised = await call(ctx, 'ticket_revise', { ...common, expected_revision: 1, acceptance_criteria: criteria }, root) as {
    revision: number
    specification: { revision: number; acceptanceCriteria: { id: string }[] }
  }
  expect(revised.specification).toMatchObject({ revision: 2, acceptanceCriteria: [{ id: 'built' }, { id: 'validated' }] })
  const assigned = await ticketActor(ctx, root.id, () => ctx.tickets.assign(root.session, {
    ticketId: created.id, expectedRevision: revised.revision, actorId: root.id, ownerId: worker.id, subject: 'Build',
  }))
  const assignmentId = assigned.assignments[0]!.id
  const claim = { ticketId: created.id, assignmentId, expectedRevision: assigned.revision, actorId: worker.id }
  const claimed = await ticketActor(ctx, (claim).actorId, () => ctx.tickets.claim(root.session, claim))
  const result = { ...common, assignment_id: assignmentId, expected_revision: claimed.revision, kind: 'result', summary: 'Built' }
  const reported = await call(ctx, 'ticket_report', result, worker) as { revision: number }
  const submitted = await call(ctx, 'ticket_submit_candidate', {
    ...common, expected_revision: reported.revision, candidate_id: 'cand-1', spec_revision: 2, assignment_ids: [assignmentId],
    content: { kind: 'artifact', reference: 'artifact://build/1', digest: 'sha256:' + 'a'.repeat(64) },
  }, worker) as { revision: number; currentCandidateId: string; candidates: { id: string; authorId: string; content: { kind: string } }[] }
  expect(submitted).toMatchObject({ currentCandidateId: 'cand-1', candidates: [{ id: 'cand-1', authorId: worker.id, content: { kind: 'artifact' } }] })
  const check = { ...common, candidate_id: 'cand-1', spec_revision: 2, outcome: 'pass', evidence: ['ran suite'] }
  await expect(call(ctx, 'ticket_check_candidate', { ...check, check_id: 'self', criterion_id: 'validated', expected_revision: submitted.revision }, worker)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  const built = await call(ctx, 'ticket_check_candidate', { ...check, check_id: 'c-built', criterion_id: 'built', expected_revision: submitted.revision }, root) as { revision: number }
  await expect(call(ctx, 'ticket_check_candidate', { ...check, check_id: 'stale', criterion_id: 'validated', spec_revision: 1, expected_revision: built.revision }, root)).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
  const validated = await call(ctx, 'ticket_check_candidate', { ...check, check_id: 'c-valid', criterion_id: 'validated', expected_revision: built.revision }, root) as { checks: { id: string; authorId: string }[] }
  expect(validated.checks.map(item => item.id)).toEqual(['c-built', 'c-valid'])
  expect(ctx.tickets.get(root.session, created.id).checks.at(-1)?.authorId).toBe(root.id)
})

it('names the active attempt when a worker reports through ticket_report', async () => {
  const ctx = await harness()
  const root = await agent(ctx, 'attempt-coordinator')
  const worker = await agent(ctx, 'attempt-worker')
  const created = await ticketActor(ctx, (root.session).id, () => ctx.tickets.create(root.session, { subject: 'Attempt', description: '' }))
  const assigned = await ticketActor(ctx, root.id, () =>
    ctx.tickets.assign(root.session, { ticketId: created.id, expectedRevision: 1, actorId: root.id, ownerId: worker.id, subject: 'Build' }))
  const assignmentId = assigned.assignments[0]!.id
  const begun = await ticketActor(ctx, root.id, () => ctx.tickets.beginAttempt(root.session, {
    ticketId: created.id, expectedRevision: assigned.revision, actorId: root.id, assignmentId, attemptId: TicketAttemptId('attempt-1'),
    operationId: TicketOperationId('begin-1'), workspace: { kind: 'shared-workspace', directory: '/tmp/work' }, executor: { kind: 'in-process' },
  }))
  const common = { root_session_id: root.id, ticket_id: created.id, assignment_id: assignmentId, kind: 'progress', summary: 'Working' }
  await expect(call(ctx, 'ticket_report', { ...common, expected_revision: begun.revision }, worker)).rejects.toMatchObject({ code: 'TICKET_STALE_ATTEMPT' })
  await expect(call(ctx, 'ticket_report', { ...common, expected_revision: begun.revision, attempt_id: 'attempt-superseded' }, worker)).rejects.toMatchObject({ code: 'TICKET_STALE_ATTEMPT' })
  const reported = await call(ctx, 'ticket_report', { ...common, expected_revision: begun.revision, attempt_id: 'attempt-1' }, worker) as { reports: { attemptId?: string }[] }
  expect(reported.reports.at(-1)?.attemptId).toBe('attempt-1')
})

it('refuses a terminal outcome while an attempt is unsettled and accepts cancellation once it settles', async () => {
  const ctx = await harness()
  const root = await agent(ctx, 'unsettled-coordinator')
  const worker = await agent(ctx, 'unsettled-worker')
  const created = await ticketActor(ctx, (root.session).id, () =>
    ctx.tickets.create(root.session, { subject: 'Unsettled', description: '' }))
  const assigned = await ticketActor(ctx, root.id, () =>
    ctx.tickets.assign(root.session, { ticketId: created.id, expectedRevision: 1, actorId: root.id, ownerId: worker.id, subject: 'Build' }))
  const begun = await ticketActor(ctx, root.id, () => ctx.tickets.beginAttempt(root.session, {
    ticketId: created.id, expectedRevision: assigned.revision, actorId: root.id, assignmentId: assigned.assignments[0]!.id,
    attemptId: TicketAttemptId('attempt-unsettled'), operationId: TicketOperationId('begin-unsettled'),
    workspace: { kind: 'shared-workspace', directory: '/tmp/work' }, executor: { kind: 'in-process' },
  }))
  const end = { ticketId: created.id, actorId: root.id, summary: 'Stop' }
  const before = ctx.tickets.get(root.session, created.id)
  await expect(ticketActor(ctx, ({ ...end, expectedRevision: begun.revision }).actorId, () =>
    ctx.tickets.cancel(root.session, { ...end, expectedRevision: begun.revision }))).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  expect(ctx.tickets.get(root.session, created.id)).toEqual(before)
  const settled = await ticketActor(ctx, root.id, () => ctx.tickets.settleAttempt(root.session, {
    ticketId: created.id, expectedRevision: begun.revision, actorId: root.id, attemptId: TicketAttemptId('attempt-unsettled'),
    operationId: TicketOperationId('settle-unsettled'), outcome: 'cancelled',
  }))
  await expect(ticketActor(ctx, ({ ...end, expectedRevision: settled.revision }).actorId, () =>
    ctx.tickets.cancel(root.session, { ...end, expectedRevision: settled.revision }))).resolves.toMatchObject({ status: 'cancelled' })
})
