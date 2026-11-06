/** Round-6 review: minor request-reconciliation side effects. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const REVOKE = 'revoke probe'
const revocation = (): UserMessage => createUserMessage({ content: [{ type: 'text', text: REVOKE }], source: { kind: 'user' } })
const tool = (name: string): ToolDefinition => defineTool({
  name, description: 'Test operation.', parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async () => 'done',
})

async function harness(revokeFromTurn = 1) {
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
  const adapter = new MockAdapter([textResponse('done'), textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('review-r6-minors'), { provider: 'mock', model: 'model' })
  ctx.tools.register(tool('probe'))
  ctx.tools.registerAdmissionPolicy(({ agent: subject, candidates }) =>
    subject.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === REVOKE))
      ? [] : candidates.keys())
  // From turn `revokeFromTurn`, a request-context publisher revokes `probe` on the first attempt, so admission reassembles.
  let turns = 0
  ctx.on('system-prompt/request-context', async (_context, pending, next) =>
    [...await next(), ...pending.length > 0 && ++turns >= revokeFromTurn ? [revocation()] : []])
  return { ctx, adapter, agent }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

it('sends one runtime-context snapshot for the admitted tool set, not a superseded pre-admission one', async () => {
  const h = await harness()
  h.ctx.systemPrompt.context({ name: 'admission-fact', order: 0, text: ({ agent, toolSet }) =>
    h.ctx.tools.get('probe', agent, toolSet) === undefined ? 'probe disabled' : 'probe enabled' })
  await send(h.agent, 'first')
  const snapshots = (h.adapter.requests[0]?.messages ?? [])
    .filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
    .map(message => message.content.map(block => block.type === 'text' ? block.text.split('\n').at(-1) : '').join(''))
  expect(snapshots).toEqual(['probe disabled'])
})

it('dispatches when an unrelated tool generation is swapped during reconciliation', async () => {
  // Turn 1 declares `probe`; turn 2 withdraws it through an `agent/request` revocation (a route both the
  // round-5 base and this commit admit), so the loop logs a tool-removal notice after admission and runs
  // the final-history validation.
  const h = await harness(Number.POSITIVE_INFINITY)
  await send(h.agent, 'first')
  h.ctx.on('agent/request', async (_event, next) => {
    h.agent.session.append('user/message', revocation(), { surfaceOp: 'append' })
    return next()
  })
  // Stands in for an MCP `tools/list_changed` refresh, which disposes and re-registers every tool of a server.
  let other = h.ctx.tools.register(tool('mcp__server__other'))
  let swapped = false
  h.ctx.on('system-prompt/assemble', async (_assembly, { agent, toolSet }, next) => {
    const assembly = await next()
    if (!swapped && toolSet !== undefined && h.ctx.tools.get('probe', agent, toolSet) === undefined) {
      swapped = true
      other()
      other = h.ctx.tools.register(tool('mcp__server__other'))
    }
    return assembly
  })
  await send(h.agent, 'second')
  expect(swapped).toBe(true)
  expect({
    requests: h.adapter.requests.length,
    turnEnd: h.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason,
  }).toEqual({ requests: 2, turnEnd: { kind: 'completed' } })
})


it('replaces only the unsent in-history prompt and preserves the previous request prefix', async () => {
  const h = await harness(2)
  h.adapter.systemPromptUpdate = 'in-history'
  h.adapter.toolUpdate = 'in-history'
  let revision = 'initial'
  h.ctx.systemPrompt.section({ name: 'admission-guidance', order: 0, complete: true,
    text: ({ agent, toolSet }) => `${revision}: probe ${h.ctx.tools.get('probe', agent, toolSet) === undefined ? 'disabled' : 'enabled'}` })
  h.ctx.on('llm/stream', (request, next) => {
    expect(request.messages).toEqual(Session.create(h.agent.id, h.agent.session.snapshotEvents()).deriveMessages())
    return next()
  })
  await send(h.agent, 'first')
  const prefix = h.adapter.requests[0]?.messages
  revision = 'updated'
  await send(h.agent, 'second')
  const request = h.adapter.requests[1]
  expect(request).toBeDefined()
  expect(request?.messages.slice(0, prefix?.length)).toEqual(prefix)
  expect(request?.messages.filter(message => message.role === 'system').map(message => message.content))
    .toEqual([[{ type: 'text', text: 'initial: probe enabled' }], [{ type: 'text', text: 'updated: probe disabled' }]])
  expect(request?.tools ?? []).toEqual([])
})
