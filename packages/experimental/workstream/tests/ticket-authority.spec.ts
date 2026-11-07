/** Workstream's commit-time Ticket authority and its unload order. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
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
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-ticket-authority-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Authority' })
  const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('worker'),
    name: 'worker', description: 'Worker', provider: 'spawn', prompt: 'Work', signal })
  return { ctx, owner, member, fiber }
}

it('disposal waits for a Ticket command already queued for its root, which commits under Workstream rules', async () => {
  const { ctx, owner, member, fiber } = await setup()
  await ctx.workstreams.handoff(owner, owner.id, {
    expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id,
  })
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
    entered.resolve(undefined); await release.promise; return flush(session)
  })
  const barrier = ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session, { subject: 'Barrier', description: '' }))
  await entered.promise
  const order: string[] = []
  const queued = ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session, { subject: 'Queued', description: '' }))
    .then((ticket) => { order.push('ticket'); return ticket })
  const closing = fiber.dispose().then(() => { order.push('disposed') })
  // Unload stops at Ticket's queue for this root while the command waits.
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve))
  expect(order).toEqual([])
  release.resolve(undefined)
  await Promise.all([barrier, closing])
  expect(order).toEqual(['ticket', 'disposed'])
  expect((await queued).coordinatorId).toBe(member.id)
})

it('refuses a Ticket write by a live Agent that is not an active member, inside Ticket\'s queue', async () => {
  const { ctx, owner } = await setup()
  const outsider = await ctx.agentLoop.create(SessionId('outsider'), { provider: 'mock', model: 'mock' })
  const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Guarded', description: '' })
  // The owner may hand a Ticket to any live Agent; that Agent still cannot write while it is not a member.
  const handed = await ctx.agents.withInitiator(owner, () => ctx.tickets.handoff(owner.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: owner.id, newCoordinatorId: outsider.id,
  }))
  await expect(ctx.agents.withInitiator(outsider, () => ctx.tickets.attention(owner.session, {
    ticketId: handed.id, expectedRevision: handed.revision, actorId: outsider.id, kind: 'review', message: 'Review',
  }))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY', cause: { code: 'WORKSTREAM_UNAUTHORIZED' } })
  expect(ctx.tickets.get(owner.session, ticket.id)).toEqual(handed)
})
