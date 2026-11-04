import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TicketService, { AssignmentId, TicketCandidateId, TicketId, TicketReportId, ticketProjectionDefinition } from '../src/index.ts'
import type { TicketProjectionState } from '../src/projection.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TicketService)
  return { ctx, session: ctx.sessions.create(SessionId('ticket-root')) }
}

function project(session: Session): TicketProjectionState {
  let state = ticketProjectionDefinition.init(session.header)
  for (const event of session.snapshotEvents()) state = ticketProjectionDefinition.apply(state, event)
  return state
}

describe('Ticket service', () => {
  it('creates, assigns, claims, releases, reports, blocks, requests attention, hands off, and ends with CAS revisions', async () => {
    const { ctx, session } = await harness()
    const root = session.id
    const worker = SessionId('worker-a')
    const ticket = await ctx.tickets.create(session, {
      id: TicketId('ticket-1'),
      subject: 'Implement the change',
      description: 'A direct-worker responsibility',
      workScopes: [{ path: 'packages/experimental/ticket', access: 'write', exclusive: true }],
    })
    expect(ticket).toMatchObject({ id: 'ticket-1', revision: 1, status: 'proposed', coordinatorId: root })

    const assigned = await ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: root,
      ownerId: worker,
      subject: 'Build the domain',
      workScopes: [{ path: 'packages/experimental/ticket/src', access: 'write' }],
      executionMode: 'isolated-worktree',
    })
    expect(assigned).toMatchObject({ revision: 2, status: 'ready', assignments: [{ ownerId: worker, status: 'assigned' }] })
    const assignmentId = assigned.assignments[0]!.id

    const claimed = await ctx.tickets.claim(session, {
      ticketId: assigned.id,
      expectedRevision: 2,
      assignmentId,
      actorId: worker,
    })
    expect(claimed).toMatchObject({ revision: 3, status: 'executing', assignments: [{ status: 'running', attempts: 1 }], executionSlots: [{ status: 'running', holderId: worker }] })

    const released = await ctx.tickets.release(session, {
      ticketId: claimed.id,
      expectedRevision: 3,
      assignmentId,
      actorId: worker,
    })
    expect(released).toMatchObject({ revision: 4, status: 'ready', assignments: [{ ownerId: worker, status: 'released' }], executionSlots: [{ status: 'released' }] })

    const claimedAgain = await ctx.tickets.claim(session, {
      ticketId: released.id,
      expectedRevision: 4,
      assignmentId,
      actorId: worker,
    })
    const reported = await ctx.tickets.report(session, {
      ticketId: claimedAgain.id,
      expectedRevision: 5,
      assignmentId,
      actorId: worker,
      kind: 'result',
      summary: 'Worker finished',
      evidence: ['tests passed'],
      nextSteps: ['review'],
    })
    expect(reported).toMatchObject({ revision: 6, status: 'integrating', assignments: [{ status: 'completed', latestReportId: 'report-ticket-1-1' }] })

    const waiting = await ctx.tickets.attention(session, {
      ticketId: reported.id,
      expectedRevision: 6,
      actorId: root,
      kind: 'review',
      message: 'Coordinator review is required',
    })
    expect(waiting).toMatchObject({ revision: 7, status: 'waiting', attentions: [{ status: 'open', kind: 'review' }] })

    const handedOff = await ctx.tickets.handoff(session, {
      ticketId: waiting.id,
      expectedRevision: 7,
      actorId: root,
      newCoordinatorId: SessionId('reviewer'),
    })
    expect(handedOff).toMatchObject({ revision: 8, coordinatorId: 'reviewer' })

    const blocked = await ctx.tickets.block(session, {
      ticketId: handedOff.id,
      expectedRevision: 8,
      actorId: SessionId('reviewer'),
      reason: 'Waiting on a human decision',
    })
    expect(blocked).toMatchObject({ revision: 9, status: 'blocked' })

    let resolved = await ctx.tickets.resolveAttention(session, {
      ticketId: blocked.id,
      expectedRevision: 9,
      actorId: SessionId('reviewer'),
      attentionId: waiting.attentions[0]!.id,
    })
    resolved = await ctx.tickets.resolveAttention(session, {
      ticketId: resolved.id,
      expectedRevision: 10,
      actorId: SessionId('reviewer'),
      attentionId: blocked.attentions[blocked.attentions.length - 1]!.id,
    })
    expect(resolved).toMatchObject({ revision: 11, status: 'integrating' })
    expect(resolved.attentions.every(attention => attention.status === 'resolved')).toBe(true)

    const submitted = await ctx.tickets.submitCandidate(session, {
      ticketId: resolved.id,
      expectedRevision: 11,
      actorId: SessionId('reviewer'),
      candidateId: TicketCandidateId('candidate-1'),
      specRevision: resolved.specification.revision,
      content: { kind: 'commit', repository: 'origin', commit: 'b'.repeat(40) },
      assignmentIds: [assignmentId],
    })
    expect(submitted).toMatchObject({ revision: 12, currentCandidateId: 'candidate-1' })

    const completed = await ctx.tickets.complete(session, {
      ticketId: submitted.id,
      expectedRevision: 12,
      actorId: SessionId('reviewer'),
      summary: 'Accepted after review',
    })
    expect(completed).toMatchObject({ revision: 13, status: 'completed', terminalOutcome: { kind: 'completed' } })
    await expect(ctx.tickets.block(session, {
      ticketId: completed.id,
      expectedRevision: 13,
      actorId: SessionId('reviewer'),
      reason: 'too late',
    })).rejects.toMatchObject({ code: 'TICKET_TERMINAL' })
    await expect(ctx.tickets.handoff(session, {
      ticketId: completed.id,
      expectedRevision: 1,
      actorId: root,
      newCoordinatorId: worker,
    })).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })
  })

  it('recovers the same state from the Session event log and rejects stale concurrent writes', async () => {
    const { ctx, session } = await harness()
    const ticket = await ctx.tickets.create(session, { subject: 'Recovery', description: 'replay me' })
    const assigned = await ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: session.id,
      ownerId: SessionId('worker'),
      subject: 'Assignment',
    })
    await expect(ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: session.id,
      ownerId: SessionId('worker-2'),
      subject: 'Stale assignment',
    })).rejects.toMatchObject({ code: 'TICKET_STALE_REVISION' })

    const recovered = ctx.tickets.recover(session)
    expect(recovered).toEqual([assigned])
    const projected = project(session)
    expect(projected.failure).toBeUndefined()
    expect(projected.tickets).toEqual([assigned])
    const events = session.snapshotEvents().filter(event => event.type === 'ticket/state')
    expect(events).toHaveLength(2)
    expect(events.every(event => event.data.ticket !== undefined && event.data.ticket.revision > 0)).toBe(true)
  })

  it('keeps worker ownership across release and asks durable questions', async () => {
    const { ctx, session } = await harness()
    const worker = SessionId('worker')
    const ticket = await ctx.tickets.create(session, { subject: 'Question', description: 'ask' })
    const assigned = await ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: session.id,
      ownerId: worker,
      subject: 'Ask',
    })
    const asked = await ctx.tickets.ask(session, {
      ticketId: assigned.id,
      expectedRevision: 2,
      assignmentId: assigned.assignments[0]!.id,
      actorId: worker,
      question: 'Which API should I use?',
    })
    expect(asked).toMatchObject({ status: 'waiting', questions: [{ status: 'open', authorId: worker }] })
    const released = await ctx.tickets.release(session, {
      ticketId: asked.id,
      expectedRevision: 3,
      assignmentId: assigned.assignments[0]!.id,
      actorId: session.id,
    })
    expect(released.assignments[0]).toMatchObject({ ownerId: worker, status: 'released' })
  })
})

