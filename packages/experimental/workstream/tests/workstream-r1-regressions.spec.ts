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

async function setup(maxSnapshotBytes?: number, script?: ConstructorParameters<typeof MockAdapter>[0]) {
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
  const fiber = await ctx.plugin(WorkstreamService, maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script ?? Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner, fiber }
}

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }
function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = () => { done() } })
  return { promise, resolve }
}

function request(name: string) {
  return { operationId: WorkstreamOperationId(`create-${name}`), name, description: `${name} responsibility`, provider:
    'spawn', prompt: `${name} initial`, signal }
}

describe('round-1 review regressions', () => {
  it('R5 hands off Tickets created while the handoff is moving earlier Tickets', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    const first = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'First', description: '' })
    const entered = deferred(), release = deferred()
    const handoff = ctx.tickets.handoff.bind(ctx.tickets)
    vi.spyOn(ctx.tickets, 'handoff').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return handoff(...args)
    })
    const move = ctx.workstreams.handoff(owner, owner.id, { expectedRevision: ctx.workstreams.get(owner, owner.id).revision,
      coordinatorId: member.id })
    try {
      await entered.promise
      // This is also the direct ticket_create tool's call, enabled by the profile.
      const late = await ctx.tickets.create(owner.session, { subject: 'Created during handoff', description: '', coordinatorId: owner.id })
      release.resolve()
      await move
      expect(ctx.tickets.get(owner.session, first.id).coordinatorId).toBe(member.id)
      expect(ctx.workstreams.get(owner, owner.id).coordinatorId).toBe(member.id)
      expect(ctx.tickets.get(owner.session, late.id).coordinatorId).toBe(member.id)
    } finally { release.resolve(); await Promise.allSettled([move]) }
  })

  it('R6 preflights the final snapshot limit before moving Ticket authority', async () => {
    const limit = 4096
    const { ctx, owner } = await setup(limit)
    const member = await ctx.workstreams.addMember(owner, owner.id, request('coordinator'))
    const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'First', description: '' })
    const initial = ctx.workstreams.get(owner, owner.id)
    const operationId = WorkstreamOperationId('fill-snapshot')
    const intent = { operationId, senderId: owner.id, targetId: member.id, text: '', context: null,
      diagnostic: 'Inbox acceptance is not yet confirmed; retry the same operation to reconcile', delivery: { phase: 'intent' } }
    const overhead = Buffer.byteLength(JSON.stringify({ ...initial, revision: initial.revision + 1, messages: [intent] }))
    await ctx.workstreams.sendMessage(owner, owner.id, { operationId, targetId: member.id, text: 'x'.repeat(limit - overhead), signal })
    const before = ctx.workstreams.get(owner, owner.id)
    expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThanOrEqual(limit)
    await expect(ctx.workstreams.handoff(owner, owner.id, { expectedRevision: before.revision, coordinatorId: member.id }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_LIMIT' })
    expect(ctx.workstreams.get(owner, owner.id).coordinatorId).toBe(owner.id)
    expect(ctx.tickets.get(owner.session, ticket.id).coordinatorId).toBe(owner.id)
  })

  it('R7 stops a child whose Workstream tool queued during the stopping-state flush', async () => {
    const { ctx, owner } = await setup(undefined, [toolCallResponse('child-send', 'workstream_send', {
      root_session_id: 'owner', operation_id: 'stopping-send', target_id: 'owner', text: 'Final update',
    }), 'hang'])
    await ctx.plugin(WorkstreamTools)
    const toolEntered = deferred(), toolRelease = deferred()
    const flushEntered = deferred(), flushRelease = deferred()
    const sendQueued = deferred(), drainEntered = deferred()
    const rescue = deferred()
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name === 'workstream_send') { toolEntered.resolve(); await toolRelease.promise }
      return next()
    })
    const member = await ctx.workstreams.addMember(owner, owner.id, request('stopping-worker'))
    await toolEntered.promise
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let held = false
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!held && session === owner.session && ctx.workstreams.get(owner, owner.id).members.some(m => m.phase === 'stopping')) {
        held = true; flushEntered.resolve(); await flushRelease.promise
      }
      return flush(session)
    })
    const send = ctx.workstreams.sendMessage.bind(ctx.workstreams)
    vi.spyOn(ctx.workstreams, 'sendMessage').mockImplementation((...args) => {
      const queued = send(...args); sendQueued.resolve(); return queued
    })
    const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
    let realDrain: Promise<void> | undefined
    vi.spyOn(ctx.subagents, 'drainChildren').mockImplementationOnce(async (...args) => {
      realDrain = drain(...args); drainEntered.resolve()
      // Release only in finally after observing the hang, to avoid leaking the test's deadlocked child.
      await Promise.race([realDrain, rescue.promise])
    })
    const stopping = ctx.workstreams.stop(owner, owner.id, member.id)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await flushEntered.promise
      toolRelease.resolve()
      await sendQueued.promise
      flushRelease.resolve()
      await drainEntered.promise
      const outcome = await Promise.race([
        stopping.then(() => 'settled'),
        new Promise<string>((resolve) => { timer = setTimeout(() => { resolve('deadlocked') }, 1000) }),
      ])
      expect(outcome).toBe('settled')
    } finally {
      clearTimeout(timer); toolRelease.resolve(); flushRelease.resolve(); rescue.resolve()
      await stopping
      await realDrain
    }
  })

})
