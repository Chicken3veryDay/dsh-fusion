/** Runtime context is re-read in the same synchronous step that freezes the request. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('final-admission-context'), { provider: 'mock', model: 'model' })
  return { ctx, agent }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

const textOf = (message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
  message.content.map(block => block.text ?? '').join('')

/** The state line of the last runtime-context snapshot a message list carries. */
function lastState(messages: readonly Parameters<typeof textOf>[0][]): string | undefined {
  return messages.map(textOf).flatMap(text => text.split('\n').filter(line => line.startsWith('state='))).at(-1)
}

function loggedState(agent: Agent): string | undefined {
  const snapshots = agent.session.snapshotEvents().flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'runtime-context' ? [event.data] : [])
  return lastState(snapshots)
}

/**
 * A runtime context that reads `state`, and a tool registered after the first request whose activation predicate
 * changes `state` on its evaluations while request admission validates the registry notice's history change.
 * That validation is the last await before the request freezes.
 */
async function lateMutation(adapter: MockAdapter, mutations: number, declares: 'context' | 'section' | 'nothing' = 'context') {
  const { ctx, agent } = await harness(adapter)
  let state = 'initial'
  ctx.systemPrompt.context({
    name: 'test:state', order: 100, text: () => `state=${state}`, ...declares === 'context' ? { revision: () => state } : {},
  })
  ctx.systemPrompt.section({
    name: 'test:section', order: 100, text: () => `section=${state}`, ...declares === 'section' ? { revision: () => state } : {},
  })
  await send(agent, 'first')
  let noticed = false
  let remaining = mutations
  let evaluations = 0
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'developer/message' && event.data.message.source.kind === 'tool-registry') noticed = true
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'late-tool', description: 'Registered after the first request.', parameters: {},
    execute: () => Promise.resolve([{ type: 'text', text: 'unused' }]),
  }), {
    when: () => {
      if (noticed && remaining > 0) {
        remaining -= 1
        evaluations += 1
        state = `mutated-${String(evaluations)}`
      }
      return true
    },
  })
  return { agent, evaluations: () => evaluations }
}

describe('final request admission of runtime context', () => {
  it('restarts the attempt once when runtime context changes at the last admission await, then dispatches the current state', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const { agent, evaluations } = await lateMutation(adapter, 1)
    await send(agent, 'second')

    expect(evaluations()).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    expect(lastState(adapter.requests[1]!.messages)).toBe('state=mutated-1')
    expect(loggedState(agent)).toBe('state=mutated-1')
  })

  it('refuses before dispatch when runtime context keeps changing at the last await of the restarted attempt', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const { agent, evaluations } = await lateMutation(adapter, 3)
    await send(agent, 'second')

    expect(evaluations()).toBe(3)
    expect(adapter.requests).toHaveLength(1)
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('error')
  })

  it('restarts for a changed section revision at the last admission await', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const { agent } = await lateMutation(adapter, 1, 'section')
    await send(agent, 'second')

    expect(adapter.requests).toHaveLength(2)
    const prompt = adapter.requests[1]!.messages.filter(message => message.role === 'system').map(textOf).join('\n')
    expect(prompt).toContain('section=mutated-1')
    expect(lastState(adapter.requests[1]!.messages)).toBe('state=mutated-1')
  })

  it('does not recheck a context that declares no revision, so a volatile fact still dispatches', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const { agent, evaluations } = await lateMutation(adapter, 3, 'nothing')
    await send(agent, 'second')

    expect(evaluations()).toBe(1)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
      .toEqual(['completed', 'completed'])
  })

  it('leaves a request with stable runtime context to dispatch once', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const { agent, evaluations } = await lateMutation(adapter, 0)
    await send(agent, 'second')

    expect(evaluations()).toBe(0)
    expect(adapter.requests).toHaveLength(2)
    expect(lastState(adapter.requests[1]!.messages)).toBe('state=initial')
  })
})