it('rejects a proposed-to-completed transition before appending', async () => {
  const { ctx, session } = await harness()
  const ticket = await ctx.tickets.create(session, { subject: 'Admission', description: '' })
  const events = session.snapshotEvents()
  await expect(ctx.tickets.complete(session, {
    ticketId: ticket.id,
    expectedRevision: 1,
    actorId: session.id,
    summary: 'Premature',
  })).rejects.toMatchObject({ code: 'TICKET_ACCEPTANCE' })
  expect(session.snapshotEvents()).toEqual(events)
  expect(project(session)).toMatchObject({ tickets: [ticket] })
})

it('keeps the last worker result replayable while an open question waits', async () => {
  const { ctx, session } = await harness()
  const worker = SessionId('worker')
  const ticket = await ctx.tickets.create(session, { subject: 'Waiting result', description: '' })
  const assigned = await ctx.tickets.assign(session, {
    ticketId: ticket.id,
    expectedRevision: 1,
    actorId: session.id,
    ownerId: worker,
    subject: 'Work',
  })
  const assignmentId = assigned.assignments[0]!.id
  await ctx.tickets.ask(session, { ticketId: ticket.id, expectedRevision: 2, actorId: worker, assignmentId, question: 'Accept?' })
  const result = await ctx.tickets.report(session, {
    ticketId: ticket.id,
    expectedRevision: 3,
    actorId: worker,
    assignmentId,
    kind: 'result',
    summary: 'Done',
  })
  expect(result.status).toBe('waiting')
  expect(project(session).failure).toBeUndefined()
  expect(project(session).tickets).toEqual([result])
})

