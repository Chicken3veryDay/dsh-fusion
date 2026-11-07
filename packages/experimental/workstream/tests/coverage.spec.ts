import { z } from 'zod'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'
import { WorkstreamTools } from '../src/tools.ts'

const contexts: Context[] = []
const directories: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(config: ConstructorParameters<typeof WorkstreamService>[1] = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService, config)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner, fiber }
}

function memberRequest(name: string) {
  return { operationId: WorkstreamOperationId(name), name, description: 'Worker', provider: 'spawn', prompt: 'Work', signal }
}

describe('Workstream model tool execution', () => {
  it('opens, lists, gets, provisions, acknowledges, hands off, waits, stops and assigns through registered tools', async () => {
    const { ctx, owner } = await setup()
    await ctx.plugin(WorkstreamTools)
    const exec = { agent: owner, signal } as ToolRunContext
    const run = (name: string, args: Record<string, unknown> = {}) => ctx.tools.get(`workstream_${name}`)!.execute(args, exec)
    await expect(run('open', { operation_id: 'open', title: 'Build work' })).resolves.toMatchObject({ ownerSessionId: owner.id })
    await expect(run('list')).resolves.toHaveLength(1)
    await expect(run('get', { root_session_id: owner.id })).resolves.toMatchObject({ cursor: owner.session.seq })
    await run('add_member', { root_session_id: owner.id, operation_id: 'worker', name: 'worker', description: 'Worker',
      provider: 'spawn', prompt: 'Work' })
    const member = ctx.workstreams.get(owner, owner.id).members.find(item => item.role === 'member')!
    await run('send', { root_session_id: owner.id, operation_id: 'message', target_id: member.id, text: 'Review' })
    await expect(run('interrupt', { root_session_id: owner.id, target_id: member.id })).resolves.toEqual({ interrupted: true })
    const received = ctx.workstreams.get(owner, owner.id).messages[0]!
    const memberExec = { ...exec, agent: ctx.agents.get(member.id)! }
    await expect(ctx.tools.get('workstream_acknowledge')!.execute({ root_session_id: owner.id, operation_id: 'message' }, memberExec))
      .resolves.toMatchObject({ delivery: { phase: 'processed', messageId: received.delivery.phase === 'intent' ? '' : received.delivery.messageId } })
    await expect(run('create_ticket', { root_session_id: owner.id, subject: 'Generated id', description: '' })).resolves.toMatchObject({ subject: 'Generated id' })
    await expect(run('wait', { root_session_id: owner.id, after_revision: 0, timeout_ms: 1 })).resolves.toMatchObject({ timedOut: false })
    const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Ticket', description: '' })
    await expect(run('assign_ticket', { root_session_id: owner.id, ticket_id: ticket.id, expected_revision: ticket.revision,
      owner_id: member.id, subject: 'Work' })).resolves.toMatchObject({ assignments: [{ ownerId: member.id }] })
    await run('handoff', { root_session_id: owner.id, expected_revision: ctx.workstreams.get(owner, owner.id).revision,
      coordinator_id: member.id })
    await ctx.workstreams.handoff(memberExec.agent, owner.id, { expectedRevision: ctx.workstreams.get(owner, owner.id).revision,
      coordinatorId: owner.id })
    const revision = ctx.workstreams.get(owner, owner.id).revision
    await expect(run('wait', { root_session_id: owner.id, after_revision: revision, after_cursor: owner.session.seq, timeout_ms: 1 }))
      .resolves.toMatchObject({ timedOut: true, revision })
    await expect(run('stop', { root_session_id: owner.id, target_id: member.id })).resolves.toMatchObject({ phase: 'stopped' })
    const tool = ctx.tools.get('workstream_get')!
    const result = await run('get', { root_session_id: owner.id })
    expect(tool.output.render({ root_session_id: owner.id }, z.json().parse(result))).toEqual([{ type: 'text', text: JSON.stringify(result) }])
    await expect(tool.execute({ root_session_id: owner.id }, { signal } as ToolRunContext)).rejects.toThrow('live calling Agent')
  })

  it('rejects conflicting creation and member identities, child roots, empty input and inactive members', async () => {
    const { ctx, owner } = await setup()
    await expect(ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('other'), title: 'Build work' }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_CONFLICT' })
    const member = await ctx.workstreams.addMember(owner, owner.id, memberRequest('worker'))
    const child = ctx.agents.get(member.id)!
    await expect(ctx.workstreams.open(child, { operationId: WorkstreamOperationId('child'), title: 'Child' }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
    await expect(ctx.workstreams.addMember(owner, owner.id, { ...memberRequest('worker'), description: 'Different' }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_CONFLICT' })
    await expect(ctx.workstreams.addMember(owner, owner.id, { ...memberRequest('duplicate'), name: 'worker' }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_CONFLICT' })
    await expect(ctx.workstreams.addMember(owner, owner.id, { ...memberRequest('empty'), prompt: ' ' }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT' })
    expect(() => { ctx.workstreams.interrupt(owner, owner.id, owner.id) }).toThrow('Select a child member')
    await ctx.workstreams.stop(owner, owner.id, member.id)
    await expect(ctx.workstreams.addMember(owner, owner.id, memberRequest('worker'))).rejects.toMatchObject({ code: 'WORKSTREAM_CONFLICT' })
  })

  it('enforces the member limit and wait input bounds', async () => {
    const { ctx, owner } = await setup({ maxMembers: 1 })
    await expect(ctx.workstreams.addMember(owner, owner.id, memberRequest('worker'))).rejects.toMatchObject({ code: 'WORKSTREAM_LIMIT' })
    for (const timeoutMs of [0, 1.5, 3_600_001]) {
      await expect(ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: 1, timeoutMs, signal }))
        .rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT' })
    }
    const abort = new AbortController()
    abort.abort('cancelled')
    await expect(ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: 1, timeoutMs: 1, signal: abort.signal }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_DISPOSED' })
  })
})

it('rejects unsafe numeric configuration before loading the Workstream service', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  expect(() => new WorkstreamService(ctx, { maxMembers: Number.MAX_SAFE_INTEGER + 1 })).toThrow('positive safe integer')
})

it('keeps an absent Workstream distinct from a live root and an invalid handoff target', async () => {
  const { ctx, owner } = await setup()
  const stranger = await ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })
  expect(ctx.workstreams.list(stranger)).toEqual([])
  expect(() => ctx.workstreams.get(stranger, stranger.id)).toThrow('Root has no Workstream; open it first')
  const member = await ctx.workstreams.addMember(owner, owner.id, memberRequest('worker'))
  const child = ctx.agents.get(member.id)!
  await expect(ctx.workstreams.handoff(owner, owner.id, { expectedRevision: ctx.workstreams.get(owner, owner.id).revision,
    coordinatorId: SessionId('missing') })).rejects.toThrow()
  await ctx.workstreams.handoff(owner, owner.id, { expectedRevision: ctx.workstreams.get(owner, owner.id).revision,
    coordinatorId: member.id })
  await expect(ctx.workstreams.handoff(child, owner.id, { expectedRevision: 0, coordinatorId: owner.id }))
    .rejects.toMatchObject({ code: 'WORKSTREAM_CONFLICT' })
  await ctx.workstreams.handoff(child, owner.id, { expectedRevision: ctx.workstreams.get(owner, owner.id).revision,
    coordinatorId: owner.id })
  await ctx.workstreams.stop(owner, owner.id, member.id)
  const stopped = await ctx.workstreams.stop(owner, owner.id, member.id)
  expect(stopped.phase).toBe('stopped')
})

it('refuses self-delivery and a full message log, preserving its accepted receipts', async () => {
  const { ctx, owner } = await setup({ maxMessages: 1 })
  const member = await ctx.workstreams.addMember(owner, owner.id, memberRequest('worker'))
  const message = { operationId: WorkstreamOperationId('message'), targetId: member.id, text: 'Message', signal }
  await expect(ctx.workstreams.sendMessage(owner, owner.id, { ...message, targetId: owner.id }))
    .rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT' })
  const accepted = await ctx.workstreams.sendMessage(owner, owner.id, message)
  await expect(ctx.workstreams.sendMessage(owner, owner.id, { ...message, operationId: WorkstreamOperationId('second') }))
    .rejects.toMatchObject({ code: 'WORKSTREAM_LIMIT' })
  expect(ctx.workstreams.get(owner, owner.id).messages).toEqual([accepted])
})

it('lets simultaneous stops join child settlement and return the same stopped member', async () => {
  const { ctx, owner } = await setup()
  const member = await ctx.workstreams.addMember(owner, owner.id, memberRequest('worker'))
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
  vi.spyOn(ctx.subagents, 'drainChildren').mockImplementation(async (...args) => {
    entered.resolve(undefined); await release.promise; return drain(...args)
  })
  const first = ctx.workstreams.stop(owner, owner.id, member.id)
  await entered.promise
  const second = ctx.workstreams.stop(owner, owner.id, member.id)
  release.resolve(undefined)
  const results = await Promise.all([first, second])
  expect(results[0]).toEqual(results[1])
  expect(results[0]?.phase).toBe('stopped')
})

it('requires a live root and coordinator authority before mutating another member', async () => {
  const { ctx, owner } = await setup()
  expect(() => ctx.workstreams.get(owner, SessionId('absent'))).toThrow('owner is not live')
  const member = await ctx.workstreams.addMember(owner, owner.id, memberRequest('worker'))
  const child = ctx.agents.get(member.id)!
  await expect(ctx.workstreams.addMember(child, owner.id, memberRequest('peer'))).rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
  for (const target of [owner.id, SessionId('absent')]) {
    await expect(ctx.workstreams.stop(owner, owner.id, target)).rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT' })
  }
})

it('leaves standalone Ticket authority with its coordinator and refuses assignment to a Workstream owner', async () => {
  const { ctx, owner } = await setup()
  const standalone = await ctx.agentLoop.create(SessionId('standalone'), { provider: 'mock', model: 'mock' })
  const coordinator = await ctx.agentLoop.create(SessionId('coordinator'), { provider: 'mock', model: 'mock' })
  const ticket = await ctx.agents.withInitiator(standalone, () => ctx.tickets.create(standalone.session, {
    subject: 'Standalone', description: '', coordinatorId: coordinator.id,
  }))
  const assigned = await ctx.agents.withInitiator(coordinator, () => ctx.tickets.assign(standalone.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: coordinator.id, ownerId: standalone.id, subject: 'Work',
  }))
  expect(assigned.assignments[0]?.ownerId).toBe(standalone.id)
  const rootTicket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Root', description: '' })
  await expect(ctx.agents.withInitiator(owner, () => ctx.tickets.assign(owner.session, {
    ticketId: rootTicket.id, expectedRevision: rootTicket.revision, actorId: owner.id, ownerId: owner.id, subject: 'Invalid',
  }))).rejects.toMatchObject({ code: 'TICKET_AUTHORITY' })
})

it('refuses Ticket assignment and peer commands while the Workstream projection is loading', async () => {
  const { ctx, owner, fiber } = await setup()
  const standalone = await ctx.agentLoop.create(SessionId('standalone'), { provider: 'mock', model: 'mock' })
  const coordinator = await ctx.agentLoop.create(SessionId('coordinator'), { provider: 'mock', model: 'mock' })
  const ticket = await ctx.agents.withInitiator(standalone, () => ctx.tickets.create(standalone.session, {
    subject: 'Standalone', description: '', coordinatorId: coordinator.id,
  }))
  const rootTicket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Root', description: '' })
  await fiber.dispose()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
  vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async (definition) => {
    if (definition.key === 'workstream') { entered.resolve(undefined); await release.promise }
    return register(definition)
  })
  const loading = ctx.plugin(WorkstreamService)
  await entered.promise
  try {
    await expect(ctx.agents.withInitiator(owner, () => ctx.tickets.assign(owner.session, {
      ticketId: rootTicket.id, expectedRevision: rootTicket.revision, actorId: owner.id, ownerId: standalone.id, subject: 'Wait',
    }))).rejects.toMatchObject({ code: 'TICKET_COORDINATOR_UNAVAILABLE', cause: { code: 'WORKSTREAM_NOT_READY' } })
    await expect(ctx.agents.withInitiator(coordinator, () => ctx.tickets.block(standalone.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: coordinator.id, reason: 'Wait',
    }))).rejects.toMatchObject({ code: 'TICKET_COORDINATOR_UNAVAILABLE', cause: { code: 'WORKSTREAM_NOT_READY' } })
  } finally { release.resolve(undefined); await loading }
  expect(ctx.tickets.get(owner.session, rootTicket.id)).toEqual(rootTicket)
  expect(ctx.tickets.get(standalone.session, ticket.id)).toEqual(ticket)
})

