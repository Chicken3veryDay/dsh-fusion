import { describe, expect, it, vi } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs'
import {
  AssignmentId, ExecutionSlotId, MissionId, TicketAttemptId, TicketAttentionId,
  TicketCandidateId, TicketCheckId, TicketCriterionId, TicketId, TicketOperationId,
  TicketQuestionId, TicketReportId,
} from '../src/types.ts'
import type { AssignmentSnapshot, TicketAttemptFacts, TicketAttemptSnapshot, TicketSnapshot } from '../src/types.ts'
import { assertTicketAcceptance, validateCurrentTicketChange, validateTicketReferences } from '../src/validation.ts'
import { emptyTicketState, ticketProjectionDefinition, ticketSnapshotSchema } from '../src/projection.ts'

const owner = SessionId('owner')
const assignment: AssignmentSnapshot = {
  id: AssignmentId('assignment'), revision: 1, role: 'worker', subject: 'Build', instructions: '',
  ownerId: owner, status: 'assigned', workScopes: [], attempts: 1, contribution: 'required',
}
const attempt: TicketAttemptSnapshot = {
  id: TicketAttemptId('attempt'), assignmentId: assignment.id, assignmentRevision: 1, specRevision: 1,
  workspace: { kind: 'shared-workspace', directory: '/workspace' }, executor: { kind: 'in-process' },
  diagnostics: [], createdAt: 1, updatedAt: 1, status: 'settled', outcome: 'succeeded',
}
const report = {
  id: TicketReportId('report'), assignmentId: assignment.id, authorId: owner, kind: 'result',
  summary: 'Built', evidence: [], nextSteps: [], createdAt: 1, specRevision: 1, attemptId: attempt.id,
} as const
const candidate = {
  id: TicketCandidateId('candidate'), specRevision: 1,
  content: { kind: 'commit', repository: 'origin', commit: 'a'.repeat(40) },
  assignmentIds: [assignment.id], reportIds: [report.id], authorId: owner, createdAt: 1,
} as const
const criterion = { id: TicketCriterionId('criterion'), description: 'Pass', required: true, independent: true }
const check = {
  id: TicketCheckId('check'), candidateId: candidate.id, criterionId: criterion.id,
  specRevision: 1, authorId: SessionId('reviewer'), outcome: 'pass', evidence: ['tests'], createdAt: 1,
} as const
function ticket(patch: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    id: TicketId('ticket'), revision: 1, subject: 'Ticket', description: '', status: 'proposed', coordinatorId: owner,
    assignments: [], reports: [], questions: [], attentions: [], workScopes: [], executionSlots: [],
    createdAt: 1, updatedAt: 1, specification: { revision: 1, dependencies: [], acceptanceCriteria: [] },
    attempts: [], candidates: [], checks: [], operations: [], missionPlans: [], ...patch,
  }
}
function accepted(patch: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return ticket({ status: 'integrating', assignments: [{ ...assignment, status: 'completed', latestReportId: report.id, activeAttemptId: attempt.id }],
    attempts: [attempt], reports: [report], candidates: [candidate], currentCandidateId: candidate.id,
    checks: [check], specification: { revision: 1, dependencies: [], acceptanceCriteria: [criterion] }, ...patch })
}
function successor(previous: TicketSnapshot, patch: Partial<TicketSnapshot>): TicketSnapshot {
  return { ...previous, revision: previous.revision + 1, ...patch }
}
function invalid(previous: TicketSnapshot | undefined, next: TicketSnapshot, message: string): void {
  expect(() =>{  validateCurrentTicketChange(previous, next) }).toThrow(message)
}

