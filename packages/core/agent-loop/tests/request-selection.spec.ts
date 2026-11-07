/** Request preparation must keep tool declarations and dispatch consistent with retained history. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function harness() {
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
  const adapter = new MockAdapter([textResponse('first'), toolCallResponse('selected-call', 'probe', {}), textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('request-selection'), { provider: 'mock', model: 'model' })
  const calls: string[] = []
  const registration = ctx.tools.register(defineTool({
    name: 'probe', description: 'Test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls.push('probe'); return 'done' },
  }))
  return { ctx, adapter, agent, calls, registration }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function replaceFirstUser(agent: Agent) {
  const prior = agent.session.snapshotEvents().find(event => event.type === 'user/message')
  if (prior === undefined) throw new Error('missing first user')
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'replacement history' }], source: { kind: 'user' },
  }), { surfaceOp: { op: 'replace', startSeq: prior.seq, endSeq: prior.seq }, sourceEventSeqs: [prior.seq] })
}

class ScriptRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  resolve(request: PtcRunRequest) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  run(_request: PtcRunRequest): Promise<PtcRunResult> { return Promise.resolve({ logs: [] }) }
}

it.each(['dispose', 'restrict'] as const)('refreshes declarations when request preparation %ss the old registration and replaces history', async (mode) => {
  const h = await harness()
  await send(h.agent, 'first')
  let changed = false
  h.ctx.on('agent/request', async (_event, next) => {
    if (!changed) {
      changed = true
      if (mode === 'dispose') h.registration()
      else h.agent.ctx.tools.restrict({ deny: ['probe'] })
      replaceFirstUser(h.agent)
    }
    return next()
  })
  await send(h.agent, 'second')
  expect(h.calls).toEqual([])
  expect(h.adapter.requests[1]?.tools?.map(tool => tool.name) ?? []).toEqual([])
})

it('rechecks a history-based admission policy after request preparation appends a revocation', async () => {
  const h = await harness()
  h.ctx.tools.registerAdmissionPolicy(({ agent, candidates }) => {
    const revoked = agent.session.deriveMessages().some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === 'revoke probe'))
    return revoked ? [] : candidates.keys()
  })
  await send(h.agent, 'first')
  let changed = false
  h.ctx.on('agent/request', async (_event, next) => {
    if (!changed) {
      changed = true
      h.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'revoke probe' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    return next()
  })
  await send(h.agent, 'second')
  expect(h.adapter.requests[1]?.messages.some(message => message.content.some(block => block.type === 'text' && block.text === 'revoke probe'))).toBe(true)
  expect({ declarations: h.adapter.requests[1]?.tools?.map(tool => tool.name) ?? [], calls: h.calls })
    .toEqual({ declarations: [], calls: [] })
})

it('updates the declared transport when request preparation changes the executor without changing admission', async () => {
  const h = await harness()
  await h.ctx.plugin(ScriptRuntime)
  await send(h.agent, 'first')
  let changed = false
  h.ctx.on('agent/request', async (_event, next) => {
    if (!changed) {
      changed = true
      h.agent.ctx.tools.setExecutor(new PtcExecutor(h.ctx))
      replaceFirstUser(h.agent)
    }
    return next()
  })
  await send(h.agent, 'second')
  expect(h.calls).toEqual([])
  const result = h.agent.session.snapshotEvents().find(event => event.type === 'tool/result')
  expect(JSON.stringify(result)).toContain('only `run_code` is callable directly')
  expect(h.adapter.requests[1]?.tools?.map(tool => tool.name)).toEqual(['run_code'])
})

it.each(['abort-policy', 'throw-policy', 'abort-assembly', 'throw-assembly', 'same-admission'] as const)('balances every selection when history triggers %s reselection', async (path) => {
  const h = await harness()
  let changed = false
  const disposals: number[] = []
  const resolve = h.ctx.tools.resolve.bind(h.ctx.tools)
  vi.spyOn(h.ctx.tools, 'resolve').mockImplementation(async (input) => {
    const selected = await resolve(input)
    const index = disposals.push(0) - 1
    return { ...selected, dispose() { disposals[index] = (disposals[index] ?? 0) + 1; selected.dispose() } }
  })
  h.ctx.tools.registerAdmissionPolicy(({ candidates }) => {
    if (!changed || path === 'same-admission') return candidates.keys()
    if (path === 'abort-policy') h.agent.cancel({ kind: 'user' })
    if (path === 'throw-policy') throw new Error('reselection policy failure')
    return []
  })
  h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    if (changed && path === 'abort-assembly') h.agent.cancel({ kind: 'user' })
    if (changed && path === 'throw-assembly') throw new Error('reselection assembly failure')
    return assembly
  })
  await send(h.agent, 'first')
  h.ctx.on('agent/request', async (_event, next) => {
    if (!changed) { changed = true; replaceFirstUser(h.agent) }
    return next()
  })
  await send(h.agent, 'second')
  expect(disposals.every(count => count === 1)).toBe(true)
  const endings = h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)
  expect(endings).toEqual(['completed', path.startsWith('abort-') ? 'aborted' : path.startsWith('throw-') ? 'error' : 'completed'])
  expect(h.adapter.requests).toHaveLength(path === 'same-admission' ? 3 : 1)
})

it('preserves the typed admission failure code in the durable turn outcome', async () => {
  const h = await harness()
  h.ctx.tools.registerAdmissionPolicy(() => { throw new Error('policy store unavailable') })
  await send(h.agent, 'first')
  expect(h.adapter.requests).toEqual([])
  expect(h.calls).toEqual([])
  expect(h.agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TOOL_ADMISSION_FAILED' } } },
  })
})

it('reassembles the accepted prompt when rendered context changes without a Session replacement', async () => {
  const h = await harness()
  let fact = 'before'
  let claims = 0
  h.ctx.systemPrompt.context({ name: 'live-fact', order: 0, text: () => fact })
  h.ctx.systemPrompt.section({ name: 'fact-guidance', order: 0, complete: true, text: () => `Apply ${fact}.` })
  h.ctx.on('agent/pre-step', (_event, next) => { claims++; return next() })
  h.ctx.on('agent/request', async (_event, next) => { fact = 'after'; return next() })
  await send(h.agent, 'first')
  expect(h.adapter.requests[0]?.messages.filter(message => message.role === 'system').flatMap(message => message.content))
    .toEqual([{ type: 'text', text: 'Apply after.' }])
  expect(claims).toBe(1)
})

it('adopts fresh admission when the same definition is registered again during preparation', async () => {
  const h = await harness()
  await send(h.agent, 'first')
  let changed = false
  h.ctx.on('agent/request', async (_event, next) => {
    if (!changed) {
      changed = true
      h.registration()
      h.ctx.tools.register(h.registration.registration.definition)
    }
    return next()
  })
  await send(h.agent, 'second')
  expect(h.adapter.requests[1]?.tools?.map(tool => tool.name)).toEqual(['probe'])
  expect(h.calls).toEqual(['probe'])
})

it('fails the turn when history moves after the final admission check of the step\'s fresh attempt too', async () => {
  const h = await harness()
  const gates = Array.from({ length: 4 }, () => ({
    entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>(),
  }))
  let armed = false
  let calls = 0
  h.ctx.on('agent/request', (_event, next) => { armed = true; return next() })
  h.ctx.tools.registerAdmissionPolicy(async ({ candidates }) => {
    const gate = armed ? gates[calls++] : undefined
    if (gate !== undefined) { gate.entered.resolve(undefined); await gate.release.promise }
    return candidates.keys()
  })
  const running = send(h.agent, 'first')
  for (const [index, gate] of gates.entries()) {
    await gate.entered.promise
    h.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `moved ${index}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    gate.release.resolve(undefined)
  }
  await running
  expect(calls).toBe(4)
  expect(h.adapter.requests).toEqual([])
  expect(h.calls).toEqual([])
  expect(h.agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TOOL_ADMISSION_FAILED' } } },
  })
})
