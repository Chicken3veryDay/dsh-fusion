/** Round-11 probes use the executor and durable Agent log, and count wait-owned resources after settlement. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'
import { WorkstreamTools } from '../src/tools.ts'

const contexts: Context[] = []
const directories: string[] = []
const live = new AbortController().signal

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'review-r11-wait-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  await ctx.plugin(WorkstreamTools)
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  const snapshot = await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Wait results' })
  const cursor = ctx.workstreams.cursor(owner, owner.id)
  const request = { afterRevision: snapshot.revision, afterCursor: cursor, timeoutMs: 60_000, signal: live }
  const args = { root_session_id: owner.id, after_revision: snapshot.revision, after_cursor: cursor, timeout_ms: 60_000 }
  return { ctx, owner, fiber, request, args }
}

it.each(['revision', 'ticket', 'none'] as const)('R11 aborted executor call never returns an observation with %s already visible', async (change) => {
  const { ctx, owner, args } = await setup()
  if (change === 'revision') await ctx.workstreams.handoff(owner, owner.id, { expectedRevision: args.after_revision, coordinatorId: owner.id })
  if (change === 'ticket') await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Visible change', description: '' })
  const controller = new AbortController()
  controller.abort(new Error('R11 already cancelled'))
  const result = await executeModelToolFixture(ctx, { agent: owner, signal: controller.signal, name: 'workstream_wait',
    callId: ToolCallId('cancelled'), arguments: args })
  expect(result.isError).toBe(true)
  expect(result.content).toEqual([{ type: 'text', text: 'Error: tool call aborted before dispatch' }])
  expect(result.error?.info?.code).toBe('ABORTED_BEFORE_DISPATCH')
  if (change !== 'none') {
    const control = await executeModelToolFixture(ctx, { agent: owner, signal: live, name: 'workstream_wait',
      callId: ToolCallId('live-control'), arguments: args })
    expect(control.isError).toBe(false)
    expect(control.value).toEqual({ timedOut: false, revision: ctx.workstreams.get(owner, owner.id).revision, cursor: owner.session.seq })
  }
})

it('R11 non-Error cancellation has the same typed failure before and during a wait', async () => {
  const { ctx, owner, request } = await setup()
  const before = new AbortController()
  before.abort('reason')
  await expect(ctx.workstreams.waitForChange(owner, owner.id, { ...request, signal: before.signal }))
    .rejects.toMatchObject({ code: 'WORKSTREAM_DISPOSED', message: 'Workstream wait was cancelled' })
  const during = new AbortController()
  const pending = ctx.workstreams.waitForChange(owner, owner.id, { ...request, signal: during.signal })
  const rejection = expect(pending).rejects.toMatchObject({ code: 'WORKSTREAM_DISPOSED', message: 'Workstream wait was cancelled' })
  during.abort('reason')
  await rejection
})

it.each(['abort', 'timeout', 'change', 'unload'] as const)('R11 %s removes the pending wait listener and timer', async (outcome) => {
  const { ctx, owner, fiber, request } = await setup()
  const baseline = ctx.events._hooks['session/event']?.length ?? 0
  const controller = new AbortController()
  // Fake only the wait's timer; persistence and Cordis continue on their real scheduling primitives.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const waiting = ctx.workstreams.waitForChange(owner, owner.id, { ...request, signal: controller.signal })
  const settled = waiting.then(value => ({ value }), (error: unknown) => ({ error: error as Error }))
  expect(ctx.events._hooks['session/event']?.length).toBe(baseline + 1)
  expect(vi.getTimerCount()).toBe(1)
  const reason = new Error('R11 cancelled during wait')
  if (outcome === 'abort') controller.abort(reason)
  if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(request.timeoutMs)
  if (outcome === 'change') await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Wake', description: '' })
  if (outcome === 'unload') await fiber.dispose()
  const result = await settled
  if (outcome === 'abort') expect(result).toEqual({ error: reason })
  if (outcome === 'unload') expect(result).toMatchObject({ error: { code: 'WORKSTREAM_DISPOSED' } })
  if (outcome === 'change' || outcome === 'timeout') expect(result).toEqual({ value: {
    timedOut: outcome === 'timeout', revision: request.afterRevision, cursor: owner.session.seq,
  } })
  expect(vi.getTimerCount()).toBe(0)
  expect(ctx.events._hooks['session/event']?.length ?? 0).toBeLessThanOrEqual(baseline)
  vi.useRealTimers()
  controller.abort(new Error('R11 late cancellation'))
  if (outcome !== 'unload') await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Late event', description: '' })
})

it.each(['change', 'timeout', 'cancel', 'unload', 'change-then-cancel'] as const)('R11 the real Agent logs the %s wait result and projects it into the next request', async (outcome) => {
  const { ctx, owner, fiber, args } = await setup()
  const service = ctx.workstreams
  const entered = Promise.withResolvers<undefined>()
  const original = service.waitForChange.bind(service)
  vi.spyOn(service, 'waitForChange').mockImplementation((...input) => {
    const pending = original(...input)
    entered.resolve(undefined)
    return outcome === 'change-then-cancel' ? pending.then((value) => { owner.cancel({ kind: 'user' }); return value }) : pending
  })
  const mock = new MockAdapter([
    toolCallResponse('R11-wait', 'workstream_wait', { ...args, timeout_ms: outcome === 'timeout' ? 1_000 : 60_000 }),
    textResponse('observed'),
    textResponse('observed on next turn'),
  ])
  ctx.llm.registerAdapter(['mock'], mock)
  owner.followup(createUserMessage({ content: [{ type: 'text', text: 'Observe the Workstream' }], source: { kind: 'user' } }))
  await entered.promise
  if (outcome === 'change' || outcome === 'change-then-cancel') await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Model wait wake', description: '' })
  if (outcome === 'cancel') owner.cancel({ kind: 'user' })
  if (outcome === 'unload') await fiber.dispose()
  await owner.whenIdle()
  const events = owner.session.snapshotEvents()
  const results = events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === ToolCallId('R11-wait'))
  expect(results).toHaveLength(1)
  const result = results[0]!
  if (result.type !== 'tool/result') throw new Error('Expected tool result')
  const text = result.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')
  if (outcome === 'change' || outcome === 'timeout') {
    expect(result.data.message.isError).toBe(false)
    const parsed: unknown = JSON.parse(text)
    const anyNumber: unknown = expect.any(Number)
    expect(parsed).toMatchObject({ timedOut: outcome === 'timeout', revision: args.after_revision, cursor: anyNumber })
  } else {
    expect(result.data.message.isError).toBe(true)
    expect(text).toMatch(/^Error: /)
    expect(text).not.toContain('timedOut')
    if (outcome === 'unload') expect(text).toContain('Workstream service is stopping')
    if (outcome === 'change-then-cancel') expect(text).toBe('Error: tool call aborted')
  }
  await ctx.sessions.flush(owner.session)
  const handle = await ctx.sessionPersistence.open(owner.id, 'read')
  try {
    const persisted = (await handle.read(0)).events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === ToolCallId('R11-wait'))
    expect(persisted).toEqual(results)
  } finally { await handle.close() }
  if (outcome === 'cancel' || outcome === 'change-then-cancel') {
    owner.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the interrupted result' }], source: { kind: 'user' } }))
    await owner.whenIdle()
  }
  expect(mock.requests.slice(1).some(request => request.messages.some(message => message.role === 'tool'
    && message.content.some(block => block.type === 'text' && block.text === text)))).toBe(true)
})
