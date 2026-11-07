/** `workstream_wait` inside a Node PTC `run_code` program: the program deadline bounds the wait and no wake is lost. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'
import { WorkstreamTools } from '../src/tools.ts'

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
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' } })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(FileSystem)
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(NodeRuntime)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-run-code-wait-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  await ctx.plugin(WorkstreamTools)
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  const snapshot = await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Run code wait' })
  const cursor = ctx.workstreams.cursor(owner, owner.id)
  const args = { root_session_id: owner.id, after_revision: snapshot.revision, after_cursor: cursor }
  const runCode = (code: string, extra: { timeoutMs?: number } = {}) => executeModelToolFixture(ctx, {
    agent: owner, signal: live, name: 'run_code', callId: ToolCallId(`run-code-${Math.random().toString(36).slice(2)}`),
    arguments: { code, description: 'Wait for a Workstream change', ...extra },
  })
  return { ctx, owner, args, runCode }
}

it('returns a wake committed while the program waits', async () => {
  const { ctx, owner, args, runCode } = await setup()
  const running = runCode(`return await tools.workstream_wait(${JSON.stringify({ ...args, timeout_ms: 60_000 })})`)
  // The program must be waiting before the change lands, or the test would only cover the immediate-return path.
  while (!owner.session.snapshotEvents().some(event => event.type === 'tool/ptc-dispatch-start')) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Wake', description: '' })
  const result = await running
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ result: { timedOut: false } })
})

it('keeps the wake durable when the program deadline ends the wait first', async () => {
  const { ctx, owner, args, runCode } = await setup()
  // A first program registers its one-time per-Agent runtime state; only listeners added after it can be the wait's.
  expect((await runCode('return 1')).isError).toBe(false)
  const baseline = ctx.events._hooks['session/event']?.length ?? 0
  const running = runCode(`return await tools.workstream_wait(${JSON.stringify({ ...args, timeout_ms: 60_000 })})`, { timeoutMs: 1_500 })
  while (!owner.session.snapshotEvents().some(event => event.type === 'tool/ptc-dispatch-start')) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const expired = await running
  expect(expired.isError).toBe(true)
  expect(expired.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('timeout') as string })
  // The wait is cancelled with the program: no listener or timer outlives it.
  expect(ctx.events._hooks['session/event']?.length ?? 0).toBeLessThanOrEqual(baseline)
  const settled = owner.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')
  expect(settled).toHaveLength(1)
  expect(settled[0]?.data).toMatchObject({ name: 'workstream_wait', isError: true })
  // A change that lands after the program died is still delivered by the next wait on the same cursor.
  await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Late wake', description: '' })
  const again = await runCode(`return await tools.workstream_wait(${JSON.stringify({ ...args, timeout_ms: 5_000 })})`)
  expect(again.isError).toBe(false)
  expect(again.value).toMatchObject({ result: { timedOut: false } })
})
