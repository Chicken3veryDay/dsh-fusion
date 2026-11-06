/** A registration records where it comes from, and the record is read-only and disposable. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
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

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const agent = { id: SessionId('origin') } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const tool = (name: string): ToolDefinition => defineTool({
    name, description: `Operation ${name}.`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve(`ran:${name}`),
  })
  return { ctx, agent, scope, tool }
}

it('reads back the origin each registration recorded', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('user_tool'), { origin: 'global' })
  h.ctx.tools.register(h.tool('workspace_tool'), { origin: 'project' })
  expect(h.ctx.tools.originOf('user_tool')).toBe('global')
  expect(h.ctx.tools.originOf('workspace_tool')).toBe('project')
})

it('reports a registration without an origin, and a tool that is not visible, as unknown', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('plain'))
  h.ctx.tools.register(h.tool('explicit'), { origin: 'unknown' })
  expect(h.ctx.tools.originOf('plain')).toBe('unknown')
  expect(h.ctx.tools.originOf('explicit')).toBe('unknown')
  expect(h.ctx.tools.originOf('missing')).toBe('unknown')
})

it('does not infer an origin from the name', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('mcp__project__thing'))
  h.ctx.tools.register(h.tool('project_deploy'))
  expect(h.ctx.tools.originOf('mcp__project__thing')).toBe('unknown')
  expect(h.ctx.tools.originOf('project_deploy')).toBe('unknown')
})

it('reports the origin of the registration the scope actually sees', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool('shared'), { origin: 'global' })
  h.scope.ctx.tools.register(h.tool('shared'), { origin: 'project' })
  h.scope.ctx.tools.register(h.tool('own'))
  expect(h.ctx.tools.originOf('shared')).toBe('global')
  expect(h.ctx.tools.originOf('shared', h.agent)).toBe('project')
  expect(h.ctx.tools.originOf('own', h.agent)).toBe('unknown')
  expect(h.ctx.tools.originOf('own')).toBe('unknown')
})

it('drops the record with the registration', async () => {
  const h = await setup()
  const dispose = h.ctx.tools.register(h.tool('gone'), { origin: 'project' })
  dispose()
  expect(h.ctx.tools.originOf('gone')).toBe('unknown')
  h.ctx.tools.register(h.tool('gone'), { origin: 'global' })
  expect(h.ctx.tools.originOf('gone')).toBe('global')
})
