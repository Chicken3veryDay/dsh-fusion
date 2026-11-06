/** Round-5 regressions for operations that must not wait on a child while they hold the per-root queue. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
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

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }
function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = () => { done() } })
  return { promise, resolve }
}

/** The member's first model response calls a root-queued Workstream tool, and the tool is held before it reaches the service. */
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-r5-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  await ctx.plugin(WorkstreamTools)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('child-send', 'workstream_send', {
    root_session_id: 'owner', operation_id: 'worker-report', target_id: 'owner', text: 'Report',
  }), ...Array.from({ length: 24 }, () => 'hang' as const)]))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  const toolEntered = deferred(), toolRelease = deferred()
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'workstream_send') { toolEntered.resolve(); await toolRelease.promise }
    return next()
  })
  const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('create-worker'),
    name: 'worker', description: 'worker responsibility', provider: 'spawn', prompt: 'Report first', signal })
  await toolEntered.promise
  return { ctx, owner, member, toolRelease }
}

/**
 * The owner sends to a member whose activation is closed from outside Workstream (the Subagent teardown a parent
 * disposal or a base subagent tool starts) while that member's own `workstream_send` waits for the root queue.
 */
async function sendToClosingMember(operationId: string) {
  const { ctx, owner, member, toolRelease } = await setup()
  const flushEntered = deferred(), flushRelease = deferred(), childQueued = deferred()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let held = false
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (!held && session === owner.session && ctx.workstreams.get(owner, owner.id).messages.some(m => m.operationId === operationId)) {
      held = true; flushEntered.resolve(); await flushRelease.promise
    }
    return flush(session)
  })
  const send = ctx.workstreams.sendMessage.bind(ctx.workstreams)
  vi.spyOn(ctx.workstreams, 'sendMessage').mockImplementation((caller, ...rest) => {
    const queued = send(caller, ...rest)
    if (caller !== owner) childQueued.resolve()
    return queued
  })
  const request = { operationId: WorkstreamOperationId(operationId), targetId: member.id, text: 'Hello', signal }
  const sending = ctx.workstreams.sendMessage(owner, owner.id, request)
  await flushEntered.promise
  toolRelease.resolve()
  await childQueued.promise
  const draining = ctx.subagents.drainChildren(owner, [member.id])
  const release = (): void => { toolRelease.resolve(); flushRelease.resolve() }
  return { ctx, owner, member, sending, draining, request, release }
}

async function within<T>(work: Promise<T>, ms: number): Promise<T | 'deadlocked'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<'deadlocked'>((resolve) => { timer = setTimeout(() => { resolve('deadlocked') }, ms) })])
  } finally { clearTimeout(timer) }
}

describe('round-5 queue-held waits', () => {
  it('R5-M1 sendMessage settles when its recipient closes while the recipient\'s Workstream tool waits for the queue', async () => {
    const { owner, sending, draining, release, ctx } = await sendToClosingMember('to-worker')
    try {
      release()
      const outcome = await within(sending, 1500)
      expect(outcome, 'delivery must not wait on a closing recipient while holding the root queue it needs').not.toBe('deadlocked')
      expect(outcome).toMatchObject({ operationId: 'to-worker', delivery: { phase: 'accepted' } })
      expect(ctx.workstreams.get(owner, owner.id).messages.find(m => m.operationId === 'to-worker')?.delivery.phase).toBe('accepted')
    } finally { release(); await Promise.allSettled([sending, draining]) }
  })

  it('R5-M1 a same-operation retry joins the delivery that is still running instead of reporting it unknown', async () => {
    const { sending, draining, release, ctx, owner, request } = await sendToClosingMember('to-worker')
    try {
      const retry = ctx.workstreams.sendMessage(owner, owner.id, request)
      release()
      const [first, second] = await within(Promise.all([sending, retry]), 1500) as readonly [unknown, unknown]
      expect(second).toEqual(first)
      expect(second).toMatchObject({ delivery: { phase: 'accepted' } })
    } finally { release(); await Promise.allSettled([sending, draining]) }
  })

  it('R5-M1 stop lets a running delivery to the member finish, so the delivery cannot resume the member after the drain', async () => {
    const { ctx, owner, member, sending, draining, release } = await sendToClosingMember('to-worker')
    try {
      // The coordinator stops the recipient while its message is still being delivered.
      const stopping = ctx.workstreams.stop(owner, owner.id, member.id)
      release()
      const outcome = await within(Promise.all([sending, stopping]), 3000)
      expect(outcome, 'stop and the running delivery must both settle').not.toBe('deadlocked')
      expect(ctx.workstreams.get(owner, owner.id).members.find(m => m.id === member.id)?.phase).toBe('stopped')
      expect(ctx.agents.get(member.id), 'a stopped member must not be resident again after the delivery').toBeUndefined()
    } finally { release(); await Promise.allSettled([sending, draining]) }
  })
})

describe('round-5 documentation matches the code', () => {
  it('R5-N7 passes the owner, not the previous coordinator, as the handing-off actor, and the README says so', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    const dir = mkdtempSync(join(tmpdir(), 'workstream-r5-doc-'))
    directories.push(dir)
    await ctx.plugin(JsonlSessionPersistence, { root: dir })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await ctx.plugin(TicketService)
    await ctx.plugin(WorkstreamService)
    ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => 'hang' as const)))
    const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
    await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Docs' })
    const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('create-worker'),
      name: 'worker', description: 'worker responsibility', provider: 'spawn', prompt: 'Work', signal })
    await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Move me', description: '' })
    const handoff = vi.spyOn(ctx.tickets, 'handoff')
    const { revision } = ctx.workstreams.get(owner, owner.id)
    await ctx.workstreams.handoff(owner, owner.id, { expectedRevision: revision, coordinatorId: member.id })
    expect(handoff).toHaveBeenCalledTimes(1)
    expect(handoff.mock.calls[0]?.[1]).toMatchObject({ actorId: owner.id })

    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    expect(readme).not.toContain('previous coordinator as the handing-off actor')
    expect(readme).not.toContain('passes that coordinator as the handing-off actor')
    expect(readme).not.toContain('The package has no browser supervision UI')
    expect(readme).not.toContain('Every mutating operation takes a caller-chosen')
  })
})
