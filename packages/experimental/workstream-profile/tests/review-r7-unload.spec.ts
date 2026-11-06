/** Round-7 probes: the Workstream assignment authority across Workstream unload while the profile Ticket tools stay mounted. */
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
import TicketService, { TicketTools as BaseTicketTools } from '@deepseek-ai/dsh-experimental-ticket'
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

/** The pre-fix profile entry's mount dependency, without its guard: Ticket tools that inject `workstreams`. */
class DependentTicketTools extends BaseTicketTools {
  static override inject = [...BaseTicketTools.inject, 'workstreams']
}

async function setup(tools: typeof BaseTicketTools = TicketTools) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-profile-r7-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  // Observation only: resolves when the Workstream fiber removes its assignment authority from Ticket.
  const authorityRemoved: PromiseWithResolvers<void> = Promise.withResolvers()
  const register = ctx.tickets.registerAssignmentAuthority.bind(ctx.tickets)
  vi.spyOn(ctx.tickets, 'registerAssignmentAuthority').mockImplementation((authority) => {
    const dispose = register(authority)
    return () => { dispose(); authorityRemoved.resolve() }
  })
  const fiber = await ctx.plugin(WorkstreamService)
  await ctx.plugin(tools)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Assign' })
  const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('create-worker'),
    name: 'worker', description: 'worker responsibility', provider: 'spawn', prompt: 'Work', signal })
  const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Work for the team', description: '' })
  const assign = (ownerId: string, call: string) => executeToolFixture(ctx, { agent: owner, name: 'ticket_assign',
    callId: ToolCallId(call), signal, arguments: { root_session_id: 'owner', ticket_id: ticket.id,
      expected_revision: ctx.tickets.get(owner.session, ticket.id).revision, owner_id: ownerId, subject: 'Do it' } })
  return { ctx, owner, member, ticket, assign, fiber, authorityRemoved }
}

async function persistedAssignees(ctx: Context, root: SessionId, ticketId: string): Promise<string[]> {
  const handle = await ctx.sessionPersistence.open(root, 'read')
  try {
    const last = (await handle.read(0)).events.filter(event => event.type === 'ticket/state' && event.data.ticket.id === ticketId).at(-1)
    if (last?.type !== 'ticket/state') throw new Error('Expected the target Ticket in the physical log')
    return last.data.ticket.assignments.map(assignment => assignment.ownerId)
  } finally { await handle.close() }
}

it('R7-M1 control: a loaded Workstream refuses ticket_assign to a stopped member', async () => {
  const { ctx, owner, member, assign } = await setup()
  await ctx.workstreams.stop(owner, owner.id, member.id)
  const result = await assign(member.id, 'assign-loaded')
  expect(result.isError).toBe(true)
})

it.each([
  ['shipped profile entry', TicketTools],
  ['control: Ticket tools that inject workstreams', DependentTicketTools],
] as const)('R7-M1 ticket_assign to a stopped member is refused while the Workstream service is unloading (%s)', async (_label, tools) => {
  const { ctx, owner, member, ticket, assign, fiber, authorityRemoved } = await setup(tools)
  await ctx.workstreams.stop(owner, owner.id, member.id)
  expect(ctx.workstreams.get(owner, owner.id).members.find(m => m.id === member.id)?.phase).toBe('stopped')
  // Workstream shutdown waits for its queued work; one ordinary Session flush of another root keeps it running.
  const other = await ctx.agentLoop.create(SessionId('other-root'), { provider: 'mock', model: 'mock' })
  const entered: PromiseWithResolvers<void> = Promise.withResolvers(), release: PromiseWithResolvers<void> = Promise.withResolvers()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
    entered.resolve(); await release.promise; return flush(session)
  })
  const opening = ctx.workstreams.open(other, { operationId: WorkstreamOperationId('open-other'), title: 'Other' })
    .then(() => undefined, () => undefined)
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = fiber.dispose()
    await authorityRemoved.promise
    // The Workstream service is still shutting down, and the shipped profile ticket_assign tool is still mounted.
    const result = await assign(member.id, 'assign-unloading')
    release.resolve()
    await closing
    const persisted = await persistedAssignees(ctx, owner.id, ticket.id)
    await ctx.plugin(WorkstreamService)
    const phase = ctx.workstreams.get(owner, owner.id).members.find(m => m.id === member.id)?.phase
    expect({ isError: result.isError, persistedAssignees: persisted, phase },
      'a durable Workstream must not gain an assignment to its stopped member while the Workstream service unloads')
      .toEqual({ isError: true, persistedAssignees: [], phase: 'stopped' })
  } finally { release.resolve(); await Promise.allSettled([opening, closing]) }
})

it.each([
  ['shipped profile entry', TicketTools],
  ['control: Ticket tools that inject workstreams', DependentTicketTools],
] as const)('R7-M1 owner ticket_create during Workstream unload names the sitting Workstream coordinator (%s)', async (_label, tools) => {
  const { ctx, owner, member, fiber, authorityRemoved } = await setup(tools)
  await ctx.workstreams.handoff(owner, owner.id, {
    expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id,
  })
  const other = await ctx.agentLoop.create(SessionId('other-root'), { provider: 'mock', model: 'mock' })
  const entered: PromiseWithResolvers<void> = Promise.withResolvers(), release: PromiseWithResolvers<void> = Promise.withResolvers()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
    entered.resolve(); await release.promise; return flush(session)
  })
  const opening = ctx.workstreams.open(other, { operationId: WorkstreamOperationId('open-other'), title: 'Other' })
    .then(() => undefined, () => undefined)
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = fiber.dispose()
    await authorityRemoved.promise
    const result = await executeToolFixture(ctx, { agent: owner, name: 'ticket_create', callId: ToolCallId('create-unloading'), signal,
      arguments: { subject: 'Created while Workstream unloads', description: '' } })
    release.resolve()
    await closing
    await ctx.plugin(WorkstreamService)
    const coordinator = ctx.workstreams.get(owner, owner.id).coordinatorId
    const created = ctx.tickets.list(owner.session).filter(ticket => ticket.subject === 'Created while Workstream unloads')
    expect({ isError: result.isError, ticketCoordinators: created.map(ticket => ticket.coordinatorId) },
      'an owner-default Ticket must not record the owner while the Workstream coordinator is a member')
      .toEqual(result.isError ? { isError: true, ticketCoordinators: [] } : { isError: false, ticketCoordinators: [coordinator] })
    expect(coordinator).toBe(member.id)
  } finally { release.resolve(); await Promise.allSettled([opening, closing]) }
})
