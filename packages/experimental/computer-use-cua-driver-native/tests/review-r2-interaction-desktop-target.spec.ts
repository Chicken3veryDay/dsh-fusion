/** Discover the installed Cua Driver catalog; intercept every call before the native driver acts. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import Interaction from '@deepseek-ai/dsh-interaction'
import * as InteractionTools from '@deepseek-ai/dsh-interaction-tools'
import { LlmAdapter, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it } from 'vitest'
import * as NativeProvider from '../src/index.ts'

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

interface Parameters { properties?: Record<string, unknown>; required?: string[] }

it.skipIf(process.platform !== 'linux')('targets the window a normalized desktop observation names with the installed catalog arguments', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ComputerUseRegistry)
    await ctx.plugin(Interaction)
    await ctx.plugin(InteractionTools)
    ctx.llm.registerAdapter(['idle'], new IdleModel())
    const harness = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(NativeProvider)
    const agent = await harness.create(SessionId('review-r2-desktop-target'), { provider: 'idle', model: 'fixture' })
    const intercepted: Array<{ name: string; args: unknown }> = []
    ctx.on('tools/execute', async (exec, next) => {
      if (!exec.name.startsWith('cua_driver_native__')) return next()
      intercepted.push({ name: exec.name, args: exec.arguments })
      return { isError: false, value: { content: [{ type: 'text', text: 'Inert window state' }] }, content: [{ type: 'text', text: 'Inert window state' }] }
    })
    const signal = new AbortController().signal
    const windowState = ctx.tools.schemas(agent).find(tool => tool.name === 'cua_driver_native__get_window_state')
    const parameters = windowState?.parameters as Parameters | undefined
    // The installed catalog addresses a window by its integer pid and window_id and declares no other target field.
    expect(parameters?.required).toEqual(['pid', 'window_id'])
    expect(Object.keys(parameters?.properties ?? {})).not.toContain('application_id')
    const control = await executeModelToolFixture(ctx, {
      agent, signal, name: 'cua_driver_native__get_window_state', arguments: { pid: 4242, window_id: 7 }, callId: ToolCallId('raw-control'),
    })
    expect(control.isError).toBe(false)
    expect(intercepted).toEqual([{ name: 'cua_driver_native__get_window_state', args: { pid: 4242, window_id: 7 } }])
    intercepted.length = 0
    expect(ctx.interaction.available(agent, 'desktop', 'observe')).toBe(true)
    const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'idle', model: 'fixture' } })
    try {
      const result = await executeModelToolFixture(ctx, {
        agent, signal, toolSet, name: 'desktop_observe', arguments: { applicationId: '4242', windowId: '7' }, callId: ToolCallId('normalized-observe'),
      })
      const sent = intercepted[0]?.args as Record<string, unknown> | undefined
      expect(Object.keys(sent ?? {}).filter(key => !Object.keys(parameters?.properties ?? {}).includes(key))).toEqual([])
      expect(sent).toEqual({ pid: 4242, window_id: 7 })
      expect(result.isError).toBe(false)
    } finally { toolSet.dispose() }
  } finally {
    await ctx.fiber.dispose()
  }
}, 120_000)
