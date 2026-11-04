/** Shared admission and replay invariants for versioned Ticket acceptance. */

import { TicketError } from './errors.ts'
import { isTicketStatusTransitionAllowed } from './projection.ts'
import type { TicketId, TicketSnapshot } from './types.ts'

function same(value: unknown, other: unknown): boolean { return JSON.stringify(value) === JSON.stringify(other) }
function reject(message: string): never { throw new TicketError(message, 'TICKET_INVALID_INPUT') }
function unique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) reject(`${label} identities must be unique`)
}
function retained<T>(previous: readonly T[], next: readonly T[], label: string): void {
  if (!same(previous, next.slice(0, previous.length))) reject(`${label} history cannot be replaced`)
}

/** Validate references and cycles across the complete current Ticket set.
 * @param tickets - Current snapshots, including the proposed change.
 * @returns Nothing; throws before append for missing references or cycles.
 */
export function validateTicketReferences(tickets: readonly TicketSnapshot[]): void {
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]))
  const edges = new Map(tickets.map(ticket => [ticket.id, [...ticket.specification.dependencies]]))
  for (const ticket of tickets) {
    unique(ticket.specification.dependencies, 'dependency')
    for (const dependency of ticket.specification.dependencies) {
      if (!byId.has(dependency)) reject(`unknown dependency "${dependency}"`)
    }
    const parent = ticket.specification.parent
    if (parent !== undefined) {
      const children = edges.get(parent.ticketId)
      if (children === undefined) reject(`unknown parent "${parent.ticketId}"`)
      children.push(ticket.id)
      if (parent.required && byId.get(parent.ticketId)?.terminalOutcome !== undefined && ticket.terminalOutcome?.kind !== 'completed') reject('accepted parent cannot acquire unfinished required children')
    }
    for (const plan of ticket.missionPlans) {
      for (const milestone of plan.milestones) {
        unique(milestone.ticketIds, 'milestone Ticket')
        for (const id of milestone.ticketIds) if (!byId.has(id)) reject(`unknown Mission Ticket "${id}"`)
      }
    }
  }
  const visited = new Set<TicketId>()
  const active = new Set<TicketId>()
  function visit(id: TicketId): void {
    if (active.has(id)) reject(`Ticket dependency or parent cycle at "${id}"`)
    if (visited.has(id)) return
    active.add(id)
    for (const child of edges.get(id) ?? []) visit(child)
    active.delete(id)
    visited.add(id)
  }
  for (const ticket of tickets) visit(ticket.id)
}

/** Enforce acceptance against the current specification and exact candidate.
 * @param ticket - Ticket being accepted.
 * @param tickets - Session's current Ticket snapshots, including dependencies and children.
 * @returns Nothing; throws when any acceptance obligation remains unsettled.
 */
