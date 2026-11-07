/** The `--json` stream of a real agent running a Node PTC `run_code` program with nested tool calls. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { projectJsonRun } from '../src/json-stream.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function stream(code: string): Promise<Record<string, unknown>[]> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'ptc' } })
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(NodeRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.tools.register(defineTool({
    name: 'echo', description: 'Echo a word.', parameters: { word: { type: 'string', required: true, description: 'Word.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(`echo ${args.word}`),
  }))
  ctx.tools.register(defineTool({
    name: 'boom', description: 'Always fails.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.reject(new Error('boom failed')),
  }))
  const agent = await ctx.agentLoop.create(SessionId('json-program'), { provider: 'mock', model: 'mock' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('program', 'run_code', { code, description: 'Call tools' }),
    textResponse('done'),
  ]))
  const lines: string[] = []
  const projection = projectJsonRun(ctx, agent, { write: (chunk: string) => { lines.push(chunk); return true } })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  projection.dispose()
  return lines.map(line => JSON.parse(line) as Record<string, unknown>)
}

it('emits each nested call as its own tool_call and tool_result tied to the program by parentCallId', async () => {
  const events = await stream("await tools.echo({ word: 'a' }); return await tools.echo({ word: 'b' })")
  const tools = events.filter(event => event.type === 'tool_call' || event.type === 'tool_result')
  expect(tools).toEqual([
    expect.objectContaining({ type: 'tool_call', callId: 'program', tool: 'run_code' }),
    { type: 'tool_call', callId: 'program:ptc:1', parentCallId: 'program', tool: 'echo', input: { word: 'a' } },
    { type: 'tool_result', callId: 'program:ptc:1', parentCallId: 'program', status: 'completed', result: 'echo a' },
    { type: 'tool_call', callId: 'program:ptc:2', parentCallId: 'program', tool: 'echo', input: { word: 'b' } },
    { type: 'tool_result', callId: 'program:ptc:2', parentCallId: 'program', status: 'completed', result: 'echo b' },
    expect.objectContaining({ type: 'tool_result', callId: 'program', status: 'completed' }),
  ])
  expect(tools[0]).not.toHaveProperty('parentCallId')
})

it('reports a failed nested call as an error result while the program call completes', async () => {
  const events = await stream("try { await tools.boom({}) } catch (error) { return 'caught' }")
  const nested = events.find(event => event.type === 'tool_result' && event.callId === 'program:ptc:1')
  expect(nested).toMatchObject({ parentCallId: 'program', status: 'error' })
  expect(String(nested?.result)).toContain('boom failed')
  expect(events.find(event => event.type === 'tool_result' && event.callId === 'program')).toMatchObject({ status: 'completed' })
})
