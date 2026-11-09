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

/** The last runtime-context snapshot and the system prompt text one request carries. */
function requestText(request: MockAdapter['requests'][number]): { runtime: string; system: string } {
  const runtime = request.messages.filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
  return {
    runtime: runtime.map(textOf).at(-1) ?? '',
    system: request.messages.filter(message => message.role === 'system').map(textOf).join('\n'),
  }
}

/** The newest committed runtime-context snapshot, which a later request carries. */
function loggedRuntime(agent: Agent): string {
  return agent.session.snapshotEvents().flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'runtime-context' ? [textOf(event.data)] : []).at(-1) ?? ''
}

/** Registrations a {@link registrationChange} fixture installs before its first request. */
interface LiveRegistrations {
  readonly ctx: Context
  readonly agent: Agent
  /** Disposes the global revisioned `test:live` context. */
  readonly removeContext: () => void
  /** Disposes the global revisioned `test:live` section. */
  readonly removeSection: () => void
}

/**
 * Register a revisioned `test:live` context and section that both declare revision "0", plus a context only the
 * assembly waterfall adds, and send one request. Then apply `change` once inside the activation predicate of a tool
 * registered afterwards, which request admission evaluates at its last await, and send a second request.
 */
async function registrationChange(change: (live: LiveRegistrations) => void) {
  const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
  const { ctx, agent } = await harness(adapter)
  const live: LiveRegistrations = {
    ctx,
    agent,
    removeContext: ctx.systemPrompt.context({ name: 'test:live', order: 100, text: 'RETIRED_CONTEXT', revision: () => '0' }),
    removeSection: ctx.systemPrompt.section({ name: 'test:live', order: 100, text: 'RETIRED_SECTION', revision: () => '0' }),
  }
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return { ...assembly, contexts: [...assembly.contexts, { name: 'test:waterfall', text: 'WATERFALL_CONTEXT' }] }
  })
  await send(agent, 'first')
  let noticed = false
  let changed = false
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'developer/message' && event.data.message.source.kind === 'tool-registry') noticed = true
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'late-tool', description: 'Registered after the first request.', parameters: {},
    execute: () => Promise.resolve([{ type: 'text', text: 'unused' }]),
  }), {
    when: () => {
      if (noticed && !changed) {
        changed = true
        change(live)
      }
      return true
    },
  })
  await send(agent, 'second')
  expect(changed).toBe(true)
  expect(adapter.requests).toHaveLength(2)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
    .toEqual(['completed', 'completed'])
  const dispatched = requestText(adapter.requests[1]!)
  // The request carries the newest committed snapshot, so the log reconstructs exactly what was dispatched.
  expect(loggedRuntime(agent)).toBe(dispatched.runtime)
  return { ...dispatched, logged: loggedRuntime(agent) }
}

describe('final request admission of registration changes', () => {
  it('dispatches and logs no removed revisioned context', async () => {
    const result = await registrationChange((live) => { live.removeContext() })
    expect(result.runtime).not.toContain('RETIRED_CONTEXT')
    expect(result.logged).not.toContain('RETIRED_CONTEXT')
    expect(result.runtime).toContain('WATERFALL_CONTEXT')
  })

  it('dispatches and logs a same-name replacement that declares an equal revision', async () => {
    const result = await registrationChange((live) => {
      live.removeContext()
      live.ctx.systemPrompt.context({ name: 'test:live', order: 100, text: 'CURRENT_CONTEXT', revision: () => '0' })
    })
    expect(result.runtime).toContain('CURRENT_CONTEXT')
    expect(result.runtime).not.toContain('RETIRED_CONTEXT')
    expect(result.logged).toContain('CURRENT_CONTEXT')
    expect(result.runtime).toContain('WATERFALL_CONTEXT')
  })

  it('dispatches and logs a nearer Agent-scoped override that declares an equal revision', async () => {
    const result = await registrationChange((live) => {
      live.agent.ctx.systemPrompt.context({ name: 'test:live', order: 100, text: 'CURRENT_CONTEXT', revision: () => '0' })
    })
    expect(result.runtime).toContain('CURRENT_CONTEXT')
    expect(result.runtime).not.toContain('RETIRED_CONTEXT')
    expect(result.logged).toContain('CURRENT_CONTEXT')
  })

  it('dispatches and logs no suppressed optional context', async () => {
    const result = await registrationChange((live) => { live.ctx.systemPrompt.suppressRuntimeContext() })
    expect(result.runtime).not.toBe('')
    expect(result.runtime).not.toContain('RETIRED_CONTEXT')
    expect(result.logged).not.toContain('RETIRED_CONTEXT')
  })

  it('dispatches and logs a revisioned context registered at the last await', async () => {
    const result = await registrationChange((live) => {
      live.ctx.systemPrompt.context({ name: 'test:new', order: 200, text: 'NEW_CONTEXT', revision: () => '0' })
    })
    expect(result.runtime).toContain('NEW_CONTEXT')
    expect(result.runtime).toContain('RETIRED_CONTEXT')
    expect(result.logged).toContain('NEW_CONTEXT')
  })

  it('dispatches a same-name section replacement that declares an equal revision', async () => {
    const result = await registrationChange((live) => {
      live.removeSection()
      live.ctx.systemPrompt.section({ name: 'test:live', order: 100, text: 'CURRENT_SECTION', revision: () => '0' })
    })
    expect(result.system).toContain('CURRENT_SECTION')
    expect(result.system).not.toContain('RETIRED_SECTION')
  })

  it('dispatches a nearer Agent-scoped section override that declares an equal revision', async () => {
    const result = await registrationChange((live) => {
      live.agent.ctx.systemPrompt.section({ name: 'test:live', order: 100, text: 'CURRENT_SECTION', revision: () => '0' })
    })
    expect(result.system).toContain('CURRENT_SECTION')
    expect(result.system).not.toContain('RETIRED_SECTION')
  })
})
