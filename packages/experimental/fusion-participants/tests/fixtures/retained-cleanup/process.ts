/** Fake main model and public-provider restart probes for a supported built headless profile. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ExecutionHostProvider } from '../../../src/index.ts'

export const name = 'retained-cleanup-process-fixture'
export const inject = ['llm', 'tools', 'fusionParticipants', 'sessions', 'sessionPersistence']

/**
 * Install the process-controlled fake model and restart operation.
 * @param ctx - Loader-owned fixture context.
 */
export function apply(ctx: Context): void {
  const mode = process.env.DSH_RETAINED_PROCESS_MODE ?? 'write'
  class MainAdapter extends LlmAdapter {
    private calls = 0
    async * stream(): AsyncIterable<StreamChunk> {
      if (++this.calls === 1) {
        const name = mode === 'write' ? 'retained_cleanup_probe' : 'retained_process_probe'
        const block = { type: 'tool-call' as const, id: ToolCallId('retained-process'), name, arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        assert.equal(this.calls, 2)
        const block = { type: 'text' as const, text: 'RETAINED_PROCESS_OK' }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['retained-process'], new MainAdapter())
  ctx.tools.register(defineTool({
    name: 'retained_process_probe', description: 'Exercise public retained writer restart without inference.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      if (mode === 'hold') {
        const id = SessionId(process.env.DSH_RETAINED_PARTICIPANT!)
        const writer = await ctx.sessionPersistence.open(id, 'write')
        try {
          process.send?.({ type: 'held', id })
          await once(process, 'message')
        } finally { await writer.close() }
      } else if (mode === 'crash') {
        const task = await ctx.fusionParticipants.prepare('single-test')
        const adopted = await task.adopt('participant')
        const provider: ExecutionHostProvider = {
          name: 'crash-fake-held', revision: '1', classify: () => 'mutation',
          registerHeld() { return {
            async prepare() { return { invoke() { process.send?.({ type: 'body' }); throw new Error('body forbidden') } } }, cancel() {}, async cleanup() {},
          } },
        }
        const host = await ctx.fusionParticipants.registerExecutionHost(task, provider)
        await host.grant(host.controller, adopted.agent.session.id)
        const run = host.bindRun(host.issuer, adopted.agent, new AbortController().signal)
        await host.register(host.reserve(run, 'fake-edit'))
        process.send?.({ type: 'crash-ready', root: task.roster.rootSessionId, participant: adopted.agent.session.id })
        await once(process, 'message')
        throw new Error('crash fixture must be terminated at its barrier')
      } else {
        const root = SessionId(process.env.DSH_RETAINED_ROOT!)
        const participant = SessionId(process.env.DSH_RETAINED_PARTICIPANT!)
        const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
        const acquisitions: string[] = []
        ctx.sessionPersistence.open = async (...args: Parameters<typeof open>) => {
          if (args[1] === 'write') acquisitions.push(args[0])
          return open(...args)
        }
        let rejected = false
        try {
          const task = await ctx.fusionParticipants.recover(root)
          assert.equal(task.execution.owner, null)
          await task.dispose()
        } catch (error: unknown) {
          if (mode !== 'refuse') throw error
          rejected = true
        } finally { ctx.sessionPersistence.open = open }
        assert.equal(rejected, mode === 'refuse')
        assert.deepEqual(acquisitions.slice(0, 2), [root, participant])
        const rootWriter = await open(root, 'write')
        await rootWriter.close()
        process.send?.({ type: 'recovered', acquisitions, rejected })
      }
      return 'PROCESS_PROBE_OK'
    },
  }))
}
