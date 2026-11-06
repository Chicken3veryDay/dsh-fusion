/** `tools.register()` returns its disposer as a handle carrying the registration's identity. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const tool = (name: string): ToolDefinition => defineTool({
  name, description: `Operation ${name}.`, parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: () => Promise.resolve(name),
})

it('identifies each registration separately and unregisters through the handle', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const agent = { id: SessionId('handle') } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const definition = tool('probe')
  const global = ctx.tools.register(definition)
  const shadow = scope.ctx.tools.register(definition)
  expect(global.registration.definition).toBe(definition)
  expect(shadow.registration.definition).toBe(definition)
  expect(shadow.registration).not.toBe(global.registration)
  expect(Object.isFrozen(global.registration)).toBe(true)
  shadow()
  global()
  expect(ctx.tools.get('probe', agent)).toBeUndefined()
  global()
})