it.each(['progress', 'result', 'failure'] as const)('rejects %s reports from a finished assignment without appending', async (kind) => {
  const { ctx, session } = await harness()
  const worker = SessionId('worker')
  const ticket = await ctx.tickets.create(session, { subject: 'Finished', description: '' })
  const assigned = await ctx.tickets.assign(session, {
    ticketId: ticket.id,
    expectedRevision: 1,
    actorId: session.id,
    ownerId: worker,
    subject: 'Work',
  })
  const assignmentId = assigned.assignments[0]!.id
  await ctx.tickets.report(session, {
    ticketId: ticket.id,
    expectedRevision: 2,
    actorId: worker,
    assignmentId,
    kind: 'result',
    summary: 'Done',
  })
  const events = session.snapshotEvents()
  await expect(ctx.tickets.report(session, {
    ticketId: ticket.id,
    expectedRevision: 3,
    actorId: worker,
    assignmentId,
    kind,
    summary: 'Late',
  })).rejects.toMatchObject({ code: 'TICKET_ASSIGNMENT_STATE' })
  expect(session.snapshotEvents()).toEqual(events)
})

it('answers and closes questions and resolves attention independently under coordinator authority', async () => {
  const { ctx, session } = await harness()
  const worker = SessionId('worker')
  const stranger = SessionId('stranger')
  let ticket = await ctx.tickets.create(session, { subject: 'Interventions', description: '' })
  ticket = await ctx.tickets.assign(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    ownerId: worker,
    subject: 'Work',
  })
  const assignmentId = ticket.assignments[0]!.id
  ticket = await ctx.tickets.ask(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: worker,
    assignmentId,
    question: 'Which API?',
  })
  const questionId = ticket.questions[0]!.id
  ticket = await ctx.tickets.block(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: worker,
    reason: 'Need access',
  })
  const attentionId = ticket.attentions[0]!.id
  const events = session.snapshotEvents()
  const request = { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: stranger }
  await expect(ctx.tickets.answer(session, { ...request, questionId, answer: 'No' })).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(ctx.tickets.closeQuestion(session, { ...request, questionId })).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(ctx.tickets.acknowledgeAttention(session, { ...request, attentionId })).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(ctx.tickets.resolveAttention(session, { ...request, attentionId })).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(ctx.tickets.block(session, { ...request, reason: 'No' })).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
  await expect(ctx.tickets.answer(session, {
    ...request,
    actorId: session.id,
    questionId,
    answer: ' ',
  })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(session.snapshotEvents()).toEqual(events)
  ticket = await ctx.tickets.claim(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: worker, assignmentId })
  expect(ticket.status).toBe('blocked')
  ticket = await ctx.tickets.report(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: worker,
    assignmentId,
    kind: 'progress',
    summary: 'Progress',
  })
  expect(ticket.status).toBe('blocked')
  ticket = await ctx.tickets.acknowledgeAttention(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    attentionId,
  })
  expect(ticket).toMatchObject({ status: 'blocked', attentions: [{ status: 'acknowledged' }] })
  ticket = await ctx.tickets.answer(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    questionId,
    answer: 'Use the public service',
  })
  expect(ticket.status).toBe('blocked')
  expect(ticket.questions[0]).toMatchObject({ status: 'answered', answer: 'Use the public service', answeredBy: session.id })
  ticket = await ctx.tickets.resolveAttention(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    attentionId,
  })
  expect(ticket).toMatchObject({ status: 'executing', attentions: [{ status: 'resolved' }] })
  expect(typeof ticket.attentions[0]!.resolvedAt).toBe('number')
  ticket = await ctx.tickets.closeQuestion(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: worker, questionId })
  expect(ticket.questions[0]).toMatchObject({ status: 'closed', answer: 'Use the public service' })
  const settled = session.snapshotEvents()
  await expect(ctx.tickets.answer(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    questionId,
    answer: 'Again',
  })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  await expect(ctx.tickets.resolveAttention(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    attentionId,
  })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(session.snapshotEvents()).toEqual(settled)
  expect(project(session).failure).toBeUndefined()
  expect(project(session).tickets).toEqual([ticket])
})

