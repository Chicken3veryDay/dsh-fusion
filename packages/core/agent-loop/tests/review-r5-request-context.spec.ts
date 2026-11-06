/** Admission uses committed request history and bounds context reconciliation before dispatch. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

const REVOKE = 'revoke probe'
const snapshotText = (text: string): string => `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${text}`
const revocation = (): UserMessage => createUserMessage({ content: [{ type: 'text', text: REVOKE }], source: { kind: 'user' } })
const carriesRevocation = (messages: readonly { content: readonly { type: string; text?: string }[] }[] | undefined): boolean =>
  messages?.some(message => message.content.some(block => block.type === 'text' && (block.text === REVOKE || block.text === snapshotText(REVOKE)))) === true

async function harness(adapter = new MockAdapter([textResponse('first'), toolCallResponse('call-1', 'probe', {}), textResponse('done')])) {
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
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('review-r5-request-context'), { provider: 'mock', model: 'model' })
  const calls: string[] = []
  ctx.tools.register(defineTool({
    name: 'probe', description: 'Test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push('probe'); return 'done' },
  }))
  const policy = ctx.tools.registerAdmissionPolicy(({ agent: subject, candidates }) =>
    carriesRevocation(subject.session.deriveMessages()) ? [] : candidates.keys())
  return { ctx, adapter, agent, calls, policy }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

it.each(['request-context', 'pre-step'] as const)(
  'withdraws a tool when a %s publisher adds a revocation to the outgoing request',
  async (route) => {
    const h = await harness()
    await send(h.agent, 'first')
    let armed = true
    if (route === 'request-context') {
      h.ctx.on('system-prompt/request-context', async (_context, _pending, next) => {
        const messages = await next()
        if (!armed) return messages
        armed = false
        return [...messages, revocation()]
      })
    } else {
      // A pre-step listener that adds context after delegating, as context-tree does for its catalog.
      h.ctx.on('agent/pre-step', async (_event, next): Promise<PreStepDecision> => {
        const decision = await next()
        if (decision.kind === 'reject' || !armed) return decision
        armed = false
        return { ...decision, messages: [...decision.messages, revocation()] }
      })
    }
    await send(h.agent, 'second')
    // Control: the revocation is durable and reaches the model in the same request.
    expect(carriesRevocation(h.adapter.requests[1]?.messages)).toBe(true)
    expect(h.agent.session.snapshotEvents().some(event => event.type === 'user/message' && carriesRevocation([event.data]))).toBe(true)
    expect({ declarations: h.adapter.requests[1]?.tools?.map(tool => tool.name) ?? [], calls: h.calls })
      .toEqual({ declarations: [], calls: [] })
  },
)

it('control: the same policy withdraws the tool when agent/request appends the revocation', async () => {
  const h = await harness()
  await send(h.agent, 'first')
  let armed = true
  h.ctx.on('agent/request', async (_event, next) => {
    if (armed) {
      armed = false
      h.agent.session.append('user/message', revocation(), { surfaceOp: 'append' })
    }
    return next()
  })
  await send(h.agent, 'second')
  expect({ declarations: h.adapter.requests[1]?.tools?.map(tool => tool.name) ?? [], calls: h.calls })
    .toEqual({ declarations: [], calls: [] })
})


it.each(['claimed', 'request-context', 'pre-step', 'runtime-context'] as const)(
  'admits the first attempt after the %s revocation is committed', async (route) => {
    const adapter = new MockAdapter([toolCallResponse('denied', 'probe', {}), textResponse('done')])
    const h = await harness(adapter)
    if (route === 'request-context') h.ctx.on('system-prompt/request-context', async (_context, pending, next) =>
      [...await next(), ...pending.length > 0 ? [revocation()] : []])
    if (route === 'runtime-context') h.ctx.systemPrompt.context({ name: 'revocation', order: 0, text: REVOKE })
    if (route === 'pre-step') h.ctx.on('agent/pre-step', async (_event, next): Promise<PreStepDecision> => {
      const result = await next()
      return result.kind === 'reject' ? result : { ...result, messages: [...result.messages, revocation()] }
    })
    await send(h.agent, route === 'claimed' ? REVOKE : 'first')
    expect(carriesRevocation(adapter.requests[0]?.messages)).toBe(true)
    expect({ declarations: adapter.requests[0]?.tools ?? [], calls: h.calls }).toEqual({ declarations: [], calls: [] })
  },
)

it('commits retry context before admission without reclaiming or duplicating accepted input', async () => {
  const adapter = new MockAdapter([
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSIENT', message: 'try again' } } }],
    toolCallResponse('denied', 'probe', {}), textResponse('done'),
  ])
  const h = await harness(adapter)
  let claims = 0
  let publications = 0
  const pendingLengths: number[] = []
  h.ctx.on('agent/pre-step', (_event, next) => { claims++; return next() })
  h.ctx.on('system-prompt/request-context', async (_context, pending, next) => {
    publications++
    pendingLengths.push(pending.length)
    return [...await next(), ...publications === 2 ? [revocation()] : []]
  })
  h.ctx.on('agent/request-error', async () => ({ kind: 'retry' }))
  const resolved = vi.spyOn(h.ctx.tools, 'resolve')
  h.ctx.on('llm/stream', (request, next) => {
    expect(request.messages).toEqual(Session.create(h.agent.id, h.agent.session.snapshotEvents()).deriveMessages())
    return next()
  })
  await send(h.agent, 'first')
  expect(carriesRevocation(adapter.requests[0]?.messages)).toBe(false)
  expect(carriesRevocation(adapter.requests[1]?.messages)).toBe(true)
  expect(adapter.requests[1]?.tools ?? []).toEqual([])
  expect(h.calls).toEqual([])
  expect(claims).toBe(2)
  expect(publications).toBe(3)
  expect(pendingLengths).toEqual([1, 0, 0])
  expect(resolved).toHaveBeenCalledTimes(claims + adapter.requests.length)
  expect(h.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.content.some(block =>
    block.type === 'text' && block.text === 'first'))).toHaveLength(1)
})

it.each(['stable', 'oscillating'] as const)('bounds %s admission-dependent runtime context to one reconciliation', async (mode) => {
  const h = await harness(new MockAdapter([textResponse('done')]))
  h.policy()
  let evaluations = 0
  let assemblies = 0
  h.ctx.tools.registerAdmissionPolicy(({ agent, candidates }) => {
    evaluations++
    const latest = agent.session.deriveMessages().findLast(message => message.role === 'user'
      && message.source.kind === 'runtime-context')
    const enabled = latest?.content.some(block => block.type === 'text' && block.text === snapshotText('probe enabled')) === true
    return mode === 'stable' ? candidates.keys() : enabled ? [] : candidates.keys()
  })
  h.ctx.systemPrompt.context({ name: 'admission-fact', order: 0, text: ({ agent, toolSet }) =>
    h.ctx.tools.get('probe', agent, toolSet) === undefined ? 'probe disabled' : 'probe enabled' })
  h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { assemblies++; return next() })
  const disposals: number[] = []
  const resolve = h.ctx.tools.resolve.bind(h.ctx.tools)
  const resolved = vi.spyOn(h.ctx.tools, 'resolve').mockImplementation(async (input) => {
    const selected = await resolve(input)
    const index = disposals.push(0) - 1
    return { ...selected, dispose() { disposals[index] = (disposals[index] ?? 0) + 1; selected.dispose() } }
  })
  await send(h.agent, 'first')
  expect(resolved).toHaveBeenCalledTimes(2)
  expect(disposals).toEqual([1, 1])
  expect(assemblies).toBe(mode === 'stable' ? 1 : 2)
  expect(evaluations).toBe(mode === 'stable' ? 2 : 3)
  expect(h.adapter.requests).toHaveLength(mode === 'stable' ? 1 : 0)
  expect(h.agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: 'turn/end', data: { reason: mode === 'stable' ? { kind: 'completed' } : { kind: 'error', error: { code: 'TOOL_ADMISSION_FAILED' } } },
  })
})

it('validates a stable republished context without resolving or assembling again', async () => {
  const h = await harness(new MockAdapter([textResponse('done')]))
  h.ctx.systemPrompt.context({ name: 'admission-fact', order: 0, text: ({ agent, toolSet }) =>
    h.ctx.tools.get('probe', agent, toolSet) === undefined ? 'probe disabled' : 'probe enabled' })
  h.ctx.on('system-prompt/request-context', async (_context, _pending, next) => [...await next(), revocation()])
  const resolved = vi.spyOn(h.ctx.tools, 'resolve')
  const assemblies = vi.spyOn(h.ctx.systemPrompt, 'assemble')
  await send(h.agent, 'first')
  expect(resolved).toHaveBeenCalledTimes(2)
  expect(assemblies).toHaveBeenCalledTimes(2)
  expect(h.adapter.requests).toHaveLength(1)
  expect(h.adapter.requests[0]?.tools ?? []).toEqual([])
  expect(h.adapter.requests[0]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: snapshotText('probe disabled') }])
})


it('preserves the full request prefix and appends no unchanged system or runtime snapshot', async () => {
  const h = await harness(new MockAdapter([textResponse('first'), textResponse('second')]))
  h.ctx.systemPrompt.context({ name: 'stable-fact', order: 0, text: 'same context' })
  const resolved = vi.spyOn(h.ctx.tools, 'resolve')
  await send(h.agent, 'first')
  await send(h.agent, 'second')
  const first = h.adapter.requests[0]
  expect(first).toBeDefined()
  expect(h.adapter.requests[1]?.messages.slice(0, first?.messages.length)).toEqual(first?.messages)
  const events = h.agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'system/message')).toHaveLength(1)
  expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')).toHaveLength(1)
  expect(resolved).toHaveBeenCalledTimes(4)
})
