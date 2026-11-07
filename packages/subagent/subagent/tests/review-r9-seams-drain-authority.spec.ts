/** Selected drains must establish direct-parent authority before refusing another parent's delivery. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]
const signal = new AbortController().signal

it.each([false, true])('only the direct parent can cut off a cold-resuming delivery (authorized=%s)', async (authorized) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-r9-drain-authority-'))
  const ctx = new Context()
  const release = Promise.withResolvers<undefined>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TestSessionQuery)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first done'), textResponse('second done')]))
    const parent = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'model' })
    const stranger = await ctx.agentLoop.create(SessionId('unrelated'), { provider: 'mock', model: 'model' })
    const started = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'child', signal, delivery: 'caller', request: { parent, prompt: text('first task') },
    })
    await started.result
    expect(ctx.agents.get(started.childId)).toBeUndefined()
    const entered = Promise.withResolvers<undefined>()
    const original = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    const observation = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (id, options) => {
      const source = await original(id, options)
      if (id === started.childId) { entered.resolve(undefined); await release.promise }
      return source
    })
    const delivery = ctx.subagents.sendMessage(parent, started.childId, text('second task'), { signal })
      .then(() => 'accepted', (error: unknown) => error instanceof Error && 'code' in error ? error.code : error)
    await entered.promise
    const drain = ctx.subagents.drainChildren(authorized ? parent : stranger, [started.childId])
      .then(() => 'drained', (error: unknown) => error instanceof Error && 'code' in error ? error.code : error)
    release.resolve(undefined)
    const outcome = { drain: await drain, delivery: await delivery }
    observation.mockRestore()
    await ctx.subagents.waitForChildren(parent)
    if (authorized) {
      expect(outcome).toEqual({ drain: 'drained', delivery: 'ACTIVATION_CLOSING' })
    } else {
      expect(['drained', 'UNAUTHORIZED']).toContain(outcome.drain)
      expect(outcome.delivery, 'an unrelated parent must not refuse the owner’s message').toBe('accepted')
    }
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
