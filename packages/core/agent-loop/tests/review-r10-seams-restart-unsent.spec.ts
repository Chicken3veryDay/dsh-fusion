/** Round-10 review: an admission restart must treat the abandoned attempt's nodes as never sent. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const REVOKE = 'probe revoked'

async function harness(revokeExternally: boolean, callProbe = false) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(callProbe ? [toolCallResponse('c1', 'probe', {}), textResponse('done')] : [textResponse('done')])
  adapter.systemPromptUpdate = 'in-history'
  adapter.toolUpdate = 'in-history'
  ctx.llm.registerAdapter(['mock'], adapter)
  const calls: string[] = []
  const agent = await ctx.agentLoop.create(SessionId('review-r10-restart-unsent'), { provider: 'mock', model: 'model' })
  ctx.tools.register(defineTool({
    name: 'probe', description: 'Test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push('probe'); return 'done' },
  }))
  ctx.tools.registerAdmissionPolicy(({ agent: subject, candidates }) =>
    subject.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === REVOKE))
      ? [...candidates.keys()].filter(name => name !== 'probe') : candidates.keys())
  ctx.systemPrompt.section({ name: 'admission-guidance', order: 0, complete: true,
    text: ({ agent: subject, toolSet }) => `probe ${ctx.tools.get('probe', subject, toolSet) === undefined ? 'disabled' : 'enabled'}` })
  let appended: Promise<void> = Promise.resolve()
  if (revokeExternally) {
    const reached = Promise.withResolvers<undefined>()
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'request/context') reached.resolve(undefined)
    })
    // An external continuation queued on the first request/context commit appends after it, during the
    // attempt's final await, so the loop abandons that unsent attempt and restarts once.
    appended = reached.promise.then(() => {
      agent.session.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: REVOKE }],
      }), { surfaceOp: 'append' })
    })
  }
  return { ctx, adapter, agent, appended, calls }
}

async function send(agent: Agent) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }] }))
  await agent.whenIdle()
}

function firstRequest(h: Awaited<ReturnType<typeof harness>>) {
  const request = h.adapter.requests[0]
  return {
    requests: h.adapter.requests.length,
    declared: (request?.tools ?? []).map(tool => tool.name),
    system: (request?.messages ?? []).filter(message => message.role === 'system')
      .map(message => message.content.map(block => block.type === 'text' ? block.text : block.type).join('')),
    removalNotices: (request?.messages ?? []).filter(message => message.role === 'developer'
      && message.content.some(block => block.type === 'tool-removal')).length,
  }
}

it('restarted first request carries only the final prompt and no notice for a tool the model never saw', async () => {
  const h = await harness(true)
  await send(h.agent)
  await h.appended
  const revoked = h.adapter.requests[0]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text === REVOKE))
  expect(revoked, 'the restart was triggered: the request contains the revocation').toBe(true)
  // A Session's first request: no request carried the abandoned attempt's prompt or declared `probe`,
  // so the restarted attempt should replace that unsent head as the first attempt of the Session would.
  expect(firstRequest(h)).toEqual({ requests: 1, declared: [], system: ['probe disabled'], removalNotices: 0 })
})

it('control: without the late append the first request carries one prompt', async () => {
  const h = await harness(false)
  await send(h.agent)
  expect(firstRequest(h)).toEqual({ requests: 1, declared: ['probe'], system: ['probe enabled'], removalNotices: 0 })
})

it('a declared-but-revoked tool in the restarted request does not execute', async () => {
  const h = await harness(true, true)
  await send(h.agent)
  await h.appended
  const results = h.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  expect({ calls: h.calls, results: results.length }).toEqual({ calls: [], results: 1 })
})
