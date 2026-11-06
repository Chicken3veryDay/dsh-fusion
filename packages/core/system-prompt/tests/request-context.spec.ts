/** Per-attempt context is independent of inbox claims and scoped to its contributor. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { expect, it } from 'vitest'

it('collects scoped context on every attempt and removes disposed contributors', async ({ onTestFinished }) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  const key = { name: 'requester' }
  const scope = createScope(ctx, key)
  const pending = createUserMessage({ content: [{ type: 'text', text: 'already accepted' }], source: { kind: 'user' } })
  const added = createUserMessage({ content: [{ type: 'text', text: 'restored context' }], source: { kind: 'user' } })
  const seen: (readonly UserMessage[])[] = []
  scope.ctx.on('system-prompt/request-context', async (_context, messages, next) => {
    seen.push(messages)
    return [...await next(), added]
  })
  expect(await ctx.systemPrompt.requestContext()).toEqual([])
  expect(await ctx.systemPrompt.requestContext({ scope: key }, [pending])).toEqual([added])
  expect(await ctx.systemPrompt.requestContext({ scope: key })).toEqual([added])
  expect(seen).toEqual([[pending], []])
  await scope.dispose()
  expect(await ctx.systemPrompt.requestContext({ scope: key })).toEqual([])
})