export function assertTicketAcceptance(ticket: TicketSnapshot, tickets: readonly TicketSnapshot[]): void {
  function require(value: boolean, message: string): void {
    if (!value) throw new TicketError(message, 'TICKET_ACCEPTANCE')
  }
  require(ticket.attempts.every(attempt => attempt.status === 'settled'), 'all execution attempts must settle before acceptance')
  require(!ticket.questions.some(question => question.status === 'open'), 'open questions prevent acceptance')
  require(ticket.attentions.every(attention => attention.status === 'resolved'), 'unresolved attention prevents acceptance')
  const candidate = ticket.candidates.find(item => item.id === ticket.currentCandidateId)
  require(candidate !== undefined && candidate.specRevision === ticket.specification.revision, 'submit a candidate for the current specification before acceptance')
  if (candidate === undefined) return
  const required = ticket.assignments.filter(assignment => assignment.contribution === 'required')
  for (const assignment of required) {
    const report = ticket.reports.find(item => item.id === assignment.latestReportId)
    require(candidate.assignmentIds.includes(assignment.id), `candidate lacks required Assignment "${assignment.id}"`)
    require(assignment.status === 'completed' && report?.kind === 'result'
      && report.specRevision === ticket.specification.revision && candidate.reportIds.includes(report.id), `Assignment "${assignment.id}" requires a current contribution`)
    if (assignment.activeAttemptId !== undefined) {
      const attempt = ticket.attempts.find(item => item.id === assignment.activeAttemptId)
      require(attempt?.status === 'settled' && attempt.outcome === 'succeeded'
        && report?.attemptId === attempt.id && attempt.specRevision === ticket.specification.revision,
      `Assignment "${assignment.id}" lacks a settled successful current attempt`)
    }
  }
  for (const criterion of ticket.specification.acceptanceCriteria.filter(item => item.required)) {
    const check = ticket.checks.filter(item => item.candidateId === candidate.id && item.criterionId === criterion.id
      && item.specRevision === ticket.specification.revision).at(-1)
    require(check?.outcome === 'pass', `criterion "${criterion.id}" requires a passing current check`)
    if (criterion.independent && check !== undefined) {
      const contributors = ticket.assignments.filter(assignment => candidate.assignmentIds.includes(assignment.id))
      require(candidate.authorId !== check.authorId && contributors.every(assignment => assignment.ownerId !== check.authorId),
        `criterion "${criterion.id}" requires an independent author`)
    }
  }
  for (const id of ticket.specification.dependencies) {
    require(tickets.some(item => item.id === id && item.terminalOutcome?.kind === 'completed'), `dependency "${id}" is not accepted`)
  }
  for (const child of tickets.filter(item => item.specification.parent?.ticketId === ticket.id && item.specification.parent.required)) {
    require(child.terminalOutcome?.kind === 'completed', `required child "${child.id}" is not accepted`)
  }
}

/** Check v2 lifecycle, immutable histories, and cross-record consistency.
 * @param previous - Last committed snapshot, if present.
 * @param ticket - Proposed snapshot.
 * @returns Nothing; throws when the proposed snapshot is inconsistent.
 */