describe('durable Ticket validation', () => {
  it.each([
    ['revision', ticket({ revision: 2 })],
    ['specification revision', ticket({ specification: { revision: 2, dependencies: [], acceptanceCriteria: [] } })],
    ['initial status', ticket({ status: 'ready' })],
  ])('rejects invalid initial %s', (_label, next) =>{  invalid(undefined, next, 'Tickets begin proposed') })

  it('rejects terminal edits, revision gaps, identity changes and illegal transitions', () => {
    const initial = ticket()
    invalid(ticket({ terminalOutcome: { kind: 'failed', summary: 'Failed', actorId: owner, at: 1 } }), ticket(), 'terminal Ticket history')
    invalid(initial, ticket({ revision: 3 }), 'contiguous')
    for (const patch of [{ createdAt: 2 }, { subject: 'Other' }, { description: 'Other' }]) {
      invalid(initial, successor(initial, patch), 'identity fields')
    }
    invalid(initial, successor(initial, { status: 'completed' }), 'transition')
    invalid(initial, successor(initial, { specification: { ...initial.specification, dependencies: [TicketId('other')] } }), 'specification revision')
  })

  it.each(['reports', 'candidates', 'checks'] as const)('retains immutable %s history', (field) => {
    const previous = accepted()
    invalid(previous, successor(previous, { [field]: [] }), 'history cannot be replaced')
  })

  it('preserves Assignment responsibility and attempt identity', () => {
    const previous = accepted()
    invalid(previous, successor(previous, { assignments: [] }), 'history cannot be removed')
    invalid(previous, successor(previous, { attempts: [] }), 'history cannot be removed')
    invalid(previous, successor(previous, { assignments: [{ ...assignment, id: AssignmentId('other') }] }), 'Assignment identity')
    for (const patch of [
      { ownerId: SessionId('other') }, { contribution: 'advisory' as const }, { role: 'reviewer' as const },
      { subject: 'Other' }, { instructions: 'Other' }, { workScopes: [{ path: 'src', access: 'read' as const }] },
      { executionSlotId: ExecutionSlotId('other') },
    ]) invalid(previous, successor(previous, { assignments: [{ ...previous.assignments[0]!, ...patch }] }), 'Assignment identity')
    invalid(previous, successor(previous, { attempts: [{ ...attempt, id: TicketAttemptId('other') }] }), 'attempt history cannot be removed')
    invalid(previous, successor(previous, { attempts: [{ ...attempt, updatedAt: 2 }] }), 'settled attempt history')
    const running = ticket({ assignments: [{ ...assignment, activeAttemptId: attempt.id }], attempts: [{ ...attempt, status: 'running' }] })
    for (const patch of [
      { assignmentId: AssignmentId('other') }, { assignmentRevision: 2 }, { specRevision: 2 }, { createdAt: 2 },
      { workspace: { ...attempt.workspace, directory: '/other' } }, { executor: { kind: 'dedicated-process' as const, provider: 'other' } },
      { modelSelection: { provider: 'model', model: 'name', settings: '{}' } },
    ]) invalid(running, successor(running, { attempts: [{ ...running.attempts[0]!, ...patch }] }), 'selection and identity')
  })

  it('retains receipts and append-only job identities', () => {
    const runtimeReceipt = { runtimeId: 'runtime', providerId: 'provider', jobIds: [JobId('first')] }
    const workspaceReceipt = { directory: '/workspace', baseCommit: 'a'.repeat(40) }
    const previous = ticket({ assignments: [{ ...assignment, activeAttemptId: attempt.id }],
      attempts: [{ ...attempt, status: 'running', workspaceReceipt, runtimeReceipt }] })
    const update = (patch: Partial<TicketAttemptFacts>) => successor(previous, { attempts: [{ ...previous.attempts[0]!, ...patch }] })
    invalid(previous, update({ workspaceReceipt: { ...workspaceReceipt, directory: '/other' } }), 'workspace receipt')
    const { runtimeReceipt: _runtime, ...withoutRuntime } = previous.attempts[0]!
    invalid(previous, successor(previous, { attempts: [withoutRuntime] }), 'runtime identity')
    invalid(previous, update({ runtimeReceipt: { ...runtimeReceipt, runtimeId: 'other' } }), 'runtime identity')
    invalid(previous, update({ runtimeReceipt: { ...runtimeReceipt, jobIds: [] } }), 'runtime job history')
    invalid(previous, update({ runtimeReceipt: { ...runtimeReceipt, jobIds: [JobId('first'), JobId('first')] } }), 'runtime job identities')
    expect(() =>{  validateCurrentTicketChange(previous, update({ runtimeReceipt: { ...runtimeReceipt, jobIds: [JobId('first'), JobId('second')] } })) }).not.toThrow()
    const noJobs = { ...previous, attempts: [{ ...previous.attempts[0]!, runtimeReceipt: { runtimeId: 'runtime', providerId: 'provider' } }] }
    expect(() =>{  validateCurrentTicketChange(noJobs, successor(noJobs, {})) }).not.toThrow()
    for (const status of ['stopping', 'unknown'] as const) {
      const uncertain = { ...previous, attempts: [{ ...previous.attempts[0]!, status }] }
      invalid(uncertain, successor(uncertain, { attempts: [{ ...uncertain.attempts[0]!, status: 'running' }] }), 'cannot resume running')
    }
  })

  it('checks Mission revisions and unique record identities', () => {
    const plan = { id: MissionId('mission'), revision: 1, title: 'Mission', milestones: [{ title: 'One', ticketIds: [TicketId('ticket')] }] }
    const previous = ticket({ missionPlans: [plan] })
    invalid(previous, successor(previous, { missionPlans: [] }), 'Mission plan revision')
    invalid(previous, successor(previous, { missionPlans: [{ ...plan, title: 'Changed' }] }), 'Mission plan revision')
    expect(() =>{  validateCurrentTicketChange(previous, successor(previous, { missionPlans: [{ ...plan, revision: 2, title: 'Changed' }] })) }).not.toThrow()
    expect(() =>{  validateCurrentTicketChange(previous, successor(previous, {})) }).not.toThrow()
    const values = {
      assignments: [assignment, assignment], attempts: [attempt, attempt], reports: [report, report],
      candidates: [candidate, candidate], checks: [check, check], missionPlans: [plan, plan],
      operations: [{ id: TicketOperationId('op'), request: '{}' }, { id: TicketOperationId('op'), request: '{}' }],
      questions: [1, 2].map(() => ({ id: TicketQuestionId('question'), authorId: owner, question: 'Why?', status: 'open' as const, createdAt: 1 })),
      attentions: [1, 2].map(() => ({ id: TicketAttentionId('attention'), kind: 'review' as const, message: 'Review', status: 'open' as const, createdAt: 1 })),
      executionSlots: [1, 2].map(() => ({ id: ExecutionSlotId('slot'), assignmentId: assignment.id, mode: 'shared-workspace' as const, status: 'reserved' as const })),
    }
    for (const [field, records] of Object.entries(values)) invalid(undefined, ticket({ [field]: records }), 'identities must be unique')
    invalid(undefined, ticket({ specification: { revision: 1, dependencies: [], acceptanceCriteria: [criterion, criterion] } }), 'criterion identities')
  })

  it('rejects dangling attempts, operations and retired request fingerprints', () => {
    const operation = { id: TicketOperationId('op'), request: '{}', attemptId: attempt.id }
    invalid(undefined, ticket({ operations: [operation] }), 'unknown attempt')
    invalid(undefined, ticket({ operations: [{ id: operation.id, request: operation.request, retiredIds: [] }] }), 'settled attempt')
    invalid(undefined, ticket({ operations: [{ id: operation.id, request: '{}', retiredRequests: ['old'] }] }), 'fingerprints')
    invalid(undefined, ticket({ operations: [{ id: operation.id, request: '{}', retiredIds: [operation.id] }] }), 'identities must be unique')
    invalid(undefined, ticket({ attempts: [attempt] }), 'unknown Assignment')
    invalid(undefined, ticket({ assignments: [assignment], attempts: [{ ...attempt, status: 'running' }] }), 'must be active')
    invalid(undefined, ticket({ assignments: [assignment], attempts: [{ ...attempt, specRevision: 2 }] }), 'future specification')
    invalid(undefined, ticket({ assignments: [assignment], attempts: [{ ...attempt, executor: { kind: 'remote', provider: 'remote', world: 'one' }, runtimeReceipt: { runtimeId: 'runtime', providerId: 'remote', world: 'two' } }] }), 'remote execution world')
    invalid(undefined, ticket({ assignments: [{ ...assignment, activeAttemptId: attempt.id }] }), 'active attempt is missing')
  })

  it('rejects invalid candidate and check references', () => {
    invalid(undefined, ticket({ candidates: [candidate] }), 'current result reports')
    for (const changed of [{ ...report, assignmentId: AssignmentId('other') }, { ...report, specRevision: 2 }, { ...report, kind: 'progress' as const }]) {
      invalid(undefined, ticket({ assignments: [assignment], candidates: [candidate], reports: [changed] }), 'current result reports')
    }
    invalid(undefined, ticket({ candidates: [{ ...candidate, reportIds: [] }] }), 'unknown Assignment')
    invalid(undefined, ticket({ currentCandidateId: candidate.id }), 'current candidate')
    invalid(undefined, ticket({ checks: [check] }), 'unknown candidate')
    invalid(undefined, ticket({ assignments: [assignment], candidates: [{ ...candidate, reportIds: [] }], checks: [{ ...check, specRevision: 2 }] }), 'unknown candidate')
    invalid(undefined, ticket({ assignments: [assignment], candidates: [{ ...candidate, reportIds: [] }], checks: [check] }), 'unknown current criterion')
    invalid(undefined, ticket({ assignments: [assignment], reports: [report], candidates: [candidate], checks: [{ ...check, authorId: owner }], specification: { revision: 1, dependencies: [], acceptanceCriteria: [criterion] } }), 'independent check author')
    invalid(undefined, ticket({ terminalOutcome: { kind: 'failed', actorId: owner, summary: 'Failed', at: 1 } }), 'status and outcome')
    const previous = ticket({ status: 'ready', assignments: [{ ...assignment, activeAttemptId: attempt.id }], attempts: [{ ...attempt, status: 'running' }] })
    invalid(previous, successor(previous, { status: 'failed', terminalOutcome: { kind: 'failed', actorId: owner, summary: 'Failed', at: 1 } }), 'must settle before')
  })

  it('requires complete operation retirement at settlement', () => {
    const operation = { id: TicketOperationId('old'), request: '{}', attemptId: attempt.id }
    const previous = ticket({ assignments: [{ ...assignment, activeAttemptId: attempt.id }], attempts: [{ ...attempt, status: 'running' }], operations: [operation] })
    invalid(previous, successor(previous, { operations: [] }), 'settled attempt tombstone')
    const tombstone = { id: TicketOperationId('settled'), request: '{}', attemptId: attempt.id, retiredIds: [operation.id], retiredRequests: ['{}'] }
    invalid(previous, successor(previous, { operations: [tombstone] }), 'settled attempt tombstone')
    const settled = successor(previous, { attempts: [attempt], operations: [tombstone] })
    expect(() =>{  validateCurrentTicketChange(previous, settled) }).not.toThrow()
    const unowned = { ...previous, operations: [{ id: operation.id, request: operation.request }] }
    invalid(unowned, settled, 'settled attempt tombstone')
    const alreadySettled = { ...previous, attempts: [attempt] }
    invalid(alreadySettled, successor(alreadySettled, { operations: [tombstone] }), 'settled attempt tombstone')
    const retired = { ...previous, operations: [{ ...operation, retiredIds: [TicketOperationId('earlier')] }] }
    invalid(retired, settled, 'settled attempt tombstone')
    const carried = { ...tombstone, retiredIds: [operation.id, TicketOperationId('earlier')], retiredRequests: ['{}', '{}'] }
    expect(() =>{  validateCurrentTicketChange(retired, { ...settled, operations: [carried] }) }).not.toThrow()
  })
})

