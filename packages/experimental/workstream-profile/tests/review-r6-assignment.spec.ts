/** Round-6 assignment admission races through the real profile Ticket tool and durable command queue. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import TicketTools from '../src/ticket-tools.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'workstream-profile-assign-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  await ctx.plugin(TicketTools)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Assign' })
  const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('create-worker'),
    name: 'worker', description: 'worker responsibility', provider: 'spawn', prompt: 'Work', signal })
  const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Work for the team', description: '' })
  const assign = (ownerId: string) => executeToolFixture(ctx, { agent: owner, name: 'ticket_assign', callId: ToolCallId(`assign-${ownerId}`), signal,
    arguments: { root_session_id: 'owner', ticket_id: ticket.id, expected_revision: ticket.revision, owner_id: ownerId, subject: 'Do it' } })
  return { ctx, owner, member, ticket, assign }
}


it.each([false, true])('R6-M1 queued ticket_assign revalidates its assignee (stop before commit = %s)', async (stopBeforeCommit) => {
  const { ctx, owner, member, ticket, assign } = await setup()
  const entered: PromiseWithResolvers<void> = Promise.withResolvers(), release: PromiseWithResolvers<void> = Promise.withResolvers()
  const assignEntered: PromiseWithResolvers<void> = Promise.withResolvers()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
    entered.resolve(); await release.promise; return flush(session)
  })
  const assignReal = ctx.tickets.assign.bind(ctx.tickets)
  vi.spyOn(ctx.tickets, 'assign').mockImplementation((...args) => {
    const queued = assignReal(...args)
    assignEntered.resolve()
    return queued
  })
  const earlierTicketWrite = ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session, {
    subject: 'Independent Ticket occupies the command queue', description: '',
  }))
  let assigning: ReturnType<typeof assign> | undefined
  try {
    await entered.promise
    assigning = assign(member.id)
    await assignEntered.promise
    // The guard and Ticket's caller authentication already ran, but the mutation has not.
    expect(ctx.tickets.get(owner.session, ticket.id).assignments).toHaveLength(0)
    if (stopBeforeCommit) {
      await ctx.workstreams.stop(owner, owner.id, member.id)
      expect(ctx.agents.get(member.id)).toBeUndefined()
      expect(ctx.workstreams.get(owner, owner.id).members.find(m => m.id === member.id)?.phase).toBe('stopped')
    }
    release.resolve()
    await earlierTicketWrite
    const result = await assigning
    const handle = await ctx.sessionPersistence.open(owner.id, 'read')
    let persistedCount: number
    try {
      const last = (await handle.read(0)).events.filter(event => event.type === 'ticket/state' && event.data.ticket.id === ticket.id).at(-1)
      if (last?.type !== 'ticket/state') throw new Error('Expected the target Ticket in the physical log')
      persistedCount = last.data.ticket.assignments.length
    } finally { await handle.close() }
    expect(persistedCount).toBe(ctx.tickets.get(owner.session, ticket.id).assignments.length)
    expect({ isError: result.isError, persistedAssignments: persistedCount },
      'the profile must enforce active membership when the assignment commits, including after a Ticket queue wait')
      .toEqual({ isError: stopBeforeCommit, persistedAssignments: stopBeforeCommit ? 0 : 1 })
  } finally { release.resolve(); flushSpy.mockRestore(); await Promise.allSettled([earlierTicketWrite, assigning]) }
})
