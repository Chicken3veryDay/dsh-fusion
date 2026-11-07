/** Round-7 review: replacing an attempt's own unsent nodes must not start a request series. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
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

/** Turn 1 declares `probe`; from `revokeFromTurn` a request-context publisher revokes it on the first attempt. */
async function harness(revokeFromTurn = 2) {
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
  adapter.toolUpdate = 'in-history'
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('review-r7-series'), { provider: 'mock', model: 'model' })
  ctx.tools.register(tool('probe'))
  ctx.tools.registerAdmissionPolicy(({ agent: subject, candidates }) =>
    subject.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === REVOKE))
      ? [] : candidates.keys())
  let turns = 0
  ctx.on('system-prompt/request-context', async (_context, pending, next) =>
    [...await next(), ...pending.length > 0 && ++turns >= revokeFromTurn ? [revocation()] : []])
  return { ctx, adapter, agent }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** What the second request carries and how its header was logged. */
function secondRequest(h: Awaited<ReturnType<typeof harness>>) {
  const request = h.adapter.requests[1]
  const headers = h.agent.session.snapshotEvents().filter(event => event.type === 'request/header')
  const last = headers.at(-1)
  return {
    turnEnd: h.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason,
    declared: (request?.tools ?? []).map(schema => schema.name),
    removalNotice: (request?.messages ?? []).some(message => message.role === 'developer'
      && message.content.some(block => block.type === 'tool-removal' && block.toolName === 'probe')),
    header: last?.type === 'request/header' ? { reason: last.data.reason, startsSeries: last.data.startsSeries === true } : undefined,
  }
}

// The previous request's prefix is intact in every case below: only a node committed in the same attempt,
// which no request has carried, is rewritten. A continuing series on an in-history tool route keeps the
// series baseline declaration (`probe`) and withdraws it with a logged tool-removal block.
const continuing = {
  turnEnd: { kind: 'completed' },
  declared: ['probe'],
  removalNotice: true,
  header: { reason: 'change', startsSeries: false },
}

it('control: a static runtime fact keeps the tool declaration prefix when admission revokes a tool', async () => {
  const h = await harness()
  h.ctx.systemPrompt.context({ name: 'static-fact', order: 0, text: 'Static fact.' })
  await send(h.agent, 'first')
  await send(h.agent, 'second')
  expect(secondRequest(h)).toEqual(continuing)
})

it('keeps the tool declaration prefix when reconciliation replaces the attempt\'s unsent runtime snapshot', async () => {
  const h = await harness()
  // The r6 Major 1 provider: documented as read at assembly and admission refresh; nothing reads it for admission.
  h.ctx.systemPrompt.context({ name: 'history-size', order: 0, text: ({ agent }) =>
    agent === undefined ? '' : `Messages so far: ${agent.session.deriveMessages().length}.` })
  await send(h.agent, 'first')
  await send(h.agent, 'second')
  expect(secondRequest(h)).toEqual(continuing)
})

it('keeps the tool declaration prefix when reconciliation replaces the attempt\'s unsent in-history prompt', async () => {
  const h = await harness()
  h.adapter.systemPromptUpdate = 'in-history'
  let revision = 'initial'
  h.ctx.systemPrompt.section({ name: 'admission-guidance', order: 0, complete: true,
    text: ({ agent, toolSet }) => `${revision}: probe ${h.ctx.tools.get('probe', agent, toolSet) === undefined ? 'disabled' : 'enabled'}` })
  await send(h.agent, 'first')
  revision = 'updated'
  await send(h.agent, 'second')
  expect(secondRequest(h)).toEqual(continuing)
})

it('does not mark every request as a new series when only a history-dependent runtime fact changes', async () => {
  // No revocation: the tool set and prompt are identical on both turns; only the runtime fact changes.
  const h = await harness(Number.POSITIVE_INFINITY)
  h.ctx.systemPrompt.context({ name: 'history-size', order: 0, text: ({ agent }) =>
    agent === undefined ? '' : `Messages so far: ${agent.session.deriveMessages().length}.` })
  await send(h.agent, 'first')
  await send(h.agent, 'second')
  const headers = h.agent.session.snapshotEvents().flatMap(event => event.type === 'request/header'
    ? [{ reason: event.data.reason, startsSeries: event.data.startsSeries === true }] : [])
  expect({ requests: h.adapter.requests.length, laterHeaders: headers.slice(1) }).toEqual({ requests: 2, laterHeaders: [] })
})