describe('Ticket reference validation', () => {
  it('rejects duplicate, unknown and cyclic dependency and parent references', () => {
    expect(() =>{  validateTicketReferences([ticket({ specification: { revision: 1, acceptanceCriteria: [], dependencies: [TicketId('missing')] } })]) }).toThrow('unknown dependency')
    expect(() =>{  validateTicketReferences([ticket({ specification: { revision: 1, acceptanceCriteria: [], dependencies: [TicketId('ticket'), TicketId('ticket')] } })]) }).toThrow('identities must be unique')
    expect(() =>{  validateTicketReferences([ticket({ specification: { revision: 1, acceptanceCriteria: [], dependencies: [TicketId('ticket')] } })]) }).toThrow('cycle')
    const child = ticket({ id: TicketId('child'), specification: { revision: 1, acceptanceCriteria: [], dependencies: [], parent: { ticketId: TicketId('ticket'), required: true } } })
    expect(() =>{  validateTicketReferences([child]) }).toThrow('unknown parent')
    expect(() =>{  validateTicketReferences([ticket({ terminalOutcome: { kind: 'completed', actorId: owner, summary: 'Done', at: 1 } }), child]) }).toThrow('unfinished required children')
    expect(() =>{  validateTicketReferences([ticket(), child]) }).not.toThrow()
    expect(() =>{  validateTicketReferences([ticket(), { ...child, terminalOutcome: { kind: 'completed', actorId: owner, summary: 'Done', at: 1 } }]) }).not.toThrow()
    const plan = { id: MissionId('mission'), revision: 1, title: 'Plan', milestones: [{ title: 'One', ticketIds: [TicketId('missing')] }] }
    expect(() =>{  validateTicketReferences([ticket({ missionPlans: [plan] })]) }).toThrow('unknown Mission Ticket')
    expect(() =>{  validateTicketReferences([ticket({ missionPlans: [{ ...plan, milestones: [{ title: 'One', ticketIds: [TicketId('ticket'), TicketId('ticket')] }] }] })]) }).toThrow('identities must be unique')
  })
})

