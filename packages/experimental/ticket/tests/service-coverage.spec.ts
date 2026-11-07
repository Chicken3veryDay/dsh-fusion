import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TicketService, {
  AssignmentId, MissionId, TicketAttentionId, TicketAttemptId, TicketCandidateId, TicketCheckId,
  TicketCriterionId, TicketId, TicketOperationId, TicketQuestionId,
} from '../src/index.ts'
import type { Config } from '../src/types.ts'
import { ticketActor } from './ticket-actor.ts'

async function harness(config: Config = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService, config)
  const session = ctx.sessions.create(SessionId('service-coverage'))
  const actor = <T>(task: () => Promise<T>): Promise<T> => ticketActor(ctx, session.id, task)
  const create = (subject = 'Coverage') => actor(() => ctx.tickets.create(session, { subject, description: '' }))
  return { ctx, session, actor, create }
}

describe('Ticket service admission limits', () => {
  it.each(['maxTickets', 'maxAssignments', 'maxReports', 'maxQuestions', 'maxAttentions', 'maxWorkScopes', 'maxSnapshotBytes'] as const)(
    'rejects invalid %s configuration', async (key) => {
      const ctx = new Context()
      onTestFinished(() => ctx.fiber.dispose())
      expect(() => new TicketService(ctx, { [key]: 0 })).toThrow('positive safe integer')
      await expect(harness({ [key]: 0 })).rejects.toThrow('invalid config')
    },
  )

  it('bounds Tickets and Assignments and rejects duplicate identities', async () => {
    const { ctx, session, create, actor } = await harness({ maxTickets: 1, maxAssignments: 1 })
    let ticket = await create()
    await expect(create()).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
    ticket = await actor(() => ctx.tickets.assign(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, ownerId: session.id, subject: 'One', role: 'observer' }))
    expect(ticket.assignments[0]!.contribution).toBe('advisory')
    await expect(actor(() => ctx.tickets.assign(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, ownerId: session.id, subject: 'Two' }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
    const other = await harness()
    const initial = await other.create()
    await expect(other.actor(() => other.ctx.tickets.create(other.session, { id: initial.id, subject: 'Duplicate', description: '' }))).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
    expect(() => other.ctx.tickets.get(other.session, TicketId('missing'))).toThrow('unknown Ticket')
  })

  it('bounds questions, attention, reports and report evidence without committing rejected writes', async () => {
    const { ctx, session, create, actor } = await harness({ maxQuestions: 1, maxAttentions: 1, maxReports: 1, maxWorkScopes: 1 })
    let ticket = await create()
    const request = () => ({ ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id })
    ticket = await actor(() => ctx.tickets.ask(session, { ...request(), question: 'Why?' }))
    await expect(actor(() => ctx.tickets.ask(session, { ...request(), question: 'Again?' }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
    ticket = await actor(() => ctx.tickets.attention(session, { ...request(), kind: 'review', message: 'Review' }))
    await expect(actor(() => ctx.tickets.attention(session, { ...request(), kind: 'review', message: 'Again' }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
    await expect(actor(() => ctx.tickets.assign(session, { ...request(), subject: 'Too broad', ownerId: session.id, workScopes: [{ path: 'one', access: 'read' }, { path: 'two', access: 'read' }] }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
    ticket = await actor(() => ctx.tickets.assign(session, { ...request(), subject: 'Build', ownerId: session.id }))
    const assignmentId = ticket.assignments[0]!.id
    await expect(actor(() => ctx.tickets.report(session, { ...request(), assignmentId, kind: 'progress', summary: 'Progress', evidence: ['one', 'two'] }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
    ticket = await actor(() => ctx.tickets.report(session, { ...request(), assignmentId, kind: 'progress', summary: 'Progress' }))
    await expect(actor(() => ctx.tickets.report(session, { ...request(), assignmentId, kind: 'progress', summary: 'More' }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
  })

  it('rejects missing ids, invalid revisions, and closed questions', async () => {
    const { ctx, session, create, actor } = await harness()
    let ticket = await create()
    const request = () => ({ ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id })
    await expect(actor(() => ctx.tickets.assign(session, { ...request(), expectedRevision: 0, subject: 'Build', ownerId: session.id }))).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
    await expect(actor(() => ctx.tickets.claim(session, { ...request(), assignmentId: AssignmentId('missing') }))).rejects.toMatchObject({ code: 'TICKET_ASSIGNMENT_NOT_FOUND' })
    await expect(actor(() => ctx.tickets.answer(session, { ...request(), questionId: TicketQuestionId('missing'), answer: 'No' }))).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
    await expect(actor(() => ctx.tickets.resolveAttention(session, { ...request(), attentionId: TicketAttentionId('missing') }))).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
    await expect(actor(() => ctx.tickets.handoff(session, { ...request(), newCoordinatorId: SessionId('missing') }))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
    ticket = await actor(() => ctx.tickets.ask(session, { ...request(), question: 'Why?' }))
    const questionId = ticket.questions[0]!.id
    ticket = await actor(() => ctx.tickets.closeQuestion(session, { ...request(), questionId }))
    await expect(actor(() => ctx.tickets.closeQuestion(session, { ...request(), questionId }))).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
    await expect(actor(() => ctx.tickets.complete(session, { ...request(), summary: 'Done' }))).rejects.toMatchObject({ code: 'TICKET_ACCEPTANCE' })
  })

  it('normalizes relative scope segments, including the workspace root', async () => {
    const { ctx, session, actor } = await harness()
    const ticket = await actor(() => ctx.tickets.create(session, { subject: 'Scopes', description: '', workScopes: [{ path: './src/..', access: 'write' }] }))
    expect(ticket.workScopes).toEqual([{ path: '.', access: 'write' }])
    const assigned = await actor(() => ctx.tickets.assign(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, ownerId: session.id, subject: 'Read', workScopes: [{ path: 'src//./file', access: 'read' }] }))
    expect(assigned.assignments[0]!.workScopes[0]!.path).toBe('src/file')
  })
})

it('versions Mission plans and derives acceptance progress from referenced Tickets', async () => {
  const { ctx, session, create, actor } = await harness({ maxTickets: 3 })
  let root = await create('Mission')
  const child = await create('Child')
  const other = await create('Other')
  const request = () => ({ ticketId: root.id, expectedRevision: root.revision, actorId: session.id })
  expect(() => ctx.tickets.mission(session, root.id, MissionId('missing'))).toThrow('unknown Mission')
  root = await actor(() => ctx.tickets.planMission(session, { ...request(), missionId: MissionId('one'), expectedPlanRevision: 0, title: 'Plan', milestones: [{ title: 'First', ticketIds: [child.id, other.id] }] }))
  root = await actor(() => ctx.tickets.planMission(session, { ...request(), missionId: MissionId('two'), expectedPlanRevision: 0, title: 'Other', milestones: [{ title: 'Other', ticketIds: [child.id] }] }))
  await expect(actor(() => ctx.tickets.planMission(session, { ...request(), missionId: MissionId('one'), expectedPlanRevision: 0, title: 'Stale', milestones: [] }))).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
  root = await actor(() => ctx.tickets.planMission(session, { ...request(), missionId: MissionId('one'), expectedPlanRevision: 1, title: 'Updated', milestones: [{ title: 'First', ticketIds: [child.id] }, { title: 'Second', ticketIds: [other.id] }] }))
  expect(ctx.tickets.mission(session, root.id, MissionId('one'))).toMatchObject({ completed: 0, total: 2, plan: { revision: 2, title: 'Updated' } })
  root = await actor(() => ctx.tickets.planMission(session, { ...request(), missionId: MissionId('three'), expectedPlanRevision: 0, title: 'Third', milestones: [] }))
  await expect(actor(() => ctx.tickets.planMission(session, { ...request(), missionId: MissionId('four'), expectedPlanRevision: 0, title: 'Fourth', milestones: [] }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
})

it('bounds candidate and criterion histories and rejects unknown criterion ids', async () => {
  const { ctx, session, create, actor } = await harness({ maxReports: 1 })
  let ticket = await create()
  const request = () => ({ ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id })
  ticket = await actor(() => ctx.tickets.assign(session, { ...request(), ownerId: session.id, subject: 'Build' }))
  ticket = await actor(() => ctx.tickets.revise(session, { ...request(), acceptanceCriteria: [{ id: TicketCriterionId('check'), description: 'Test', independent: false, required: true }], dependencies: [] }))
  ticket = await actor(() => ctx.tickets.report(session, { ...request(), assignmentId: ticket.assignments[0]!.id, kind: 'result', summary: 'Built' }))
  const candidate = () => ({ ...request(), candidateId: TicketCandidateId('candidate'), specRevision: ticket.specification.revision, assignmentIds: [ticket.assignments[0]!.id], content: { kind: 'commit' as const, repository: 'origin', commit: 'a'.repeat(40) } })
  await expect(actor(() => ctx.tickets.submitCandidate(session, { ...candidate(), specRevision: 1 }))).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
  ticket = await actor(() => ctx.tickets.submitCandidate(session, candidate()))
  await expect(actor(() => ctx.tickets.submitCandidate(session, { ...candidate(), candidateId: TicketCandidateId('second') }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
  const check = () => ({ ...request(), candidateId: ticket.currentCandidateId!, checkId: TicketCheckId('check'), criterionId: TicketCriterionId('check'), specRevision: ticket.specification.revision, outcome: 'pass' as const, evidence: ['tests'] })
  await expect(actor(() => ctx.tickets.checkCandidate(session, { ...check(), criterionId: TicketCriterionId('missing') }))).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  ticket = await actor(() => ctx.tickets.checkCandidate(session, check()))
  await expect(actor(() => ctx.tickets.checkCandidate(session, { ...check(), checkId: TicketCheckId('second') }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
})

it('refuses stale attempts, obsolete reports and exhausted attempt history', async () => {
  const { ctx, session, create, actor } = await harness({ maxReports: 1 })
  let ticket = await create()
  const request = () => ({ ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id })
  ticket = await actor(() => ctx.tickets.assign(session, { ...request(), ownerId: session.id, subject: 'Build' }))
  const assignmentId = ticket.assignments[0]!.id
  const begin = () => ({ ...request(), attemptId: TicketAttemptId('attempt'), operationId: TicketOperationId('begin'), assignmentId, workspace: { kind: 'isolated-worktree' as const, directory: '/workspace' }, executor: { kind: 'in-process' as const } })
  await expect(actor(() => ctx.tickets.beginAttempt(session, { ...begin(), assignmentRevision: 50 }))).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
  await expect(actor(() => ctx.tickets.updateAttempt(session, { ...request(), attemptId: TicketAttemptId('missing'), operationId: TicketOperationId('missing'), status: 'unknown' }))).rejects.toMatchObject({ code: 'TICKET_STALE_ATTEMPT' })
  ticket = await actor(() => ctx.tickets.beginAttempt(session, begin()))
  await expect(actor(() => ctx.tickets.claim(session, { ...request(), assignmentId }))).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  await expect(actor(() => ctx.tickets.beginAttempt(session, { ...begin(), operationId: TicketOperationId('duplicate') }))).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  await expect(actor(() => ctx.tickets.beginAttempt(session, { ...begin(), attemptId: TicketAttemptId('other'), operationId: TicketOperationId('other') }))).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  ticket = await actor(() => ctx.tickets.revise(session, { ...request(), dependencies: [], acceptanceCriteria: [] }))
  await expect(actor(() => ctx.tickets.report(session, { ...request(), assignmentId, attemptId: TicketAttemptId('attempt'), kind: 'result', summary: 'Old' }))).rejects.toMatchObject({ code: 'TICKET_STALE_ATTEMPT' })
  ticket = await actor(() => ctx.tickets.settleAttempt(session, { ...request(), attemptId: TicketAttemptId('attempt'), operationId: TicketOperationId('settle'), outcome: 'cancelled' }))
  await expect(actor(() => ctx.tickets.updateAttempt(session, { ...request(), attemptId: TicketAttemptId('attempt'), operationId: TicketOperationId('update'), status: 'unknown' }))).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  await expect(actor(() => ctx.tickets.beginAttempt(session, { ...begin(), attemptId: TicketAttemptId('new'), operationId: TicketOperationId('new') }))).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
})

it('continues legacy assignments without slots and refuses slots held by another worker', async () => {
  const { ctx, session, create, actor } = await harness()
  const current = await create()
  const { specification: _spec, attempts: _attempts, candidates: _candidates, checks: _checks,
    operations: _operations, missionPlans: _plans, ...legacy } = current
  const assignment = {
    id: AssignmentId('legacy-assignment'), revision: 1, role: 'worker' as const, subject: 'Old work', instructions: '',
    ownerId: session.id, status: 'assigned' as const, workScopes: [], attempts: 0,
  }
  session.append('ticket/state', { version: 1, sessionId: session.id, ticket: { ...legacy, id: TicketId('without-slot'), status: 'ready', assignments: [assignment] } })
  let ticket = ctx.tickets.get(session, TicketId('without-slot'))
  const request = () => ({ ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, assignmentId: assignment.id })
  ticket = await actor(() => ctx.tickets.claim(session, request()))
  expect(ticket.executionSlots).toEqual([])
  ticket = await actor(() => ctx.tickets.release(session, request()))
  expect(ticket.assignments[0]!.status).toBe('released')
  await expect(actor(() => ctx.tickets.release(session, request()))).rejects.toMatchObject({ code: 'TICKET_ASSIGNMENT_STATE' })
  const slotId = (await actor(() => ctx.tickets.assign(session, { ticketId: current.id, expectedRevision: current.revision, actorId: session.id, ownerId: session.id, subject: 'Slot' }))).executionSlots[0]!.id
  session.append('ticket/state', { version: 1, sessionId: session.id, ticket: {
    ...legacy, id: TicketId('held-slot'), status: 'ready', assignments: [{ ...assignment, executionSlotId: slotId }],
    executionSlots: [{ id: slotId, assignmentId: assignment.id, mode: 'shared-workspace', status: 'running', holderId: SessionId('other') }],
  } })
  ticket = ctx.tickets.get(session, TicketId('held-slot'))
  await expect(actor(() => ctx.tickets.claim(session, request()))).rejects.toMatchObject({ code: 'TICKET_ASSIGNMENT_STATE' })
})

it('refuses foreign reports and releases, unknown report attempts and stale CAS attempts', async () => {
  const { ctx, session, create, actor } = await harness()
  let ticket = await create()
  ticket = await actor(() => ctx.tickets.assign(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: session.id, ownerId: session.id, subject: 'Build' }))
  const request = { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: SessionId('foreign'), assignmentId: ticket.assignments[0]!.id }
  await expect(ticketActor(ctx, request.actorId, () => ctx.tickets.release(session, request))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(ticketActor(ctx, request.actorId, () => ctx.tickets.report(session, { ...request, kind: 'progress', summary: 'Progress' }))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(actor(() => ctx.tickets.report(session, { ...request, actorId: session.id, attemptId: TicketAttemptId('missing'), kind: 'progress', summary: 'Progress' }))).rejects.toMatchObject({ code: 'TICKET_STALE_ATTEMPT' })
  await expect(actor(() => ctx.tickets.beginAttempt(session, { ...request, actorId: session.id, expectedRevision: 1, attemptId: TicketAttemptId('attempt'), operationId: TicketOperationId('begin'), workspace: { kind: 'isolated-worktree', directory: '/workspace' }, executor: { kind: 'in-process' } }))).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
})

it('does not create Tickets in another technical owner Session', async () => {
  const { ctx, session, actor } = await harness()
  const other = ctx.sessions.create(SessionId('another-technical-owner'))
  await expect(actor(() => ctx.tickets.create(other, { subject: 'Wrong owner', description: '' }))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  expect(ctx.tickets.list(session)).toEqual([])
})