it('retains both provisioning and drain failures when child acceptance is unknown', async () => {
  const { ctx, owner } = await setup()
  const launchError = new Error('launch outcome unavailable'), drainError = new Error('drain unavailable')
  vi.spyOn(ctx.subagents, 'startActivation').mockRejectedValueOnce(launchError)
  vi.spyOn(ctx.subagents, 'drainChildren').mockRejectedValueOnce(drainError)
  await expect(ctx.workstreams.addMember(owner, owner.id, memberRequest('uncertain')))
    .rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN', cause: { errors: [launchError, drainError] } })
  expect(ctx.workstreams.get(owner, owner.id).members.at(-1)?.phase).toBe('provisioning')
})

it('reports uncertain rollback when a capacity refusal cannot flush its removal', async () => {
  const { SubagentError } = await import('@deepseek-ai/dsh-subagent')
  const { ctx, owner } = await setup()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.subagents, 'startActivation').mockImplementationOnce(async () => {
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('rollback flush unavailable'))
    throw new SubagentError('capacity reached', 'ACTIVATION_LIMIT_REACHED')
  })
  await expect(ctx.workstreams.addMember(owner, owner.id, memberRequest('capacity')))
    .rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN', cause: { errors: [expect.objectContaining({ code: 'ACTIVATION_LIMIT_REACHED' }),
      expect.objectContaining({ message: 'rollback flush unavailable' })] } })
  await flush(owner.session)
  expect(ctx.workstreams.get(owner, owner.id).members).toHaveLength(1)
})

