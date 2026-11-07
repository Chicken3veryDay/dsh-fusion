/** `waitForChange` wakes for Workstream and concerning Ticket events after the caller's read, and for nothing else. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One owner, one resident member, and one Ticket assigned to and claimed by the member. */
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-wait-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  const added = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('add-asker'), name: 'asker',
    description: 'Asks questions', provider: 'spawn', prompt: 'Work on your Ticket', signal })
  const member = ctx.agents.get(added.id)
  if (member === undefined) throw new Error('Expected a resident member')
  const created = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Interface', description: 'Pick one' })
  const assigned = await ctx.workstreams.assignTicket(owner, owner.id, { ticketId: created.id, expectedRevision: created.revision,
    ownerId: member.id, subject: 'Implement' })
  const assignmentId = assigned.assignments[0]!.id
  const claimed = await ctx.agents.withInitiator(member, () => ctx.tickets.claim(owner.session, { ticketId: created.id,
    expectedRevision: assigned.revision, assignmentId, actorId: member.id }))
  const asked = await ctx.agents.withInitiator(member, () => ctx.tickets.ask(owner.session, { ticketId: created.id,
    expectedRevision: claimed.revision, assignmentId, actorId: member.id, question: 'Which interface?' }))
  return { ctx, owner, member, ticket: asked }
}

const anyCursor: unknown = expect.any(Number)

describe('Workstream wait cursor', () => {
  it('wakes at once for a Ticket answer committed between the member read and its wait', async () => {
    const { ctx, owner, member, ticket } = await setup()
    const revision = ctx.workstreams.get(member, owner.id).revision
    const cursor = ctx.workstreams.cursor(member, owner.id)
    await ctx.agents.withInitiator(owner, () => ctx.tickets.answer(owner.session, { ticketId: ticket.id,
      expectedRevision: ticket.revision, actorId: owner.id, questionId: ticket.questions[0]!.id, answer: 'Use the shared interface' }))
    await expect(ctx.workstreams.waitForChange(member, owner.id, { afterRevision: revision, timeoutMs: 60_000, signal }))
      .resolves.toEqual({ timedOut: false, revision, cursor: owner.session.seq })
    await expect(ctx.workstreams.waitForChange(member, owner.id, { afterRevision: revision, afterCursor: cursor, timeoutMs: 60_000,
      signal })).resolves.toEqual({ timedOut: false, revision, cursor: owner.session.seq })
    // A cursor read after the answer has nothing left to report.
    await expect(ctx.workstreams.waitForChange(member, owner.id, { afterRevision: revision, afterCursor: ctx.workstreams.cursor(member,
      owner.id), timeoutMs: 50, signal })).resolves.toEqual({ timedOut: true, revision, cursor: anyCursor })
    await expect(ctx.workstreams.waitForChange(member, owner.id, { afterRevision: revision, afterCursor: -1, timeoutMs: 50, signal }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT' })
  })

  it('does not wake for the owner turn or a Ticket that does not concern the member, and wakes for one that does', async () => {
    const { ctx, owner, member } = await setup()
    const revision = ctx.workstreams.get(member, owner.id).revision
    const cursor = ctx.workstreams.cursor(member, owner.id)
    const waiting = ctx.workstreams.waitForChange(member, owner.id, { afterRevision: revision, afterCursor: cursor, timeoutMs: 400,
      signal })
    owner.followup(createUserMessage({ content: [{ type: 'text', text: 'Keep the owner busy' }], source: { kind: 'user' } }))
    await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Unrelated', description: 'Owner-only work' })
    await expect(waiting).resolves.toEqual({ timedOut: true, revision, cursor: anyCursor })
    expect(owner.session.seq).toBeGreaterThan(cursor + 1)

    const concerning = ctx.workstreams.waitForChange(member, owner.id, { afterRevision: revision,
      afterCursor: ctx.workstreams.cursor(member, owner.id), timeoutMs: 60_000, signal })
    const next = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Follow-up', description: 'For the member' })
    await ctx.workstreams.assignTicket(owner, owner.id, { ticketId: next.id, expectedRevision: next.revision, ownerId: member.id,
      subject: 'Continue' })
    await expect(concerning).resolves.toEqual({ timedOut: false, revision, cursor: anyCursor })
  })

  it('a member loop that chains the returned revision and cursor wakes once per concerning change and never spins', async () => {
    const { ctx, owner, member, ticket } = await setup()
    let position = { revision: ctx.workstreams.get(member, owner.id).revision, cursor: ctx.workstreams.cursor(member, owner.id) }
    const outcomes: boolean[] = []
    /** One loop turn: wait from the last result while `activity` runs, then continue from what the wait returned. */
    const turn = async (activity: () => Promise<unknown>, timeoutMs = 400): Promise<void> => {
      const waiting = ctx.workstreams.waitForChange(member, owner.id, { afterRevision: position.revision,
        afterCursor: position.cursor, timeoutMs, signal })
      await activity()
      const result = await waiting
      expect(result.cursor).toBeGreaterThanOrEqual(position.cursor)
      position = { revision: result.revision, cursor: result.cursor }
      outcomes.push(result.timedOut)
    }
    const unrelated = async (subject: string): Promise<void> => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: subject }], source: { kind: 'user' } }))
      await ctx.workstreams.createTicket(owner, owner.id, { subject, description: 'Owner-only work' })
    }
    await turn(() => unrelated('First unrelated'))
    await turn(() => ctx.agents.withInitiator(owner, () => ctx.tickets.answer(owner.session, { ticketId: ticket.id,
      expectedRevision: ticket.revision, actorId: owner.id, questionId: ticket.questions[0]!.id, answer: 'Use the shared interface' })))
    await turn(() => unrelated('Second unrelated'))
    // A concerning change committed between two waits is reported once, by the next wait, and not again.
    await ctx.workstreams.sendMessage(owner, owner.id, { operationId: WorkstreamOperationId('note'), targetId: member.id,
      text: 'Answered', signal })
    await turn(() => Promise.resolve())
    await turn(() => unrelated('Third unrelated'))
    expect(outcomes).toEqual([true, false, true, false, true])
    expect(position.revision).toBe(ctx.workstreams.get(member, owner.id).revision)
  })

  it('wakes the owner for every root Ticket', async () => {
    const { ctx, owner } = await setup()
    const revision = ctx.workstreams.get(owner, owner.id).revision
    const waiting = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision,
      afterCursor: ctx.workstreams.cursor(owner, owner.id), timeoutMs: 60_000, signal })
    await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Any', description: 'Owner sees it' })
    await expect(waiting).resolves.toEqual({ timedOut: false, revision, cursor: owner.session.seq })
  })
})