describe('Ticket acceptance validation', () => {
  it('accepts current successful work and rejects every unsettled obligation', () => {
    expect(() =>{  assertTicketAcceptance(accepted(), [accepted()]) }).not.toThrow()
    const patches: [Partial<TicketSnapshot>, string][] = [
      [{ attempts: [{ ...attempt, status: 'running' }] }, 'execution attempts'],
      [{ questions: [{ id: TicketQuestionId('question'), authorId: owner, question: 'Why?', status: 'open', createdAt: 1 }] }, 'open questions'],
      [{ attentions: [{ id: TicketAttentionId('attention'), kind: 'review', message: 'Review', status: 'acknowledged', createdAt: 1 }] }, 'unresolved attention'],
      [{ candidates: [] }, 'submit a candidate'],
      [{ candidates: [{ ...candidate, specRevision: 2 }] }, 'submit a candidate'],
      [{ candidates: [{ ...candidate, assignmentIds: [] }] }, 'candidate lacks'],
      [{ reports: [] }, 'current contribution'],
      [{ assignments: [{ ...assignment, status: 'completed', latestReportId: report.id, activeAttemptId: TicketAttemptId('missing') }] }, 'settled successful'],
      [{ attempts: [{ ...attempt, outcome: 'failed' }] }, 'settled successful'],
      [{ reports: [{ ...report, attemptId: TicketAttemptId('other') }] }, 'settled successful'],
      [{ attempts: [{ ...attempt, specRevision: 2 }] }, 'settled successful'],
      [{ checks: [] }, 'passing current check'],
      [{ checks: [{ ...check, authorId: owner }] }, 'independent author'],
      [{ specification: { revision: 1, dependencies: [TicketId('missing')], acceptanceCriteria: [] } }, 'not accepted'],
    ]
    for (const [patch, message] of patches) expect(() =>{  assertTicketAcceptance(accepted(patch), [accepted(patch)]) }).toThrow(message)
    const child = ticket({ id: TicketId('child'), specification: { revision: 1, dependencies: [], acceptanceCriteria: [], parent: { ticketId: TicketId('ticket'), required: true } } })
    expect(() =>{  assertTicketAcceptance(accepted(), [accepted(), child]) }).toThrow('required child')
    expect(() =>{  assertTicketAcceptance(accepted(), [accepted(), { ...child, terminalOutcome: { kind: 'completed', actorId: owner, summary: 'Done', at: 1 } }]) }).not.toThrow()
    const dependency = ticket({ id: TicketId('dependency'), terminalOutcome: { kind: 'completed', actorId: owner, summary: 'Done', at: 1 } })
    const dependent = accepted({ specification: { revision: 1, dependencies: [dependency.id], acceptanceCriteria: [] } })
    expect(() =>{  assertTicketAcceptance(dependent, [dependent, dependency]) }).not.toThrow()
  })

  it('fails closed when invalid durable records are replayed', () => {
    const initial = ticket()
    const event = { type: 'ticket/state', data: { version: 2, sessionId: owner, ticket: initial }, seq: SessionSeq(1), time: 1 } as const
    const state = ticketProjectionDefinition.apply(emptyTicketState(owner), event)
    expect(state.failure).toBeUndefined()
    const broken = successor(initial, { attempts: [attempt] })
    const replay = ticketProjectionDefinition.apply(state, { ...event, data: { ...event.data, ticket: broken }, seq: SessionSeq(2) })
    expect(replay.failure).toContain('unknown Assignment')
    expect(replay.tickets).toEqual([initial])
    expect(ticketSnapshotSchema.safeParse(accepted()).success).toBe(true)
  })
})