it('reports child settlement failure when the Workstream unloads', async () => {
  const { ctx, fiber } = await setup()
  vi.spyOn(ctx.subagents, 'drainChildren').mockRejectedValueOnce(new Error('child settlement unavailable'))
  const logger = vi.spyOn(ctx.logger, 'error')
  await fiber.dispose()
  expect(logger).toHaveBeenCalled()
  expect(ctx.get('workstreams')).toBeUndefined()
})

it('requires inbox acceptance before acknowledgement and reports unavailable recipient evidence on retry', async () => {
  const { ctx, owner } = await setup()
  const member = await ctx.workstreams.addMember(owner, owner.id, memberRequest('worker'))
  const child = ctx.agents.get(member.id)!
  vi.spyOn(child, 'steer').mockImplementationOnce(() => { throw new Error('inbox unavailable') })
  const request = { operationId: WorkstreamOperationId('message'), targetId: member.id, text: 'Message', signal }
  await expect(ctx.workstreams.sendMessage(owner, owner.id, request)).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
  await expect(ctx.workstreams.acknowledge(child, owner.id, request.operationId))
    .rejects.toThrow('Reconcile inbox acceptance before acknowledgement')
  vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('recipient storage unavailable'))
  await expect(ctx.workstreams.sendMessage(owner, owner.id, request)).rejects.toThrow('Recipient evidence is unavailable')
  expect(ctx.workstreams.get(owner, owner.id).messages[0]?.delivery.phase).toBe('intent')
})

