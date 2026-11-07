/**
 * Review (Fable autonomy-core sweep): a wake issued while the Agent registry's
 * initiator scope is closing must not leave the Agent in a driverless
 * `running` phase that disposal then waits on forever.
 *
 * `ReactLoopAgent.wakeDriver` publishes the `running` phase and then calls
 * `agents.withInitiator(this, () => this.kick())`. `withInitiator` throws
 * synchronously once the registry observed its lifecycle ancestor entering
 * `UNLOADING` (`closeInitiators`), which happens at the start of host
 * shutdown, before any plugin's disposers run. The throw escapes `send()`
 * after the phase was committed, so no driver exists to run `kick()`'s
 * finally, `whenIdle()` never resolves, and the loop's own teardown
 * (`machine.cancel(); await machine.whenIdle()`) hangs the whole unload.
 *
 * Reachable unattended: a managed child settling during a selected drain
 * (`drainChildren`, the Workstream shutdown path) delivers its settlement
 * notice with `parent.followup()` while the parent is idle; a schedule or
 * job completion reporter waking an idle Agent at shutdown hits the same path.
 */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>(resolve => setTimeout(() => { resolve('pending') }, ms)),
  ])
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first'), textResponse('second')]))
  return ctx
}

describe('review: wake while the initiator scope closes', () => {
  it('a followup during root unload neither throws out of send() nor strands the Agent running, and unload completes', async () => {
    const ctx = await mount()
    const handle = await ctx.agents.create({ sessionId: SessionId('wake-during-close'), agentOptions: { provider: 'mock', model: 'mock' } })
    const agent = handle.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(agent.status).toBe('idle')

    // A host-owned plugin that, like Workstream's shutdown or a settlement
    // notice, delivers one waking message to a still-live idle Agent while the
    // root fiber unloads. The root's UNLOADING transition has already closed
    // the registry's initiator scope by the time any disposer runs.
    const observed: { thrown: unknown; statusAfterSend: string; idleAfterSend: 'settled' | 'pending' } = {
      thrown: undefined, statusAfterSend: 'unset', idleAfterSend: 'pending',
    }
    ctx.effect(() => async () => {
      try {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'late wake' }], source: { kind: 'user' } }))
      } catch (error: unknown) {
        observed.thrown = error
      }
      observed.statusAfterSend = agent.status
      observed.idleAfterSend = await settlesWithin(agent.whenIdle(), 500)
    }, 'review.lateWake()')

    const unload = ctx.fiber.dispose()
    const unloadOutcome = await settlesWithin(unload, 3000)

    // The contract a host relies on: either the wake is admitted and runs, or it
    // is refused without committing a phase. In both cases the Agent returns to
    // idle and shutdown completes.
    expect(observed.idleAfterSend, `send() threw: ${String(observed.thrown)}; status after send: ${observed.statusAfterSend}`).toBe('settled')
    expect(unloadOutcome, 'root unload must not hang on a driverless running Agent').toBe('settled')
  })
})