it('keeps waiting until every question and attention item is settled, then resumes integration', async () => {
  const { ctx, session } = await harness()
  const worker = SessionId('worker')
  let ticket = await ctx.tickets.create(session, { subject: 'Multiple blockers', description: '' })
  ticket = await ctx.tickets.assign(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    ownerId: worker,
    subject: 'Work',
  })
  const assignmentId = ticket.assignments[0]!.id
  ticket = await ctx.tickets.ask(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: worker,
    assignmentId,
    question: 'First?',
  })
  ticket = await ctx.tickets.ask(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: worker,
    assignmentId,
    question: 'Second?',
  })
  ticket = await ctx.tickets.attention(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: worker,
    kind: 'review',
    message: 'Review',
  })
  ticket = await ctx.tickets.report(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: worker,
    assignmentId,
    kind: 'result',
    summary: 'Done',
  })
  expect(ticket.status).toBe('waiting')
  for (const question of ticket.questions) {
    ticket = await ctx.tickets.closeQuestion(session, {
      ticketId: ticket.id,
      expectedRevision: ticket.revision,
      actorId: worker,
      questionId: question.id,
    })
    expect(ticket.status).toBe('waiting')
  }
  ticket = await ctx.tickets.resolveAttention(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    attentionId: ticket.attentions[0]!.id,
  })
  expect(ticket.status).toBe('integrating')
  expect(project(session).failure).toBeUndefined()
  expect(project(session).tickets).toEqual([ticket])
})

it('admits exactly one competing CAS command at an explicit barrier', async () => {
  const { ctx, session } = await harness()
  const ticket = await ctx.tickets.create(session, { subject: 'CAS', description: '' })
  const gate = Promise.withResolvers<undefined>()
  const contenders = ['one', 'two'].map(async (subject) => {
    await gate.promise
    return await ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: session.id,
      ownerId: SessionId(subject),
      subject,
    })
  })
  gate.resolve(undefined)
  const results = await Promise.allSettled(contenders)
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'TICKET_STALE_REVISION' } }])
  expect(session.snapshotEvents().filter(event => event.type === 'ticket/state')).toHaveLength(2)
  expect(project(session).failure).toBeUndefined()
})

