/** Round-8 probes for Ticket tool calls admitted before Workstream unload. */
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
import TicketService, { TicketAttemptId, TicketOperationId } from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import TicketTools from '../src/ticket-tools.ts'
import WorkstreamTools from '../src/workstream-tools.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'workstream-profile-r8-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  // Observation only: resolves when the Workstream fiber removes its assignment authority from Ticket.
  const authorityRemoved: PromiseWithResolvers<undefined> = Promise.withResolvers()
  const register = ctx.tickets.registerAssignmentAuthority.bind(ctx.tickets)
  vi.spyOn(ctx.tickets, 'registerAssignmentAuthority').mockImplementation((authority) => {
    const dispose = register(authority)
    return () => { dispose(); authorityRemoved.resolve(undefined) }
  })
  const fiber = await ctx.plugin(WorkstreamService)
  await ctx.plugin(TicketTools)
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


/** Hold a real root Ticket flush, leaving later commands queued behind it. */
async function blockTicketQueue(ctx: Context, owner: Awaited<ReturnType<typeof setup>>['owner']) {
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
    entered.resolve(undefined)
    await release.promise
    return flush(session)
  })
  const blocking = ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session, {
    subject: 'Queue barrier', description: '',
  }))
  await entered.promise
  return { release, blocking, spy }
}

it.each([false, true])('R8-M1 queued ticket_assign preserves Workstream assignment admission (unload=%s)', async (unload) => {
  const { ctx, owner, member, ticket, assign, fiber, authorityRemoved } = await setup()
  await ctx.workstreams.stop(owner, owner.id, member.id)
  const gate = await blockTicketQueue(ctx, owner)
  const entered = Promise.withResolvers<undefined>()
  const realAssign = ctx.tickets.assign.bind(ctx.tickets)
  vi.spyOn(ctx.tickets, 'assign').mockImplementation((...args) => {
    const result = realAssign(...args)
    entered.resolve(undefined)
    return result
  })
  const assigning = assign(member.id, 'assign-before-unload')
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    if (unload) {
      closing = fiber.dispose()
      await authorityRemoved.promise
    }
    gate.release.resolve(undefined)
    if (unload) expect(ctx.tools.get('ticket_assign')).toBeUndefined()
    const result = await assigning
    await closing
    const assignees = await persistedAssignees(ctx, owner.id, ticket.id)
    expect({ isError: result.isError, assignees },
      'an admitted Ticket tool must not assign a stopped member after its Workstream authority is removed')
      .toEqual({ isError: true, assignees: [] })
  } finally {
    gate.release.resolve(undefined)
    await Promise.allSettled([gate.blocking, assigning, closing])
  }
})

it.each([false, true])('R8-M1 queued ticket_create preserves the sitting coordinator (unload=%s)', async (unload) => {
  const { ctx, owner, member, fiber, authorityRemoved } = await setup()
  await ctx.workstreams.handoff(owner, owner.id, {
    expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id,
  })
  const gate = await blockTicketQueue(ctx, owner)
  const entered = Promise.withResolvers<undefined>()
  const create = ctx.tickets.create.bind(ctx.tickets)
  vi.spyOn(ctx.tickets, 'create').mockImplementation((...args) => {
    const result = create(...args)
    entered.resolve(undefined)
    return result
  })
  const creating = executeToolFixture(ctx, { agent: owner, name: 'ticket_create', callId: ToolCallId('create-before-unload'), signal,
    arguments: { subject: 'Created across unload', description: '' } })
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    if (unload) {
      closing = fiber.dispose()
      await authorityRemoved.promise
    }
    gate.release.resolve(undefined)
    if (unload) expect(ctx.tools.get('ticket_create')).toBeUndefined()
    const result = await creating
    await closing
    if (unload) await ctx.plugin(WorkstreamService)
    const created = ctx.tickets.list(owner.session).filter(ticket => ticket.subject === 'Created across unload')
    const coordinator = ctx.workstreams.get(owner, owner.id).coordinatorId
    expect({ isError: result.isError, coordinators: created.map(ticket => ticket.coordinatorId) },
      'a queued Ticket creation must either refuse or preserve the sitting Workstream coordinator')
      .toEqual(result.isError ? { isError: true, coordinators: [] } : { isError: false, coordinators: [coordinator] })
    expect(coordinator).toBe(member.id)
  } finally {
    gate.release.resolve(undefined)
    await Promise.allSettled([gate.blocking, creating, closing])
  }
})


it.each(['proposed', 'ready', 'coordinating'] as const)('R8-C1 profile ticket_fail persists failure from %s after the Ticket rewrite', async (status) => {
  const { ctx, owner, member, ticket } = await setup()
  if (status === 'coordinating') await ctx.workstreams.handoff(owner, owner.id, {
    expectedRevision: ctx.workstreams.get(owner, owner.id).revision, coordinatorId: member.id,
  })
  const actor = status === 'coordinating' ? ctx.agents.get(member.id)! : owner
  const before = status === 'ready' ? await ctx.workstreams.assignTicket(owner, owner.id, {
    ticketId: ticket.id, expectedRevision: ticket.revision, ownerId: member.id, subject: 'Contribute',
  }) : ctx.tickets.get(owner.session, ticket.id)
  expect(before.status).toBe(status)
  const failed = await executeToolFixture(ctx, { agent: actor, name: 'ticket_fail', callId: ToolCallId(`fail-${status}`), signal,
    arguments: { root_session_id: owner.id, ticket_id: ticket.id, expected_revision: before.revision, summary: 'Cannot proceed' } })
  expect(failed.isError).toBe(false)
  const handle = await ctx.sessionPersistence.open(owner.id, 'read')
  try {
    const last = (await handle.read(0)).events.filter(e => e.type === 'ticket/state' && e.data.ticket.id === ticket.id).at(-1)
    expect(last?.type === 'ticket/state' ? last.data.ticket.terminalOutcome?.kind : undefined).toBe('failed')
  } finally { await handle.close() }
})

it('R8-C2 workstream_end_ticket retains the typed attempt refusal and the reworded model diagnostic', async () => {
  const { ctx, owner, member, ticket } = await setup()
  await ctx.plugin(WorkstreamTools)
  const assigned = await ctx.workstreams.assignTicket(owner, owner.id, {
    ticketId: ticket.id, expectedRevision: ticket.revision, ownerId: member.id, subject: 'Contribute', executionMode: 'shared-workspace',
  })
  const begun = await ctx.agents.withInitiator(owner, () => ctx.tickets.beginAttempt(owner.session, {
    ticketId: ticket.id, expectedRevision: assigned.revision, actorId: owner.id, assignmentId: assigned.assignments[0]!.id,
    attemptId: TicketAttemptId('review-r8-attempt'), operationId: TicketOperationId('review-r8-begin'),
    workspace: { kind: 'shared-workspace', directory: process.cwd() }, executor: { kind: 'in-process' },
  }))
  const request = { ticketId: ticket.id, expectedRevision: begun.revision, summary: 'Premature completion' }
  await expect(ctx.workstreams.endTicket(owner, owner.id, request)).rejects.toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  const result = await executeToolFixture(ctx, { agent: owner, name: 'workstream_end_ticket', callId: ToolCallId('end-unsettled'), signal,
    arguments: { root_session_id: owner.id, ticket_id: ticket.id, expected_revision: begun.revision, summary: request.summary } })
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('Expected refusal')
  expect(result.error.message).toContain('Attempt "review-r8-attempt":')
  expect(ctx.tickets.get(owner.session, ticket.id)).toEqual(begun)
})
