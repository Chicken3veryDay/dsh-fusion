/** Test-only held cleanup exercised by a recorded native tool through the headless profile. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ExecutionHostProvider } from '../../../src/index.ts'
import type {} from '@deepseek-ai/dsh-session-persistence'

export const name = 'retained-cleanup-profile-fixture'
export const inject = ['tools', 'fusionParticipants', 'sessions', 'sessionPersistence', 'llm']

/**
 * Register the fake cleanup operation without replacing the main replay provider.
 * @param ctx - Loader-owned fixture context.
 */
export function apply(ctx: Context): void {
  let requests = 0
  class InertAdapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model,
        reasoning: { efforts: ['low', 'medium', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })) } }
    }
    async * stream(): AsyncIterable<StreamChunk> {
      requests++
      process.send?.({ type: 'participant-request' })
      throw new Error('participant inference forbidden')
    }
  }
  ctx.llm.registerAdapter(['omniroute-openai', 'omniroute-anthropic'], new InertAdapter())
  ctx.tools.register(defineTool({
    name: 'retained_cleanup_probe', description: 'Exercise fake retained cleanup and report its observed result.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const outcomes: string[] = []
      for (const fault of [false, true]) {
        const task = await ctx.fusionParticipants.prepare('single-test')
        const adopted = await task.adopt('participant')
        const root = ctx.sessions.get(task.roster.rootSessionId)!, participant = adopted.agent.session
        let bodies = 0, cleanups = 0, removals = 0
        const provider: ExecutionHostProvider = {
          name: 'recorded-fake-held', revision: '1', classify: () => 'mutation',
          registerHeld() {
            return {
              async prepare() { return { invoke() { bodies++; process.send?.({ type: 'body' }); return Promise.resolve('completed' as const) } } },
              cancel() {}, async cleanup() { cleanups++ },
            }
          },
        }
        const host = await ctx.fusionParticipants.registerExecutionHost(task, provider)
        await host.grant(host.controller, participant.id)
        const run = host.bindRun(host.issuer, adopted.agent, new AbortController().signal)
        const attempt = host.reserve(run, 'fake-edit')
        await host.register(attempt)
        process.send?.({ type: 'sessions', root: root.id, participant: participant.id, fault })
        await host.dispose()
        assert.throws(() => host.reserve(run, 'fake-edit'))
        assert.equal(bodies, 0)
        assert.equal(cleanups, 1)
        const events = ctx.events, unregister = events['unregister']
        const callbacks = new Set<unknown>((events['_hooks']['session/event'] ?? [])
          .filter(hook => hook.ctx === ctx.root).map(hook => hook.callback))
        assert.equal(callbacks.size, 2)
        const failure = new Error('recorded exact remover failure')
        if (fault) Object.defineProperty(events, 'unregister', { configurable: true,
          value: (...args: Parameters<typeof unregister>) => {
            const result = unregister.apply(events, args)
            if (args[0] === 'session/event' && callbacks.has(args[1])) { removals++; throw failure }
            return result
          },
        })
        let rejected = false
        try {
          const completion = task.dispose()
          assert.equal(task.dispose(), completion)
          await completion
        } catch (error: unknown) {
          if (!fault) throw error
          const contains = (value: unknown): boolean => value === failure
            || value instanceof AggregateError && value.errors.some(contains)
          assert.equal(contains(error), true)
          rejected = true
        } finally {
          Object.defineProperty(events, 'unregister', { configurable: true, value: unregister })
        }
        assert.equal(rejected, fault)
        assert.equal(removals, fault ? 2 : 0)
        assert.equal((events['_hooks']['session/event'] ?? []).some(hook => callbacks.has(hook.callback)), false)
        for (const session of [root, participant]) {
          const reader = await ctx.sessionPersistence.open(session.id, 'read')
          try {
            assert.deepEqual((await reader.read()).events, session.ownEvents())
            assert.equal(session.ownEvents().some(event => event.type === 'request/context'), false)
          } finally { await reader.close() }
        }
        outcomes.push(`${fault ? 'fault' : 'normal'}: cleanup ${rejected ? 'rejected' : 'fulfilled'}; bodies ${bodies}; cleanups ${cleanups}; removals ${removals}; hooks 0; complete prefixes`)
      }
      assert.equal(requests, 0)
      return outcomes.join('\n')
    },
  }))
}
