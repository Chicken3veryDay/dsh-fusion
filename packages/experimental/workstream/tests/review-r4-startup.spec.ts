/** Round-4 regressions: standalone creation, resume, and the retryable loading diagnostic. */
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
import TicketService, { TicketTools } from '@deepseek-ai/dsh-experimental-ticket'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
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
  const dir = mkdtempSync(join(tmpdir(), 'workstream-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner, fiber, sessionDir: dir }
}

it('R4-C2: even a Session without a Workstream gets a wrapped loading refusal, then creates normally', async () => {
  const { ctx, fiber } = await setup()
  const standalone = await ctx.agentLoop.create(SessionId('standalone'), { provider: 'mock', model: 'mock' })
  expect(ctx.workstreams.list(standalone)).toEqual([])
  await fiber.dispose()
  const reloading = ctx.plugin(WorkstreamService)
  const creation = ctx.agents.withInitiator(standalone, () => ctx.tickets.create(standalone.session,
    { subject: 'Standalone task during HMR', description: '' }))
  const [, outcome] = await Promise.all([reloading, creation.then(ticket => ({ ticket }), (error: unknown) => ({ error }))])
  expect(outcome).toMatchObject({ error: { code: 'TICKET_COORDINATOR_UNAVAILABLE',
    cause: { code: 'WORKSTREAM_NOT_READY', message: 'Workstream is still loading; retry the Ticket creation' } } })
  expect(ctx.tickets.list(standalone.session)).toEqual([])
  expect(ctx.workstreams.list(standalone)).toEqual([])
  const ticket = await ctx.agents.withInitiator(standalone, () => ctx.tickets.create(standalone.session,
    { subject: 'Standalone retry', description: '' }))
  expect(ticket.coordinatorId).toBe(standalone.id)
})

it('R4-C3: a resumed root can create owner-default Tickets once Workstream load finishes', async () => {
  const { ctx, fiber } = await setup()
  const id = SessionId('resumable-root')
  const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  await ctx.workstreams.open(handle.agent, { operationId: WorkstreamOperationId('resumable'), title: 'Resumable' })
  await fiber.dispose()
  await handle.dispose()
  await ctx.plugin(WorkstreamService)
  const { agent: resumed } = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  expect(ctx.workstreams.get(resumed, id).coordinatorId).toBe(id)
  const ticket = await ctx.agents.withInitiator(resumed, () => ctx.tickets.create(resumed.session,
    { subject: 'Resumed root task', description: '' }))
  expect(ticket.coordinatorId).toBe(id)
})

it('R4-N1: ticket_create reports that a transient Workstream loading refusal can be retried', async () => {
  const { ctx, fiber } = await setup()
  const standalone = await ctx.agentLoop.create(SessionId('standalone'), { provider: 'mock', model: 'mock' })
  await ctx.plugin(TicketTools)
  const create = ctx.tools.get('ticket_create')
  if (create === undefined) throw new Error('ticket_create is not mounted')
  await fiber.dispose()
  const reloading = ctx.plugin(WorkstreamService)
  // These are the only execution fields this body reads; the production error formatter uses Error.message.
  const exec = { agent: standalone, signal } as ToolRunContext
  const creating = create.execute({ subject: 'During reload', description: '' }, exec)
  const [, outcome] = await Promise.all([reloading, creating.then(ticket => ({ ticket }), (error: unknown) => ({ error }))])
  expect(outcome).toMatchObject({ error: { code: 'TICKET_COORDINATOR_UNAVAILABLE', cause: { code: 'WORKSTREAM_NOT_READY' } } })
  expect(ctx.tickets.list(standalone.session)).toEqual([])
  if (!('error' in outcome) || !(outcome.error instanceof Error)) throw new Error('Expected the loading refusal')
  expect(outcome.error.message, 'the public Ticket tool diagnostic must retain the actionable loading/retry explanation')
    .toMatch(/loading|retry/iu)
})
