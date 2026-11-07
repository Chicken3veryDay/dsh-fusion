/** Delegated failures retain their canonical details through body exception handling. */
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Tools, { defineTool, ToolResultError, type ToolExecutionFailure } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'

it('preserves delegated error identity, rendered images, and metadata without a success value', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeToolExecutor)
    const failure: ToolExecutionFailure = {
      isError: true,
      error: { message: 'Action refused', info: { name: 'ProviderError', code: 'REFUSED', reason: 'Permission required' } },
      content: [
        { type: 'text', text: 'Action refused; grant permission before retrying.' },
        { type: 'image', attachment: { attachmentId: AttachmentId('failure-image'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
      ],
      meta: { domain: 'browser' },
    }
    ctx.tools.register(defineTool({
      name: 'delegate', description: 'Delegates a provider operation.', parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => { throw new ToolResultError(failure) },
    }))
    const result = await executeToolFixture(ctx, {
      name: 'delegate', arguments: {}, callId: ToolCallId('delegated-failure'), signal: new AbortController().signal,
    })
    expect(result).toEqual(failure)
    expect(result).not.toHaveProperty('value')
  } finally { await ctx.fiber.dispose() }
})
