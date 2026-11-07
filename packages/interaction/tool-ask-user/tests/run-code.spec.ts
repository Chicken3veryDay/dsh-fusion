/** `ask_user_question` called from inside a Node PTC `run_code` program: answer, abort, and durable question state. */
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
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as ToolAskUser from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const PROGRAM = `
  const reply = await tools.ask_user_question({ questions: [{ id: 'mode', question: 'Which mode?', options: [{ label: 'fast' }, { label: 'safe' }] }] })
  return reply.answers[0].selected[0]`

async function boot(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'ptc' } })
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(NodeRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(ToolAskUser)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = await ctx.agentLoop.create(SessionId('ask-in-program'), { provider: 'mock', model: 'mock' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  return { ctx, agent }
}

function run(agent: Awaited<ReturnType<typeof boot>>['agent']): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }))
}

it('answers a question asked by a nested call and returns the choice to the program', async () => {
  const { ctx, agent } = await boot([
    toolCallResponse('program', 'run_code', { code: PROGRAM, description: 'Ask which mode' }),
    textResponse('done'),
  ])
  const asked = Promise.withResolvers<AskUserQuestionRequest>()
  ctx.on('user-questions/request', (request) => {
    asked.resolve(request)
    return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected: ['safe'] })) })
  })
  run(agent)
  await agent.whenIdle()

  const request = await asked.promise
  expect(request.agent).toBe(agent)
  expect(request.questions.map(question => question.id)).toEqual(['mode'])
  const events = agent.session.snapshotEvents()
  const result = events.find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('expected the run_code result')
  expect(result.data.message.isError).toBeFalsy()
  expect(JSON.stringify(result.data.message.content)).toContain('safe')
  const dispatch = events.find(event => event.type === 'tool/ptc-dispatch')
  if (dispatch?.type !== 'tool/ptc-dispatch') throw new Error('expected the nested dispatch')
  expect(dispatch.data).toMatchObject({ name: 'ask_user_question', parentCallId: result.data.message.toolCallId })
  expect(events.filter(event => event.type === 'tool/call').map(event => event.type === 'tool/call' ? event.data.name : ''))
    .toEqual(['run_code'])
})

it('aborts the pending question when the program is interrupted', async () => {
  const { ctx, agent } = await boot([
    toolCallResponse('program', 'run_code', { code: PROGRAM, description: 'Ask which mode' }),
  ])
  const aborted = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  ctx.on('user-questions/request', request => new Promise((_resolve, reject) => {
    entered.resolve(undefined)
    request.signal?.addEventListener('abort', () => { aborted.resolve(undefined); reject(new Error('aborted')) }, { once: true })
  }))
  run(agent)
  await entered.promise
  agent.cancel({ kind: 'user' })
  await aborted.promise
  await agent.whenIdle()

  const events = agent.session.snapshotEvents()
  const dispatch = events.find(event => event.type === 'tool/ptc-dispatch')
  expect(dispatch?.type === 'tool/ptc-dispatch' && dispatch.data.isError).toBe(true)
})
