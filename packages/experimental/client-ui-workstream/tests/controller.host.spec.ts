/** The panel Remote runs Ticket commands as the live caller on its Workstream root and types every domain refusal. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService, { TicketAttentionId, TicketQuestionId } from '@deepseek-ai/dsh-experimental-ticket'
import type { TicketView } from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamError, WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import WorkstreamEvidenceService from '@deepseek-ai/dsh-experimental-workstream-evidence'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamPanelController from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', prefix))
  directories.push(dir)
  return dir
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: scratch('workstream-panel-sessions-') })
  await ctx.plugin(LocalAttachmentStore, { dshHome: scratch('workstream-panel-attachments-') })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  await ctx.plugin(WorkstreamEvidenceService)
  await ctx.plugin(WorkstreamPanelController)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Release' })
  const created = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Ship', description: 'Ship the release' })
  const asked = await ctx.tickets.ask(owner.session, {
    ticketId: created.id, expectedRevision: created.revision, actorId: owner.id, question: 'Which branch?',
  })
  const ticket = await ctx.tickets.attention(owner.session, {
    ticketId: asked.id, expectedRevision: asked.revision, actorId: owner.id, kind: 'decision', message: 'Pick a date',
  })
  return { ctx, owner, ticket, question: ticket.questions[0]!.id, attention: ticket.attentions[0]!.id }
}

function current(ctx: Context, ticket: TicketView): TicketView {
  return ctx.tickets.get(ctx.agents.get(SessionId('owner'))!.session, ticket.id)
}

describe('Workstream panel Remote', () => {
  it('answers and closes a question as the caller at the revision the panel read', async () => {
    const { ctx, owner, ticket, question } = await setup()
    await ctx.workstreamPanel.answerQuestion(owner, {
      ticketId: ticket.id, questionId: question, expectedRevision: ticket.revision, answer: 'main',
    })
    const answered = current(ctx, ticket)
    expect(answered.revision).toBe(ticket.revision + 1)
    expect(answered.questions[0]).toMatchObject({ status: 'answered', answer: 'main', answeredBy: owner.id })

    await ctx.workstreamPanel.closeQuestion(owner, { ticketId: ticket.id, questionId: question, expectedRevision: answered.revision })
    expect(current(ctx, ticket).questions[0]?.status).toBe('closed')
  })

  it('acknowledges, then resolves an attention item', async () => {
    const { ctx, owner, ticket, attention } = await setup()
    await ctx.workstreamPanel.acknowledgeAttention(owner, {
      ticketId: ticket.id, attentionId: attention, expectedRevision: ticket.revision,
    })
    const acknowledged = current(ctx, ticket)
    expect(acknowledged.attentions[0]?.status).toBe('acknowledged')
    await ctx.workstreamPanel.resolveAttention(owner, {
      ticketId: ticket.id, attentionId: attention, expectedRevision: acknowledged.revision,
    })
    expect(current(ctx, ticket).attentions[0]?.status).toBe('resolved')
  })

  it('rejects a stale revision with a typed code and appends nothing', async () => {
    const { ctx, owner, ticket, question } = await setup()
    await expect(ctx.workstreamPanel.answerQuestion(owner, {
      ticketId: ticket.id, questionId: question, expectedRevision: ticket.revision - 1, answer: 'main',
    })).rejects.toMatchObject({ code: 'workstreamPanel/stale-revision', details: {} })
    expect(current(ctx, ticket)).toEqual(ticket)
  })

  it('types Ticket input and authority refusals', async () => {
    const { ctx, owner, ticket } = await setup()
    await expect(ctx.workstreamPanel.closeQuestion(owner, {
      ticketId: ticket.id, questionId: TicketQuestionId('missing'), expectedRevision: ticket.revision,
    })).rejects.toMatchObject({ code: 'workstreamPanel/rejected' })
    const foreign = await ctx.tickets.create(owner.session, {
      subject: 'Foreign', description: 'Coordinated elsewhere', coordinatorId: SessionId('elsewhere'),
    })
    const attended = await ctx.tickets.attention(owner.session, {
      ticketId: foreign.id, expectedRevision: foreign.revision, actorId: SessionId('elsewhere'), kind: 'review', message: 'Review',
    })
    await expect(ctx.workstreamPanel.resolveAttention(owner, {
      ticketId: attended.id, attentionId: attended.attentions[0]!.id, expectedRevision: attended.revision,
    })).rejects.toMatchObject({ code: 'workstreamPanel/denied' })
    expect(current(ctx, attended).revision).toBe(attended.revision)
  })

  it('refuses a caller outside any Workstream before reading Tickets', async () => {
    const { ctx, ticket, attention } = await setup()
    const outsider = await ctx.agentLoop.create(SessionId('outsider'), { provider: 'mock', model: 'mock' })
    await expect(ctx.workstreamPanel.acknowledgeAttention(outsider, {
      ticketId: ticket.id, attentionId: attention, expectedRevision: ticket.revision,
    })).rejects.toMatchObject({ code: 'workstreamPanel/unavailable' })
    expect(() => ctx.workstreamPanel.changeRequests(outsider)).toThrow(expect.objectContaining({ code: 'workstreamPanel/unavailable' }))
    expect(current(ctx, ticket).attentions[0]?.status).toBe('open')
    await expect(ctx.workstreamPanel.resolveAttention(outsider, {
      ticketId: ticket.id, attentionId: TicketAttentionId('missing'), expectedRevision: ticket.revision,
    })).rejects.toMatchObject({ code: 'workstreamPanel/unavailable' })
  })

  it('reports incomplete change requests when no forge service is mounted', async () => {
    const { ctx, owner } = await setup()
    expect(ctx.workstreamPanel.changeRequests(owner)).toEqual({
      complete: false, changeRequests: [], diagnostics: ['Forge session service is not mounted'],
    })
  })

  it('propagates a failure outside the Ticket and Workstream domains unchanged', async () => {
    const { ctx, owner, ticket, question } = await setup()
    const failure = new Error('disk full')
    vi.spyOn(ctx.tickets, 'answer').mockRejectedValue(failure)
    await expect(ctx.workstreamPanel.answerQuestion(owner, {
      ticketId: ticket.id, questionId: question, expectedRevision: ticket.revision, answer: 'main',
    })).rejects.toBe(failure)
  })

  it.each([
    ['WORKSTREAM_UNAUTHORIZED', 'workstreamPanel/denied'],
    ['WORKSTREAM_DISPOSED', 'workstreamPanel/rejected'],
  ] as const)('types the membership refusal %s as %s', async (domain, code) => {
    const { ctx, owner, ticket, question } = await setup()
    vi.spyOn(ctx.workstreams, 'requireMembership').mockImplementation(() => { throw new WorkstreamError('membership refused', domain) })
    await expect(ctx.workstreamPanel.closeQuestion(owner, {
      ticketId: ticket.id, questionId: question, expectedRevision: ticket.revision,
    })).rejects.toMatchObject({ code, message: 'membership refused' })
  })
})