it.each(['../outside', '/absolute', 'C:/drive', 'folder\\child'])('rejects invalid workspace scope %s without appending', async (path) => {
  const { ctx, session } = await harness()
  const events = session.snapshotEvents()
  await expect(ctx.tickets.create(session, {
    subject: 'Scope',
    description: '',
    workScopes: [{ path, access: 'write' }],
  })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(session.snapshotEvents()).toEqual(events)
})

it('normalizes relative scopes and rejects traversal and write escalation', async () => {
  const { ctx, session } = await harness()
  const ticket = await ctx.tickets.create(session, {
    subject: 'Scope',
    description: '',
    workScopes: [{ path: './src//nested/..',
      access: 'read',
      exclusive: true }],
  })
  expect(ticket.workScopes).toEqual([{ path: 'src', access: 'read', exclusive: true }])
  const request = { ticketId: ticket.id, expectedRevision: 1, actorId: session.id, ownerId: SessionId('worker'), subject: 'Work' }
  const events = session.snapshotEvents()
  await expect(ctx.tickets.assign(session, {
    ...request,
    workScopes: [{ path: 'src/child', access: 'write' }],
  })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  await expect(ctx.tickets.assign(session, {
    ...request,
    workScopes: [{ path: 'src/../outside', access: 'read' }],
  })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(session.snapshotEvents()).toEqual(events)
  const assigned = await ctx.tickets.assign(session, { ...request, workScopes: [{ path: 'src/./child/../file', access: 'read' }] })
  expect(assigned.assignments[0]!.workScopes).toEqual([{ path: 'src/file', access: 'read' }])
  expect(project(session).tickets).toEqual([assigned])
})

it('rejects schema failures without poisoning later valid commands', async () => {
  const { ctx, session } = await harness()
  const before = session.snapshotEvents()
  await expect(ctx.tickets.create(session, {
    id: TicketId(''),
    subject: 'Invalid identity',
    description: '',
  })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(session.snapshotEvents()).toEqual(before)
  const ticket = await ctx.tickets.create(session, { subject: 'Valid', description: '' })
  const created = session.snapshotEvents()
  await expect(ctx.tickets.assign(session, {
    ticketId: ticket.id,
    expectedRevision: 1,
    actorId: session.id,
    ownerId: SessionId(''),
    subject: 'Invalid owner',
  })).rejects.toMatchObject({ code: 'TICKET_INVALID_INPUT' })
  expect(session.snapshotEvents()).toEqual(created)
  expect(ctx.tickets.get(session, ticket.id)).toEqual(ticket)
  expect(project(session).failure).toBeUndefined()
})

it('rejects reports after a failure or release without changing the log', async () => {
  const { ctx, session } = await harness()
  const worker = SessionId('worker')
  for (const state of ['failed', 'released'] as const) {
    let ticket = await ctx.tickets.create(session, { subject: state, description: '' })
    ticket = await ctx.tickets.assign(session, {
      ticketId: ticket.id,
      expectedRevision: 1,
      actorId: session.id,
      ownerId: worker,
      subject: 'Work',
    })
    const assignmentId = ticket.assignments[0]!.id
    if (state === 'failed') ticket = await ctx.tickets.report(session, {
      ticketId: ticket.id,
      expectedRevision: ticket.revision,
      actorId: worker,
      assignmentId,
      kind: 'failure',
      summary: 'Failed',
    })
    else ticket = await ctx.tickets.release(session, {
      ticketId: ticket.id,
      expectedRevision: ticket.revision,
      actorId: worker,
      assignmentId,
    })
    const events = session.snapshotEvents()
    await expect(ctx.tickets.report(session, {
      ticketId: ticket.id,
      expectedRevision: ticket.revision,
      actorId: worker,
      assignmentId,
      kind: 'progress',
      summary: 'Late',
    })).rejects.toMatchObject({ code: 'TICKET_ASSIGNMENT_STATE' })
    expect(session.snapshotEvents()).toEqual(events)
  }
  expect(project(session).failure).toBeUndefined()
})

it('keeps another assignment claim and release replayable during integration', async () => {
  const { ctx, session } = await harness()
  const worker = SessionId('worker')
  let ticket = await ctx.tickets.create(session, { subject: 'Another assignment', description: '' })
  ticket = await ctx.tickets.assign(session, {
    ticketId: ticket.id,
    expectedRevision: 1,
    actorId: session.id,
    ownerId: worker,
    subject: 'First',
  })
  ticket = await ctx.tickets.report(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: worker,
    assignmentId: ticket.assignments[0]!.id,
    kind: 'result',
    summary: 'Done',
  })
  ticket = await ctx.tickets.assign(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    ownerId: worker,
    subject: 'Second',
  })
  const assignmentId = ticket.assignments[1]!.id
  ticket = await ctx.tickets.claim(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: worker, assignmentId })
  expect(ticket.status).toBe('executing')
  ticket = await ctx.tickets.release(session, { ticketId: ticket.id, expectedRevision: ticket.revision, actorId: worker, assignmentId })
  expect(ticket.status).toBe('ready')
  expect(project(session).failure).toBeUndefined()
  expect(project(session).tickets).toEqual([ticket])
})

it('keeps an attention limit failure atomic instead of losing the block reason', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TicketService, { maxAttentions: 1 })
  const session = ctx.sessions.create(SessionId('attention-bound'))
  let ticket = await ctx.tickets.create(session, { subject: 'Bound', description: '' })
  ticket = await ctx.tickets.attention(session, {
    ticketId: ticket.id,
    expectedRevision: 1,
    actorId: session.id,
    kind: 'review',
    message: 'Review',
  })
  const events = session.snapshotEvents()
  await expect(ctx.tickets.block(session, {
    ticketId: ticket.id,
    expectedRevision: ticket.revision,
    actorId: session.id,
    reason: 'Must retain',
  })).rejects.toMatchObject({ code: 'TICKET_LIMIT' })
  expect(session.snapshotEvents()).toEqual(events)
  expect(ctx.tickets.get(session, ticket.id)).toEqual(ticket)
})

