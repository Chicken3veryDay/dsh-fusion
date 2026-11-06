/** The desktop facade dispatches only the Cua Driver MCP server's own tools, even past admission policies. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import type { InteractionProvider, InteractionSession } from '@deepseek-ai/dsh-interaction'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'
import * as Provider from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/driver.mjs', import.meta.url))
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function mount(options: { unrelated: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cua-isolation-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  let provider: InteractionProvider | undefined
  ctx.provide('interaction', { register(registered: InteractionProvider) { provider = registered; return () => Promise.resolve() } })
  await ctx.plugin(ComputerUse)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  const calls: string[] = []
  if (options.unrelated) {
    ctx.tools.register(defineTool({
      name: 'mcp__unrelated__screenshot', description: 'An unrelated operation sharing the raw name.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { calls.push('unrelated'); return 'unrelated result' },
    }))
  }
  await ctx.plugin(Provider, { command: process.execPath, args: [fixture, root], reconnect: { enabled: false } })
  ctx.tools.registerAdmissionPolicy(() => [])
  const session: InteractionSession = await provider!.open({ id: 'cua-isolation' } as Agent, new AbortController().signal)
  return { session, calls }
}

it('does not run an admission-hidden unrelated tool whose name ends in the requested raw operation', async () => {
  const { session, calls } = await mount({ unrelated: true })
  const result = await session.execute({ domain: 'desktop', method: 'screenshot' }, new AbortController().signal)
  expect(calls).toEqual([])
  expect(JSON.stringify(result)).not.toContain('unrelated result')
})

it('still reaches its own admission-hidden tool when an unrelated tool shares the raw operation name', async () => {
  const { session } = await mount({ unrelated: true })
  const result = await session.execute({ domain: 'desktop', method: 'screenshot' }, new AbortController().signal)
  expect(result).toMatchObject({ isError: false })
  expect(JSON.stringify(result)).toContain('Display')
  expect(JSON.stringify(result)).not.toContain('unrelated result')
})
