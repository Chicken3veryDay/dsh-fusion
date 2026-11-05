/** Projection fixtures shared by the Workstream panel client specs. */
import type {
  AssignmentId, MissionId, TicketAttentionId, TicketId, TicketProjection, TicketQuestionId, TicketView,
} from '@deepseek-ai/dsh-experimental-ticket/client'
import type { WorkstreamOperationId, WorkstreamSnapshot } from '@deepseek-ai/dsh-experimental-workstream/client'
import type {
  WorkstreamEvidenceArtifactId, WorkstreamEvidenceOperationId, WorkstreamEvidenceSnapshot,
} from '@deepseek-ai/dsh-experimental-workstream-evidence/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const ROOT = 'root' as SessionId
export const WORKER = 'worker' as SessionId
export const REVIEWER = 'reviewer' as SessionId

const operationId = 'op' as WorkstreamOperationId

export const workstream: WorkstreamSnapshot = {
  ownerSessionId: ROOT,
  coordinatorId: ROOT,
  operationId,
  revision: 3,
  title: 'Release 2.0',
  members: [
    { id: ROOT, name: 'owner', role: 'owner', diagnostic: null, description: 'Release 2.0', provider: 'owner', operationId, prompt: '', phase: 'active' },
    { id: WORKER, name: 'builder', role: 'member', diagnostic: null, description: 'Builds the release', provider: 'spawn', operationId, prompt: 'Build', phase: 'active' },
    { id: REVIEWER, name: 'reviewer', role: 'member', diagnostic: 'exited with code 1', description: '', provider: 'spawn', operationId, prompt: 'Review', phase: 'stopped' },
    { id: 'pending' as SessionId, name: 'pending', role: 'member', diagnostic: null, description: '', provider: 'spawn', operationId, prompt: '', phase: 'provisioning' },
    { id: 'leaving' as SessionId, name: 'leaving', role: 'member', diagnostic: null, description: '', provider: 'spawn', operationId, prompt: '', phase: 'stopping' },
  ],
  messages: [],
}

/**
 * Build one Ticket view with empty collections.
 * @param id - Ticket identity.
 * @param overrides - fields to replace.
 * @returns a complete Ticket view.
 */
export function ticket(id: string, overrides: Partial<TicketView> = {}): TicketView {
  return {
    id: id as TicketId,
    revision: 1,
    subject: `Ticket ${id}`,
    description: '',
    status: 'ready',
    coordinatorId: ROOT,
    assignments: [],
    reports: [],
    questions: [],
    attentions: [],
    workScopes: [],
    executionSlots: [],
    createdAt: 0,
    updatedAt: 0,
    specification: { revision: 1, acceptanceCriteria: [], dependencies: [] },
    attempts: [],
    candidates: [],
    checks: [],
    operations: [],
    missionPlans: [],
    ...overrides,
  }
}

export const build = ticket('build', {
  revision: 4,
  subject: 'Build artifacts',
  description: 'Compile every package',
  status: 'executing',
  assignments: [{
    id: 'a1' as AssignmentId, revision: 1, role: 'worker', subject: 'Compile', instructions: '', ownerId: WORKER,
    status: 'running', workScopes: [], attempts: 1, contribution: 'required',
  }],
  questions: [
    { id: 'q1' as TicketQuestionId, authorId: WORKER, question: 'Which branch?', status: 'open', createdAt: 10 },
    { id: 'q0' as TicketQuestionId, authorId: WORKER, question: 'Old question', status: 'answered', answer: 'main', createdAt: 1 },
  ],
  attentions: [
    { id: 'n1' as TicketAttentionId, kind: 'decision', message: 'Pick a release date', status: 'open', createdAt: 5 },
    { id: 'n2' as TicketAttentionId, kind: 'blocked', message: 'CI is down', status: 'acknowledged', createdAt: 20 },
    { id: 'n0' as TicketAttentionId, kind: 'review', message: 'Done already', status: 'resolved', createdAt: 0 },
  ],
  missionPlans: [{
    id: 'm1' as MissionId, revision: 1, title: 'Launch',
    milestones: [{ title: 'Beta', ticketIds: ['build' as TicketId, 'docs' as TicketId] }],
  }],
})

export const docs = ticket('docs', {
  subject: 'Write docs',
  status: 'completed',
  coordinatorId: WORKER,
  specification: { revision: 1, acceptanceCriteria: [], dependencies: ['build' as TicketId, 'gone' as TicketId] },
  attentions: [{ id: 'n9' as TicketAttentionId, kind: 'review', message: 'Ended ticket item', status: 'open', createdAt: 2 }],
  terminalOutcome: { kind: 'completed', summary: 'done', actorId: ROOT, at: 3 },
  missionPlans: [{
    id: 'm1' as MissionId, revision: 2, title: 'Launch',
    milestones: [{ title: 'Beta', ticketIds: ['build' as TicketId, 'docs' as TicketId] }, { title: 'GA', ticketIds: ['docs' as TicketId] }, { title: 'Later', ticketIds: [] }],
  }, {
    id: 'm1' as MissionId, revision: 1, title: 'Launch (old)', milestones: [],
  }],
})

export const tickets: TicketProjection = { tickets: [build, docs] }

export const evidence: WorkstreamEvidenceSnapshot = {
  ownerSessionId: ROOT,
  revision: 2,
  artifacts: [{
    artifactId: 'spec' as WorkstreamEvidenceArtifactId,
    latestVersion: 2,
    versions: [1, 2].map(version => ({
      artifactId: 'spec' as WorkstreamEvidenceArtifactId,
      version,
      name: version === 2 ? 'spec-v2.md' : 'spec.md',
      ref: `att:spec-${version}`,
      digest: `sha256:${String(version).repeat(64)}`,
      bytes: version * 2048,
      authorSessionId: version === 2 ? WORKER : ROOT,
      operationId: `p${version}` as WorkstreamEvidenceOperationId,
      createdAt: '2026-11-05T00:00:00.000Z',
    })),
  }],
}