it('propagates unexpected membership reader failures and handoff flush failures', async () => {
  const { ctx, owner } = await setup()
  const failure = new Error('reader unavailable')
  vi.spyOn(ctx.workstreams, 'get').mockImplementationOnce(() => { throw failure })
  expect(() => ctx.workstreams.list(owner)).toThrow(failure)
  const member = await ctx.workstreams.addMember(owner, owner.id, memberRequest('worker'))
  vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(failure)
  await expect(ctx.workstreams.handoff(owner, owner.id, { expectedRevision: ctx.workstreams.get(owner, owner.id).revision,
    coordinatorId: member.id })).rejects.toBe(failure)
})

it('ignores events from other Sessions and inherited owners until a concerning root change arrives', async () => {
  const { ctx, owner } = await setup()
  const peer = await ctx.agentLoop.create(SessionId('peer'), { provider: 'mock', model: 'mock' })
  const snapshot = ctx.workstreams.get(owner, owner.id)
  const waiting = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: snapshot.revision,
    afterCursor: owner.session.seq, timeoutMs: 60_000, signal })
  let changed = false
  const result = waiting.then((value) => { changed = true; return value })
  peer.session.append('workstream/state', { version: 1, snapshot: { ...snapshot, ownerSessionId: peer.id } })
  owner.session.append('workstream/state', { version: 1, snapshot: { ...snapshot, ownerSessionId: peer.id } })
  expect(changed).toBe(false)
  await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Root change', description: '' })
  expect(await result).toMatchObject({ timedOut: false, revision: snapshot.revision })
})
