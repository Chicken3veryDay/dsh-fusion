/** Failed provider data retains its canonical outcome through the normalized facade. */
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Interaction, { interactionProviderId } from '@deepseek-ai/dsh-interaction'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { ToolExecutionFailure } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { expect, it } from 'vitest'
import * as InteractionTools from '../src/index.ts'

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

it('preserves a provider failure code, rendered image, and metadata', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Interaction)
    await ctx.plugin(InteractionTools)
    ctx.llm.registerAdapter(['idle'], new IdleModel())
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('failure-content'), { provider: 'idle', model: 'fixture' })
    const failure: ToolExecutionFailure = {
      isError: true,
      error: { message: 'Action refused', info: { name: 'ProviderError', code: 'REFUSED', reason: 'Permission required' } },
      content: [
        { type: 'text', text: 'Grant permission before retrying.' },
        { type: 'image', attachment: { attachmentId: AttachmentId('failure-image'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
      ],
      meta: { domain: 'browser' },
    }
    ctx.effect(() => ctx.interaction.register({
      domain: 'browser',
      describe: () => ({ id: interactionProviderId('failure-fixture'), domains: ['browser'], methods: ['navigate'], availability: 'ready' }),
      open: async () => ({ execute: async () => JSON.parse(JSON.stringify(failure)) as JsonValue, close: async () => {} }),
    }))
    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'idle', model: 'fixture' } })
    try {
      const result = await executeModelToolFixture(ctx, {
        agent, name: 'browser_navigate', arguments: { url: 'https://example.invalid/' }, callId: ToolCallId('rich-failure'), signal, toolSet,
      })
      expect(result).toEqual(failure)
      expect(result).not.toHaveProperty('value')
    } finally { toolSet.dispose() }
  } finally { await ctx.fiber.dispose() }
})
