/** Discover the pinned real DevTools catalog; intercept execution before any browser action. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import Interaction from '@deepseek-ai/dsh-interaction'
import * as InteractionTools from '@deepseek-ai/dsh-interaction-tools'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it } from 'vitest'
import * as Provider from '../src/index.ts'
class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}
it('maps normalized tabs to the installed DevTools catalog advertised by the ready provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-devtools-'))
  const ctx = new Context()
  try {
    provideWorkingDirectoryFixture(ctx, root)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(BrowserUse)
    await ctx.plugin(Interaction)
    await ctx.plugin(InteractionTools)
    ctx.llm.registerAdapter(['idle'], new IdleModel())
    const harness = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(Provider, Provider.Config({ mode: 'launch' }))
    const agent = await harness.create(SessionId('review-devtools-catalog'), { provider: 'idle', model: 'fixture' })
    expect(ctx.tools.schemas(agent).some(tool => tool.name === 'mcp__chrome-devtools-mcp__list_pages')).toBe(true)
    expect(ctx.interaction.available(agent, 'browser', 'tabs')).toBe(true)
    const intercepted: string[] = []
    ctx.on('tools/execute', async (exec, next) => {
      if (!exec.name.startsWith('mcp__chrome-devtools-mcp__')) return next()
      intercepted.push(exec.name)
      return { isError: false, value: { content: [{ type: 'text', text: 'Inert operation control' }] }, content: [{ type: 'text', text: 'Inert operation control' }] }
    })
    const signal = new AbortController().signal
    const control = await executeModelToolFixture(ctx, { agent, signal, name: 'mcp__chrome-devtools-mcp__list_pages', arguments: {}, callId: ToolCallId('raw-control') })
    expect(control.isError).toBe(false)
    expect(intercepted).toEqual(['mcp__chrome-devtools-mcp__list_pages'])
    const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'idle', model: 'fixture' } })
    try {
      const result = await executeModelToolFixture(ctx, { agent, signal, toolSet, name: 'browser_tabs', arguments: { operation: 'list' }, callId: ToolCallId('normalized-tabs') })
      expect(JSON.stringify(result.content)).not.toContain('browser provider does not expose browser_tabs or browser_tab_list')
      expect(result.content).toEqual(control.content)
      expect(result.isError).toBe(false)
    } finally { toolSet.dispose() }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