describe('historical Ticket replay', () => {
  function legacy(value = ticket()): import('../src/types.ts').TicketSnapshotV1 {
    return {
      id: value.id, revision: value.revision, subject: value.subject, description: value.description,
      status: value.status, coordinatorId: value.coordinatorId,
      assignments: value.assignments.map(({ contribution: _contribution, activeAttemptId: _active, ...item }) => item),
      reports: value.reports.map(({ specRevision: _spec, attemptId: _attempt, ...item }) => item), questions: value.questions,
      attentions: value.attentions, workScopes: value.workScopes, executionSlots: value.executionSlots,
      createdAt: value.createdAt, updatedAt: value.updatedAt,
    }
  }
  function replay(values: readonly import('../src/types.ts').TicketSnapshotV1[]) {
    return values.reduce((state, value, index) => ticketProjectionDefinition.apply(state, {
      type: 'ticket/state', seq: SessionSeq(index + 1), time: 1, data: { version: 1, sessionId: owner, ticket: value },
    }), emptyTicketState(owner))
  }
  it('upgrades observer and worker contributions and historical reports', () => {
    const value = legacy(ticket({ assignments: [assignment, { ...assignment, id: AssignmentId('observer'), role: 'observer' }], reports: [report],
      questions: [{ id: TicketQuestionId('question'), authorId: owner, question: 'Why?', status: 'open', createdAt: 1 }],
      attentions: [{ id: TicketAttentionId('attention'), kind: 'review', message: 'Review', status: 'open', createdAt: 1 }],
    }))
    const state = replay([value])
    expect(state.failure).toBeUndefined()
    expect(state.tickets[0]!.assignments.map(item => item.contribution)).toEqual(['required', 'advisory'])
    expect(state.tickets[0]!.reports[0]!.specRevision).toBe(1)
  })
  it('rejects bad initial and successor revisions and immutable identity changes', () => {
    const initial = legacy()
    expect(replay([{ ...initial, revision: 2 }]).failure).toContain('begin at revision 1')
    expect(replay([initial, { ...initial, revision: 3 }]).failure).toContain('not contiguous')
    for (const patch of [{ createdAt: 2 }, { subject: 'Other' }, { description: 'Other' }]) {
      expect(replay([initial, { ...initial, revision: 2, ...patch }]).failure).toContain('immutable identity')
    }
    expect(replay([initial, { ...initial, revision: 2, status: 'completed' }]).failure).toContain('invalid proposed -> completed')
    const duplicate = legacy(ticket({ assignments: [assignment, assignment] }))
    expect(replay([duplicate]).failure).toContain('ids are duplicated')
  })
  it('rejects a downgrade and skips other Sessions and events after a failure', () => {
    const initial = ticket()
    const current = ticketProjectionDefinition.apply(emptyTicketState(owner), {
      type: 'ticket/state', seq: SessionSeq(1), time: 1, data: { version: 2, sessionId: owner, ticket: initial },
    })
    const downgrade = ticketProjectionDefinition.apply(current, {
      type: 'ticket/state', seq: SessionSeq(2), time: 1, data: { version: 1, sessionId: owner, ticket: legacy({ ...initial, revision: 2 }) },
    })
    expect(downgrade.failure).toContain('cannot downgrade')
    const other = { type: 'ticket/state', seq: SessionSeq(2), time: 1, data: { version: 1, sessionId: SessionId('other'), ticket: legacy() } } as const
    expect(ticketProjectionDefinition.apply(current, other)).toBe(current)
    expect(ticketProjectionDefinition.apply(downgrade, other)).toBe(downgrade)
    expect(ticketProjectionDefinition.wire.view(downgrade)).toEqual({ tickets: downgrade.tickets, failure: downgrade.failure })
  })
  it('decodes retired operations and keeps unrelated criterion checks independent of acceptance', () => {
    const value = ticket({ assignments: [assignment], attempts: [attempt], operations: [{ id: TicketOperationId('settled'), request: '{}', attemptId: attempt.id, retiredIds: [TicketOperationId('old')], retiredRequests: ['{}'] }] })
    expect(ticketSnapshotSchema.parse(value)).toEqual(value)
    const different = { ...check, criterionId: TicketCriterionId('different'), id: TicketCheckId('different') }
    expect(() =>{  assertTicketAcceptance(accepted({ checks: [different, check] }), []) }).not.toThrow()
    const contributor = { ...assignment, ownerId: SessionId('contributor') }
    expect(() =>{  assertTicketAcceptance(accepted({ assignments: [{ ...contributor, status: 'completed', latestReportId: report.id }], checks: [{ ...check, authorId: contributor.ownerId }] }), []) }).toThrow('independent author')
  })
})

it('contains a non-Error thrown while decoding a durable snapshot', () => {
  const parse = vi.spyOn(ticketSnapshotSchema, 'parse').mockImplementationOnce(() => { throw 'snapshot parser failed' })
  try {
    const state = ticketProjectionDefinition.apply(emptyTicketState(owner), { type: 'ticket/state', seq: SessionSeq(1), time: 1, data: { version: 2, sessionId: owner, ticket: ticket() } })
    expect(state.failure).toBe('snapshot parser failed')
    expect(state.tickets).toEqual([])
  } finally { parse.mockRestore() }
})

it('retains checks for an older specification as history', () => {
  const previous = accepted()
  const { currentCandidateId: _candidate, ...base } = previous
  const next = successor(base, { specification: { revision: 2, dependencies: [], acceptanceCriteria: [] } })
  expect(() => { validateCurrentTicketChange(previous, next) }).not.toThrow()
  expect(next.checks).toEqual(previous.checks)
})
