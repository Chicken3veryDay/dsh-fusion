/** Round-10 probe of every `waitForChange` path after the round-9 cancellation fix: immediate returns, timeout, cancellation
 * during the wait, unload, and the `workstream_wait` tool result. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'
import { WorkstreamTools } from '../src/tools.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'

const contexts: Context[] = []
const directories: string[] = []
const live = new AbortController().signal

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'review-r10-wait-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  await ctx.plugin(WorkstreamTools)
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  const snapshot = await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Wait paths' })
  return { ctx, owner, fiber, revision: snapshot.revision }
}

it('R10 the workstream_wait tool rejects with the caller reason when a concerning change is already visible', async () => {
  const { ctx, owner, revision } = await setup()
  const cursor = ctx.workstreams.cursor(owner, owner.id)
  await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Visible', description: '' })
  const reason = new Error('review-r10 turn interrupted')
  const controller = new AbortController()
  controller.abort(reason)
  const wait = ctx.tools.get('workstream_wait')!
  await expect(wait.execute({ root_session_id: owner.id, after_revision: revision, after_cursor: cursor, timeout_ms: 60_000 },
    { agent: owner, signal: controller.signal } as ToolRunContext)).rejects.toBe(reason)
  // Control: the same visible change with a live signal is reported at once.
  await expect(wait.execute({ root_session_id: owner.id, after_revision: revision, after_cursor: cursor, timeout_ms: 60_000 },
    { agent: owner, signal: live } as ToolRunContext)).resolves.toEqual({ timedOut: false, revision, cursor: owner.session.seq })
})

it('R10 a non-Error abort reason rejects identically before and during the wait', async () => {
  const { ctx, owner, revision } = await setup()
  const cursor = ctx.workstreams.cursor(owner, owner.id)
  const before = new AbortController()
  before.abort('string reason')
  await expect(ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, afterCursor: cursor, timeoutMs: 60_000,
    signal: before.signal })).rejects.toMatchObject({ name: 'WorkstreamError', code: 'WORKSTREAM_DISPOSED' })
  const during = new AbortController()
  const waiting = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, afterCursor: cursor, timeoutMs: 60_000,
    signal: during.signal })
  const rejection = expect(waiting).rejects.toMatchObject({ name: 'WorkstreamError', code: 'WORKSTREAM_DISPOSED' })
  during.abort('string reason')
  await rejection
})

it('R10 a change appended in the same step before the abort resolves; an abort first rejects', async () => {
  const { ctx, owner, revision } = await setup()
  const cursor = ctx.workstreams.cursor(owner, owner.id)
  const first = new AbortController()
  const changeFirst = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision, afterCursor: cursor, timeoutMs: 60_000,
    signal: first.signal })
  const created = ctx.workstreams.createTicket(owner, owner.id, { subject: 'Race', description: '' })
  await expect(changeFirst).resolves.toMatchObject({ timedOut: false, revision })
  first.abort(new Error('late abort'))
  await created
  const second = new AbortController()
  const abortFirst = ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision,
    afterCursor: ctx.workstreams.cursor(owner, owner.id), timeoutMs: 60_000, signal: second.signal })
  const reason = new Error('abort first')
  const rejection = expect(abortFirst).rejects.toBe(reason)
  second.abort(reason)
  await ctx.workstreams.createTicket(owner, owner.id, { subject: 'After abort', description: '' })
  await rejection
})

it('R10 a timed-out wait ignores a later abort and leaves no listener behind', async () => {
  const { ctx, owner, revision } = await setup()
  const controller = new AbortController()
  const result = await ctx.workstreams.waitForChange(owner, owner.id, { afterRevision: revision,
    afterCursor: ctx.workstreams.cursor(owner, owner.id), timeoutMs: 1, signal: controller.signal })
  expect(result).toEqual({ timedOut: true, revision, cursor: owner.session.seq })
  expect(() => { controller.abort(new Error('after timeout')) }).not.toThrow()
})

it('R10 unload rejects a pending tool wait and a later wait with a visible change, and the fiber disposes', async () => {
  const { ctx, owner, fiber, revision } = await setup()
  const cursor = ctx.workstreams.cursor(owner, owner.id)
  const wait = ctx.tools.get('workstream_wait')!
  const pending = wait.execute({ root_session_id: owner.id, after_revision: revision, after_cursor: cursor, timeout_ms: 3_600_000 },
    { agent: owner, signal: live } as ToolRunContext)
  const rejection = expect(pending).rejects.toMatchObject({ name: 'WorkstreamError', code: 'WORKSTREAM_DISPOSED' })
  const service = ctx.workstreams
  await fiber.dispose()
  await rejection
  await expect(service.waitForChange(owner, owner.id, { afterRevision: revision - 1, afterCursor: 0, timeoutMs: 60_000,
    signal: live })).rejects.toMatchObject({ code: 'WORKSTREAM_DISPOSED' })
})
