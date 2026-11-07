/** Round-8 membership revocation across the panel's Ticket command queue. */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import WorkstreamEvidenceService from '@deepseek-ai/dsh-experimental-workstream-evidence'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import { ticketActor } from '../../ticket/tests/ticket-actor.ts'
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
  await ctx.plugin(RemoteAccessService)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: scratch('workstream-panel-r8-sessions-') })
  await ctx.plugin(LocalAttachmentStore, { dshHome: scratch('workstream-panel-r8-attachments-') })
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
  const asked = await ticketActor(ctx, owner.id, () => ctx.tickets.ask(owner.session, {
    ticketId: created.id, expectedRevision: created.revision, actorId: owner.id, question: 'Which branch?',
  }))
  const ticket = await ticketActor(ctx, owner.id, () => ctx.tickets.attention(owner.session, {
    ticketId: asked.id, expectedRevision: asked.revision, actorId: owner.id, kind: 'decision', message: 'Pick a date',
  }))
  return { ctx, owner, ticket, question: ticket.questions[0]!.id, attention: ticket.attentions[0]!.id }
}


it.each(['answer', 'close', 'acknowledge', 'resolve'] as const)(
  'R8-M2 queued panel %s must honor membership revoked while it waits', async (operation) => {
    const { ctx, owner, ticket, question, attention } = await setup()
    const signal = new AbortController().signal
    const member = await ctx.workstreams.addMember(owner, owner.id, {
      operationId: WorkstreamOperationId('worker'), name: 'worker', description: 'Worker', provider: 'spawn', prompt: 'Work', signal,
    })
    const worker = ctx.agents.get(member.id)!
    // Ticket handoff is a public profile tool; a partial Workstream handoff can also leave this arrangement.
    const handed = await ctx.agents.withInitiator(owner, () => ctx.tickets.handoff(owner.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: owner.id, newCoordinatorId: worker.id,
    }))
    const base = { ticketId: handed.id, expectedRevision: handed.revision }
    const invoke = () => {
      switch (operation) {
        case 'answer': return ctx.workstreamPanel.answerQuestion(worker, { ...base, questionId: question, answer: 'main' })
        case 'close': return ctx.workstreamPanel.closeQuestion(worker, { ...base, questionId: question })
        case 'acknowledge': return ctx.workstreamPanel.acknowledgeAttention(worker, { ...base, attentionId: attention })
        case 'resolve': return ctx.workstreamPanel.resolveAttention(worker, { ...base, attentionId: attention })
      }
    }
    const enteredFlush = Promise.withResolvers<undefined>(), releaseFlush = Promise.withResolvers<undefined>()
    const enteredStopFlush = Promise.withResolvers<undefined>(), releaseStopFlush = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let rootFlushes = 0
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session !== owner.session) return flush(session)
      rootFlushes += 1
      if (rootFlushes === 1) {
        enteredFlush.resolve(undefined); await releaseFlush.promise
      } else if (rootFlushes === 2) {
      // The stop record is physically flushed, but its caller has not resumed to drain the child.
        const result = await flush(session)
        enteredStopFlush.resolve(undefined); await releaseStopFlush.promise
        return result
      }
      return flush(session)
    })
    const blocker = ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session, { subject: 'Queue barrier', description: '' }))
    await enteredFlush.promise
    const enteredCommand = Promise.withResolvers<undefined>()
    const method = ({ answer: 'answer', close: 'closeQuestion', acknowledge: 'acknowledgeAttention', resolve: 'resolveAttention' } as const)[operation]
    // The spy only observes queue admission; it calls the real Ticket method before signaling.
    let closing: Promise<string> | undefined
    let stopping: Promise<unknown> | undefined
    try {
    // Each method has a distinct request type; preserve those real signatures in its observation wrapper.
      if (method === 'answer') {
        const original = ctx.tickets.answer.bind(ctx.tickets)
        vi.spyOn(ctx.tickets, 'answer').mockImplementation((...args) => { const p = original(...args); enteredCommand.resolve(undefined); return p })
      } else if (method === 'closeQuestion') {
        const original = ctx.tickets.closeQuestion.bind(ctx.tickets)
        vi.spyOn(ctx.tickets, 'closeQuestion').mockImplementation((...args) => { const p = original(...args); enteredCommand.resolve(undefined); return p })
      } else if (method === 'acknowledgeAttention') {
        const original = ctx.tickets.acknowledgeAttention.bind(ctx.tickets)
        vi.spyOn(ctx.tickets, 'acknowledgeAttention').mockImplementation((...args) => { const p = original(...args); enteredCommand.resolve(undefined); return p })
      } else {
        const original = ctx.tickets.resolveAttention.bind(ctx.tickets)
        vi.spyOn(ctx.tickets, 'resolveAttention').mockImplementation((...args) => { const p = original(...args); enteredCommand.resolve(undefined); return p })
      }
      closing = invoke().then(() => 'committed', () => 'rejected')
      await enteredCommand.promise
      stopping = ctx.workstreams.stop(owner, owner.id, worker.id)
      await enteredStopFlush.promise
      expect(ctx.workstreams.get(owner, owner.id).members.find(m => m.id === worker.id)?.phase).toBe('stopping')
      expect(() => ctx.workstreams.requireMembership(worker, owner.id)).toThrow()
      expect(ctx.agents.get(worker.id)).toBe(worker)
      // The identical command, newly entered after revocation, is denied before Ticket admission.
      await expect(invoke()).rejects.toMatchObject({ code: 'workstreamPanel/denied', details: { reason: 'not-member' } })
      releaseFlush.resolve(undefined)
      const outcome = await closing
      releaseStopFlush.resolve(undefined)
      await stopping
      const handle = await ctx.sessionPersistence.open(owner.id, 'read')
      let questionStatus: string | undefined, attentionStatus: string | undefined
      try {
        const last = (await handle.read(0)).events.filter(e => e.type === 'ticket/state' && e.data.ticket.id === ticket.id).at(-1)
        if (last?.type === 'ticket/state') {
          questionStatus = last.data.ticket.questions.find(q => q.id === question)?.status
          attentionStatus = last.data.ticket.attentions.find(a => a.id === attention)?.status
        }
      } finally { await handle.close() }
      expect({ outcome, questionStatus, attentionStatus }, 'a revoked Workstream member must not commit a queued panel mutation')
        .toEqual({ outcome: 'rejected', questionStatus: 'open', attentionStatus: 'open' })
    } finally {
      releaseFlush.resolve(undefined); releaseStopFlush.resolve(undefined)
      await Promise.allSettled([blocker, closing, stopping])
    }
  })
