/** A child's closing message after a `send_message` made from a `run_code` program, through the real loop and Node PTC runtime. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function settlementText(agent: Agent): string[] {
  const logged = agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data] : [])
  return [...logged, ...agent.inbox.nextStep, ...agent.inbox.nextTurn].flatMap(message => message.source.kind === 'subagent-settled'
    ? [message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')]
    : [])
}

it.each([
  ['reports', 'another nested call follows the message', (send: string) => `${send}; await tools.noop({})`, 'Its closing message:\nthe answer'],
  ['omits', 'the message is the program\'s last call', (send: string) => `await tools.noop({}); ${send}`,
    'It sent you a message just before finishing, so its closing message is omitted.'],
] as const)('%s the closing message when %s inside run_code', async (_verb, _case, program, ending) => {
  let childTurns = 0
  const respond = (options: GenerateOptions): StreamChunk[] => {
    const history = JSON.stringify(options.messages)
    if (!history.includes('Your parent agent id is')) return textResponse('parent ack')
    childTurns += 1
    if (childTurns > 1) return textResponse('the answer')
    const parentId = /Your parent agent id is \\"([^\\]+)\\"/.exec(history)![1]!
    const send = `await tools.send_message(${JSON.stringify({ agent_id: parentId, message: 'interim' })})`
    return toolCallResponse('program', 'run_code', { code: program(send), description: 'Report and continue' })
  }
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-run-code-'))
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'ptc' } })
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(NodeRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  if (ctx.get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry)
  await liveConfig(ctx, SubagentRuntime, {})
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentControl)
  ctx.tools.register(defineTool({
    name: 'noop', description: 'does nothing', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'noop' }] },
    execute: () => Promise.resolve({}),
  }))
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 6 }, () => respond)))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  const started = await ctx.subagents.startActivation({
    provider: 'spawn', label: 'child task', delivery: 'parent',
    request: { prompt: [{ type: 'text', text: 'child task' }], parent }, signal: new AbortController().signal,
  })
  await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() }, { timeout: 10_000 })
  await vi.waitFor(() => { expect(settlementText(parent)).toHaveLength(1) })
  expect(settlementText(parent)[0]).toBe(
    `Background subagent ${started.childId} finished and will do no further work unless you send it more.\n${ending}`,
  )
})
