import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { WorkstreamTools } from '../src/tools.ts'

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
  const dir = mkdtempSync(join(tmpdir(), 'workstream-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner, fiber }
}

function request(name: string) {
  return { operationId: WorkstreamOperationId(`create-${name}`), name, description: `${name} responsibility`, provider:
    'spawn', prompt: `${name} initial`, signal }
}

describe('durable Workstream authority and delivery', () => {
  it('provisions two real members, deduplicates peer delivery and preserves parent on handoff', async () => {
    const { ctx, owner } = await setup()
    const first = await ctx.workstreams.addMember(owner, owner.id, request('first'))
    const second = await ctx.workstreams.addMember(owner, owner.id, request('second'))
    const firstAgent = ctx.agents.get(first.id)
    const secondAgent = ctx.agents.get(second.id)
    if (firstAgent === undefined || secondAgent === undefined) throw new Error('Expected resident continuable members')
    expect((await ctx.workstreams.addMember(owner, owner.id, request('first'))).id).toBe(first.id)
    const send = { operationId: WorkstreamOperationId('peer-send'), targetId: second.id, text: 'Review the result', signal }
    const accepted = await ctx.workstreams.sendMessage(firstAgent, owner.id, send)
    expect(accepted.delivery.phase).toBe('accepted')
    expect(await ctx.workstreams.sendMessage(firstAgent, owner.id, send)).toEqual(accepted)
    expect(ctx.workstreams.get(owner, owner.id).messages).toHaveLength(1)
    expect((await ctx.workstreams.acknowledge(secondAgent, owner.id, send.operationId)).delivery.phase).toBe('processed')
    await expect(ctx.workstreams.acknowledge(firstAgent, owner.id, send.operationId)).rejects.toMatchObject({ code:
      'WORKSTREAM_UNAUTHORIZED' })
    const before = ctx.workstreams.get(owner, owner.id)
    const changed = await ctx.workstreams.handoff(owner, owner.id, { expectedRevision: before.revision, coordinatorId: first.id })
    expect(changed.ownerSessionId).toBe(owner.id)
    expect(secondAgent.session.header.parentSession).toBe(owner.id)
    expect(ctx.workstreams.requireMembership(firstAgent, owner.id).owner).toBe(owner)
    ctx.workstreams.interrupt(firstAgent, owner.id, second.id)
    const ticket = await ctx.workstreams.createTicket(secondAgent, owner.id, { subject: 'Peer proposal', description: 'Shared root work' })
    expect(ctx.tickets.get(owner.session, ticket.id)).toEqual(ticket)
    await expect(ctx.workstreams.assignTicket(secondAgent, owner.id, { ticketId: ticket.id, expectedRevision:
      ticket.revision, ownerId: second.id, subject: 'Denied' })).rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
    const assigned = await ctx.workstreams.assignTicket(firstAgent, owner.id, { ticketId: ticket.id, expectedRevision:
      ticket.revision, ownerId: second.id, subject: 'Contribute' })
    expect(assigned.assignments[0]?.ownerId).toBe(second.id)
    await expect(ctx.workstreams.handoff(firstAgent, owner.id, { expectedRevision: before.revision, coordinatorId: second.id,
    })).rejects.toMatchObject({ code: 'WORKSTREAM_CONFLICT' })
    expect((await ctx.workstreams.stop(firstAgent, owner.id, second.id)).phase).toBe('stopped')
    expect(ctx.agents.get(second.id)).toBeUndefined()
  })

  it('rejects exact-stale and foreign Agents on every root-authenticated operation', async () => {
    const { ctx, owner } = await setup()
    const foreign = await ctx.agentLoop.create(SessionId('foreign'), { provider: 'mock', model: 'mock' })
    expect(() => ctx.workstreams.get(foreign, owner.id)).toThrow(expect.objectContaining({ code: 'WORKSTREAM_UNAUTHORIZED' }))
    await expect(ctx.workstreams.createTicket(foreign, owner.id, { subject: 'No', description: '' })).rejects.toMatchObject({
      code: 'WORKSTREAM_UNAUTHORIZED' })
    const stale = { ...owner }
    expect(() => ctx.workstreams.get(stale, owner.id)).toThrow(expect.objectContaining({ code: 'WORKSTREAM_UNAUTHORIZED' }))
    await expect(ctx.workstreams.sendMessage(stale, owner.id, { operationId: WorkstreamOperationId('invalid'), targetId:
      foreign.id, text: 'No', signal })).rejects.toMatchObject({ code: 'WORKSTREAM_UNAUTHORIZED' })
  })

  it('retains unknown provisioning through service replacement without launching again', async () => {
    const { ctx, owner, fiber } = await setup()
    const start = vi.spyOn(ctx.subagents, 'startActivation').mockRejectedValueOnce(new Error('connection lost'))
    await expect(ctx.workstreams.addMember(owner, owner.id, request('uncertain'))).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    expect(ctx.workstreams.get(owner, owner.id).members[1]?.phase).toBe('provisioning')
    await fiber.dispose()
    await ctx.plugin(WorkstreamService)
    await expect(ctx.workstreams.addMember(owner, owner.id, request('uncertain'))).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    expect(start).toHaveBeenCalledTimes(1)
    expect(ctx.workstreams.get(owner, owner.id).members[1]?.diagnostic).toContain('not yet confirmed')
  })

  it('retains uncertain delivery after interrupted target acceptance and never sends twice', async () => {
    const { ctx, owner, fiber } = await setup()
    const child = await ctx.workstreams.addMember(owner, owner.id, request('child'))
    const sender = ctx.agents.get(child.id)
    if (sender === undefined) throw new Error('Expected member')
    const steer = vi.spyOn(owner, 'steer').mockImplementationOnce(() => { throw new Error('Lost receipt') })
    const send = { operationId: WorkstreamOperationId('uncertain-send'), targetId: owner.id, text: 'Result', signal }
    await expect(ctx.workstreams.sendMessage(sender, owner.id, send)).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    await fiber.dispose()
    await ctx.plugin(WorkstreamService)
    // The technical owner may inspect this member's immutable send intent after replacement.
    const snapshot = ctx.workstreams.get(owner, owner.id)
    expect(snapshot.messages[0]?.delivery.phase).toBe('intent')
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('logs complete context before acceptance and rejects operation id input changes', async () => {
    const { ctx, owner } = await setup()
    const child = await ctx.workstreams.addMember(owner, owner.id, request('context'))
    const context = { requirements: 'Version 2', decisions: ['Use Tickets'], cursor: 'cursor-1', changes: 'New criteria',
      artifacts: [{ ref: 'artifact:1', digest: 'sha256:one' }] }
    const send = { operationId: WorkstreamOperationId('packet'), targetId: child.id, text: 'Updated context', context, signal }
    const result = await ctx.workstreams.sendMessage(owner, owner.id, send)
    expect(result.context).toEqual(context)
    const handle = await ctx.sessionPersistence.open(owner.id, 'read')
    try {
      const { events } = await handle.read(0)
      const states = events.filter(event => event.type === 'workstream/state').map(event => event.data.snapshot)
      expect(states.some(state => state.messages.some(message => message.operationId === send.operationId &&
        message.delivery.phase === 'intent' && message.context?.requirements === 'Version 2'))).toBe(true)
    } finally { await handle.close() }
    await expect(ctx.workstreams.sendMessage(owner, owner.id, { ...send, text: 'Changed' })).rejects.toMatchObject({ code:
      'WORKSTREAM_CONFLICT' })
  })

  it('waits on durable events, bounds timeout, cancels and releases waiters on shutdown', async () => {
    const { ctx, owner, fiber } = await setup()
    const revision = ctx.workstreams.get(owner, owner.id).revision
    const waiting = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, timeoutMs: 1_000, signal })
    await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Unrelated progress', description: '' })
    await expect(waiting).resolves.toEqual({ timedOut: false, revision })
    await expect(ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, timeoutMs: 1, signal,
    })).resolves.toEqual({ timedOut: true, revision })
    const abort = new AbortController()
    const cancelled = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, timeoutMs: 1_000, signal: abort.signal })
    const cancellation = expect(cancelled).rejects.toThrow('cancel wait')
    abort.abort(new Error('cancel wait'))
    await cancellation
    const disposed = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, timeoutMs: 1_000, signal })
    const rejection = expect(disposed).rejects.toMatchObject({ code: 'WORKSTREAM_DISPOSED' })
    await fiber.dispose()
    await rejection
  })

  it('rejects unsupported providers before appending a launch intent', async () => {
    const { ctx, owner } = await setup()
    const before = ctx.workstreams.get(owner, owner.id)
    await expect(ctx.workstreams.addMember(owner, owner.id, { ...request('missing'), provider: 'missing',
    })).rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT' })
    expect(ctx.workstreams.get(owner, owner.id)).toEqual(before)
  })

  it('registers and removes only workstream-prefixed model tools', async () => {
    const { ctx } = await setup()
    const register = vi.spyOn(ctx.tools, 'register')
    const fiber = await ctx.plugin(WorkstreamTools)
    expect(register.mock.calls.length).toBeGreaterThan(10)
    expect(register.mock.calls.every(([tool]) => tool.name.startsWith('workstream_'))).toBe(true)
    await fiber.dispose()
  })
})
