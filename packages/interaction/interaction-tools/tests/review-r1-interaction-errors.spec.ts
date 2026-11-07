/** Inert MCP providers exercise normalized failure propagation through the real pipeline. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import * as DesktopProvider from '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
import Interaction from '@deepseek-ai/dsh-interaction'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it } from 'vitest'
import * as InteractionTools from '../src/index.ts'

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

it.each(['browser', 'desktop'] as const)('preserves an underlying %s operation denial as a normalized tool failure', async (domain) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-interaction-errors-'))
  const ctx = new Context()
  try {
    provideWorkingDirectoryFixture(ctx, root)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Interaction)
    await ctx.plugin(InteractionTools)
    await ctx.plugin(BrowserUse)
    await ctx.plugin(ComputerUse)
    ctx.llm.registerAdapter(['idle'], new IdleModel())
    const harness = await mountAgentLoopTestHarness(ctx)
    if (domain === 'browser') {
      const fixture = fileURLToPath(new URL('../../../experimental/browser-use-runtime/tests/mcp-fixture.mjs', import.meta.url))
      await ctx.plugin({ name: 'inert-browser', inject: ['tools', 'browserUse', 'agents', 'systemPrompt'], apply(inner: Context) {
        mountSessionMcp(inner, { name: 'browser-fixture', exclusive: false, command: process.execPath, args: [fixture, root, 'interaction'] })
      } })
    } else {
      const fixture = fileURLToPath(new URL('../../../experimental/computer-use-cua-driver-mcp/tests/fixtures/driver.mjs', import.meta.url))
      await ctx.plugin(DesktopProvider, { command: process.execPath, args: [fixture, root], reconnect: { enabled: false } })
    }
    const agent = await harness.create(SessionId(`review-errors-${domain}`), { provider: 'idle', model: 'fixture' })
    const rawName = domain === 'browser' ? 'mcp__browser-fixture__browser_navigate' : 'mcp__cua-driver-mcp__screenshot'
    let denied = 0
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== rawName) return next()
      denied += 1
      return { kind: 'deny', reason: 'Review fixture denied this provider operation' }
    })
    const signal = new AbortController().signal
    const raw = await executeModelToolFixture(ctx, { agent, name: rawName, arguments: domain === 'browser' ? { url: 'https://example.invalid/' } : { display: 0 }, callId: ToolCallId('raw-control'), signal })
    expect(raw.isError).toBe(true)
    const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'idle', model: 'fixture' } })
    try {
      const normalized = await executeModelToolFixture(ctx, { agent, name: domain === 'browser' ? 'browser_navigate' : 'desktop_screenshot', arguments: domain === 'browser' ? { url: 'https://example.invalid/' } : {}, callId: ToolCallId('normalized'), signal, toolSet })
      expect(denied).toBe(2)
      expect(JSON.stringify(normalized.content)).toContain('Review fixture denied')
      expect(normalized.isError).toBe(true)
    } finally { toolSet.dispose() }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
