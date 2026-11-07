/** A Session refused an exclusive attachment receives no normalized browser tools either. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import Interaction from '@deepseek-ai/dsh-interaction'
import * as InteractionTools from '@deepseek-ai/dsh-interaction-tools'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it } from 'vitest'
import { mountSessionMcp } from '../src/mcp.ts'

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))
const RAW = 'mcp__browser-fixture__browser_navigate'

it('offers a busy attachment Session neither raw nor normalized browser tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r2-blocked-'))
  const ctx = new Context()
  try {
    provideWorkingDirectoryFixture(ctx, root)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(BrowserUse)
    await ctx.plugin(Interaction)
    await ctx.plugin(InteractionTools)
    ctx.llm.registerAdapter(['idle'], new IdleModel())
    await mountAgentLoopTestHarness(ctx)
    await ctx.plugin({ name: 'attached-browser', inject: ['tools', 'browserUse', 'agents', 'systemPrompt'], apply(inner: Context) {
      mountSessionMcp(inner, { name: 'browser-fixture', exclusive: true, command: process.execPath, args: [fixture, root, 'interaction'] })
    } })
    const options = { provider: 'idle', model: 'fixture' }
    const ownerHandle = await ctx.agents.create({ sessionId: SessionId('owner'), agentOptions: options })
    const owner = ownerHandle.agent
    const busy = (await ctx.agents.create({ sessionId: SessionId('busy'), agentOptions: options })).agent
    const signal = new AbortController().signal
    // Control: the busy Session receives no raw browser tools or browser instructions while the owner holds the attachment.
    expect(ctx.tools.schemas(owner).some(tool => tool.name === RAW)).toBe(true)
    expect(ctx.tools.schemas(busy).some(tool => tool.name === RAW)).toBe(false)
    expect(ctx.interaction.available(owner, 'browser', 'navigate')).toBe(true)
    await ownerHandle.dispose()
    const toolSet = await ctx.tools.resolve({ agent: busy, signal, modelSelection: { provider: 'idle', model: 'fixture' } })
    try {
      const offered = toolSet.view(busy).has('browser_navigate')
      const facade = await executeModelToolFixture(ctx, {
        agent: busy, signal, toolSet, name: 'browser_navigate', arguments: { url: 'https://busy.invalid/' }, callId: ToolCallId('busy-facade'),
      })
      const initializations = (await readFile(join(root, 'events.ndjson'), 'utf8')).split('\n').filter(line => line.includes('"event":"initialize"')).length
      expect({ offered, facadeContent: facade.content, initializations }).toEqual({
        offered: false,
        facadeContent: expect.anything() as unknown,
        initializations: 1,
      })
    } finally { toolSet.dispose() }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
