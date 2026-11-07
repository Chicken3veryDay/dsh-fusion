import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolRunContext } from '@deepseek-ai/dsh-tools'
import TicketService, { TicketTools } from '../src/index.ts'
import { ticketSnapshotSchema } from '../src/projection.ts'
import { ticketActor } from './ticket-actor.ts'

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
  async function actor(id: string): Promise<Agent> {
    const session = ctx.sessions.create(SessionId(id))
    const agent: Agent = { id: session.id, session, options: {}, status: 'idle', ctx,
      model: unsupportedModel(), inbox: unsupportedInbox(), send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
      whenIdle: async () => {}, runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
    await ctx.agents.register(agent)
    return agent
  }
  const root = await actor('tools-coverage-root')
  const worker = await actor('tools-coverage-worker')
  async function call(name: string, args: Record<string, unknown>, caller: Agent = root) {
    const tool = ctx.tools.get(name)!
    return tool.execute(args, { agent: caller, signal: new AbortController().signal } as ToolRunContext)
  }
  return { ctx, root, worker, call, actor }
}

it('runs question, attention, block and terminal tools with durable results', async () => {
  const { call, root, worker, ctx } = await harness()
  let ticket = ticketSnapshotSchema.parse(await call('ticket_create', {
    subject: 'Tools', description: '', coordinator_id: root.id,
    work_scopes: [{ path: 'src', access: 'write', exclusive: false }, { path: 'docs', access: 'read' }],
  }))
  const mutate = async (name: string, args: Record<string, unknown>, caller = root) => {
    ticket = ticketSnapshotSchema.parse(await call(name, {
      root_session_id: root.id, ticket_id: ticket.id, expected_revision: ticket.revision,
      ...args }, caller))
    return ticket
  }
  await mutate('ticket_assign', { owner_id: worker.id, subject: 'Build', instructions: 'Carefully', role: 'worker', execution_mode: 'shared-workspace', work_scopes: [{ path: 'src', access: 'write', exclusive: false }] })
  const assignmentId = ticket.assignments[0]!.id
  await mutate('ticket_claim', { assignment_id: assignmentId }, worker)
  await mutate('ticket_release', { assignment_id: assignmentId }, worker)
  await mutate('ticket_ask', { assignment_id: assignmentId, question: 'Which scope?' }, worker)
  await mutate('ticket_answer', { question_id: ticket.questions[0]!.id, answer: 'src' })
  await mutate('ticket_close_question', { question_id: ticket.questions[0]!.id }, worker)
  await mutate('ticket_attention', { assignment_id: assignmentId, kind: 'review', message: 'Review me' }, worker)
  await mutate('ticket_acknowledge_attention', { attention_id: ticket.attentions[0]!.id })
  await mutate('ticket_resolve_attention', { attention_id: ticket.attentions[0]!.id })
  await mutate('ticket_block', { reason: 'Waiting' }, worker)
  await mutate('ticket_resolve_attention', { attention_id: ticket.attentions.at(-1)!.id })
  await mutate('ticket_claim', { assignment_id: assignmentId }, worker)
  await mutate('ticket_report', { assignment_id: assignmentId, kind: 'result', summary: 'Built', evidence: ['tests'], next_steps: ['review'] }, worker)
  expect(ticket.assignments[0]!.status).toBe('completed')
  await mutate('ticket_handoff', { new_coordinator_id: worker.id })
  expect(ticket.coordinatorId).toBe(worker.id)
  await mutate('ticket_fail', { summary: 'Cannot finish' }, worker)
  expect(ticket.terminalOutcome?.kind).toBe('failed')
  expect(await call('ticket_get', { root_session_id: root.id, ticket_id: ticket.id }, worker)).toEqual(ticket)
  expect(await call('ticket_list', { root_session_id: root.id }, worker)).toMatchObject({ tickets: [ticket] })
  const second = ticketSnapshotSchema.parse(await call('ticket_create', { subject: 'Cancel', description: '' }))
  const cancelled = ticketSnapshotSchema.parse(await call('ticket_cancel', { root_session_id: root.id, ticket_id: second.id, expected_revision: second.revision, summary: 'Stopped' }))
  expect(cancelled.terminalOutcome?.kind).toBe('cancelled')
  expect(ctx.tickets.get(root.session, ticket.id)).toEqual(ticket)
  const third = ticketSnapshotSchema.parse(await call('ticket_create', { subject: 'Questions', description: '' }))
  const asked = ticketSnapshotSchema.parse(await call('ticket_ask', { root_session_id: root.id, ticket_id: third.id, expected_revision: third.revision, question: 'Why?' }))
  expect(asked.questions[0]!.assignmentId).toBeUndefined()
  const attention = ticketSnapshotSchema.parse(await call('ticket_attention', { root_session_id: root.id, ticket_id: asked.id, expected_revision: asked.revision, kind: 'decision', message: 'Decide' }))
  expect(attention.attentions[0]!.assignmentId).toBeUndefined()
})