it('reads existing v1 repeated-result history while rejecting new late reports', async () => {
  const { ctx, session } = await harness()
  const worker = SessionId('worker')
  const assignmentId = AssignmentId('assignment-1')
  const reportId = TicketReportId('report-1')
  const repeatedId = TicketReportId('historical-repeat')
  const at = Date.now()
  const base = {
    id: TicketId('v1-ticket'), revision: 1, subject: 'Existing v1', description: '',
    status: 'executing' as const, coordinatorId: session.id,
    assignments: [{
      id: assignmentId, revision: 1, role: 'worker' as const, subject: 'Work', instructions: '',
      ownerId: worker, status: 'completed' as const, workScopes: [], attempts: 1, latestReportId: reportId,
    }],
    reports: [{
      id: reportId, assignmentId, authorId: worker, kind: 'result' as const,
      summary: 'Done', evidence: [], nextSteps: [], createdAt: at,
    }],
    questions: [], attentions: [], workScopes: [], executionSlots: [], createdAt: at, updatedAt: at,
  }
  session.append('ticket/state', { version: 1, sessionId: session.id, ticket: base })
  const historical = {
    ...base, revision: 2, updatedAt: at + 1,
    assignments: base.assignments.map(assignment => ({ ...assignment, revision: 2, latestReportId: repeatedId })),
    reports: [...base.reports, { ...base.reports[0]!, id: repeatedId, summary: 'Repeated result', createdAt: at + 1 }],
  }
  session.append('ticket/state', { version: 1, sessionId: session.id, ticket: historical })
  expect(project(session).failure).toBeUndefined()
  expect(ctx.tickets.get(session, base.id)).toMatchObject(historical)
  const events = session.snapshotEvents()
  await expect(ctx.tickets.report(session, {
    ticketId: base.id,
    expectedRevision: historical.revision,
    actorId: worker,
    assignmentId,
    kind: 'progress',
    summary: 'Late',
  })).rejects.toMatchObject({ code: 'TICKET_ASSIGNMENT_STATE' })
  expect(session.snapshotEvents()).toEqual(events)
})