export function validateCurrentTicketChange(previous: TicketSnapshot | undefined, ticket: TicketSnapshot): void {
  if (previous === undefined) {
    if (ticket.revision !== 1 || ticket.specification.revision !== 1 || ticket.status !== 'proposed') reject('Tickets begin proposed at revision one')
  } else {
    if (previous.terminalOutcome !== undefined) reject('terminal Ticket history is fixed')
    if (ticket.revision !== previous.revision + 1) reject('Ticket revision must be contiguous')
    if (previous.createdAt !== ticket.createdAt || previous.subject !== ticket.subject || previous.description !== ticket.description) reject('Ticket identity fields are immutable')
    if (!isTicketStatusTransitionAllowed(previous.status, ticket.status)) reject(`invalid ${previous.status} -> ${ticket.status} Ticket transition`)
    if (!same(previous.specification, ticket.specification) && ticket.specification.revision !== previous.specification.revision + 1) reject('specification revision must advance on edits')
    retained(previous.reports, ticket.reports, 'report')
    retained(previous.candidates, ticket.candidates, 'candidate')
    retained(previous.checks, ticket.checks, 'check')
    retained(previous.operations, ticket.operations, 'operation')
    if (ticket.assignments.length < previous.assignments.length || ticket.attempts.length < previous.attempts.length) reject('assignment and attempt history cannot be removed')
    for (const old of previous.assignments) {
      const next = ticket.assignments.find(item => item.id === old.id)
      if (next === undefined || next.ownerId !== old.ownerId || next.contribution !== old.contribution || next.role !== old.role
        || next.subject !== old.subject || next.instructions !== old.instructions || !same(next.workScopes, old.workScopes)
        || next.executionSlotId !== old.executionSlotId) reject('Assignment identity and responsibility are immutable')
    }
    for (const old of previous.attempts) {
      const next = ticket.attempts.find(item => item.id === old.id)
      if (next === undefined) reject('attempt history cannot be removed')
      if (old.status === 'settled' && !same(old, next)) reject('settled attempt history is immutable')
      if (next.assignmentId !== old.assignmentId || next.assignmentRevision !== old.assignmentRevision
        || next.specRevision !== old.specRevision || next.createdAt !== old.createdAt
        || !same(next.workspace, old.workspace) || !same(next.executor, old.executor)
        || !same(next.modelSelection, old.modelSelection)) reject('attempt selection and identity are immutable')
      if (old.workspaceReceipt !== undefined && !same(old.workspaceReceipt, next.workspaceReceipt)) reject('workspace receipt cannot be replaced')
      if (old.runtimeReceipt !== undefined && !same(old.runtimeReceipt, next.runtimeReceipt)) reject('runtime receipt cannot be replaced')
      if ((old.status === 'stopping' || old.status === 'unknown') && next.status === 'running') reject('uncertain or stopping attempt cannot resume running')
    }
    for (const old of previous.missionPlans) {
      const next = ticket.missionPlans.find(item => item.id === old.id)
      if (next === undefined || (!same(old, next) && next.revision !== old.revision + 1)) reject('Mission plan revision must advance on edits')
    }
  }
  for (const [label, values] of [
    ['assignment', ticket.assignments], ['execution slot', ticket.executionSlots], ['report', ticket.reports],
    ['question', ticket.questions], ['attention', ticket.attentions], ['attempt', ticket.attempts],
    ['candidate', ticket.candidates], ['check', ticket.checks], ['operation', ticket.operations], ['Mission', ticket.missionPlans],
  ] as const) unique(values.map(value => value.id), label)
  unique(ticket.specification.acceptanceCriteria.map(item => item.id), 'criterion')
  for (const attempt of ticket.attempts) {
    const assignment = ticket.assignments.find(item => item.id === attempt.assignmentId)
    if (assignment === undefined) reject('attempt references an unknown Assignment')
    if (attempt.status !== 'settled' && assignment.activeAttemptId !== attempt.id) reject('unsettled attempt must be active')
    if (attempt.specRevision > ticket.specification.revision) reject('attempt references a future specification')
    if (attempt.executor.kind === 'remote' && attempt.runtimeReceipt !== undefined && attempt.runtimeReceipt.world !== attempt.executor.world) reject('runtime receipt must preserve remote execution world')
  }
  for (const assignment of ticket.assignments) {
    if (assignment.activeAttemptId !== undefined && !ticket.attempts.some(attempt => attempt.id === assignment.activeAttemptId && attempt.assignmentId === assignment.id)) reject('active attempt is missing')
  }
  for (const candidate of ticket.candidates) {
    unique(candidate.assignmentIds, 'candidate Assignment')
    unique(candidate.reportIds, 'candidate report')
    if (candidate.reportIds.some(id => !ticket.reports.some(report => report.id === id && candidate.assignmentIds.includes(report.assignmentId) && report.specRevision === candidate.specRevision && report.kind === 'result'))) reject('candidate requires current result reports')
    if (candidate.assignmentIds.some(id => !ticket.assignments.some(assignment => assignment.id === id))) reject('candidate references an unknown Assignment')
  }
  if (ticket.currentCandidateId !== undefined && !ticket.candidates.some(candidate => candidate.id === ticket.currentCandidateId && candidate.specRevision === ticket.specification.revision)) reject('current candidate must match the specification')
  for (const check of ticket.checks) {
    const candidate = ticket.candidates.find(item => item.id === check.candidateId)
    if (candidate === undefined || candidate.specRevision !== check.specRevision) reject('check references an unknown candidate or revision')
    if (check.specRevision === ticket.specification.revision) {
      const criterion = ticket.specification.acceptanceCriteria.find(item => item.id === check.criterionId)
      if (criterion === undefined) reject('check references an unknown current criterion')
      if (criterion.independent && (check.authorId === candidate.authorId || ticket.assignments.some(assignment => candidate.assignmentIds.includes(assignment.id) && assignment.ownerId === check.authorId))) reject('independent check author contributed to the candidate')
    }
  }
  const terminal = ['completed', 'failed', 'cancelled'].includes(ticket.status)
  if (terminal !== (ticket.terminalOutcome !== undefined) || (ticket.terminalOutcome !== undefined && ticket.terminalOutcome.kind !== ticket.status)) reject('terminal status and outcome must agree')
  if (terminal && ticket.attempts.some(attempt => attempt.status !== 'settled')) reject('attempts must settle before a terminal outcome')
}