it('runs specification and content tools for commit and artifact candidates', async () => {
  const { call, root, worker, ctx } = await harness()
  const parent = await ticketActor(ctx, root.id, () => ctx.tickets.create(root.session, { subject: 'Parent', description: '' }))
  let ticket = await ticketActor(ctx, root.id, () => ctx.tickets.create(root.session, { subject: 'Candidate', description: '', parent: { ticketId: parent.id, required: false } }))
  const mutate = async (name: string, args: Record<string, unknown>, caller = root) => {
    ticket = ticketSnapshotSchema.parse(await call(name, {
      root_session_id: root.id, ticket_id: ticket.id, expected_revision: ticket.revision,
      ...args }, caller))
  }
  await mutate('ticket_assign', { owner_id: worker.id, subject: 'Build' })
  await mutate('ticket_revise', { acceptance_criteria: [{ id: 'check', description: 'Test', required: true, independent: false }] })
  expect(ticket.specification.parent).toEqual({ ticketId: parent.id, required: false })
  await mutate('ticket_report', { assignment_id: ticket.assignments[0]!.id, kind: 'result', summary: 'Built' }, worker)
  for (const content of [
    { kind: 'commit', repository: 'origin', commit: 'a'.repeat(40) },
    { kind: 'artifact', reference: 'build:1', digest: `sha256:${'b'.repeat(64)}` },
  ]) {
    await mutate('ticket_submit_candidate', { candidate_id: content.kind, spec_revision: ticket.specification.revision, assignment_ids: [ticket.assignments[0]!.id], content })
    expect(ticket.candidates.at(-1)!.content).toEqual(content)
  }
  await mutate('ticket_check_candidate', { check_id: 'test', candidate_id: ticket.currentCandidateId, criterion_id: 'check', spec_revision: ticket.specification.revision, outcome: 'pass', evidence: ['test passed'] })
  await mutate('ticket_complete', { summary: 'Accepted' })
  expect(ticket.terminalOutcome?.kind).toBe('completed')
})

it('rejects malformed nested tool inputs without appending events', async () => {
  const { call, root } = await harness()
  const ticket = ticketSnapshotSchema.parse(await call('ticket_create', { subject: 'Invalid inputs', description: '' }))
  const common = { root_session_id: root.id, ticket_id: ticket.id, expected_revision: ticket.revision }
  const before = root.session.snapshotEvents()
  for (const row of [{ path: 1, access: 'read' }, { path: 'src', access: 'execute' }, { path: 'src', access: 'write', exclusive: 1 }]) {
    await expect(call('ticket_create', { subject: 'Invalid scope', description: '', work_scopes: [row] })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  }
  for (const row of [
    { id: 1, description: 'Check', required: true, independent: false },
    { id: 'check', description: 1, required: true, independent: false },
    { id: 'check', description: 'Check', required: 1, independent: false },
    { id: 'check', description: 'Check', required: true, independent: 1 },
  ]) await expect(call('ticket_revise', { ...common, acceptance_criteria: [row] })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  for (const content of [
    {}, { kind: 'commit', repository: 1, commit: 'a' }, { kind: 'commit', repository: 'origin', commit: 1 },
    { kind: 'artifact', reference: 1, digest: 'a' }, { kind: 'artifact', reference: 'build', digest: 1 },
  ]) await expect(call('ticket_submit_candidate', { ...common, candidate_id: 'invalid', spec_revision: 1, assignment_ids: [], content })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(root.session.snapshotEvents()).toEqual(before)
})

it('requires a caller and a live root for every tool and denies unrelated readers', async () => {
  const { ctx, call, root, worker } = await harness()
  await expect(ctx.tools.get('ticket_list')!.execute({}, { signal: new AbortController().signal } as ToolRunContext)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(call('ticket_list', { root_session_id: 'missing' })).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' })
  const ticket = ticketSnapshotSchema.parse(await call('ticket_create', { subject: 'Private', description: '' }))
  await expect(call('ticket_get', { root_session_id: root.id, ticket_id: ticket.id }, worker)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(call('ticket_list', { root_session_id: root.id }, worker)).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  expect(await call('ticket_list', {}, worker)).toEqual({ tickets: [] })
  expect(await call('ticket_get', { ticket_id: ticket.id })).toEqual(ticket)
  const stale = ctx.sessions.prepare(SessionId('stale'))
  const caller = { ...worker, id: stale.id, session: stale }
  await expect(call('ticket_list', {}, caller)).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' })
})
