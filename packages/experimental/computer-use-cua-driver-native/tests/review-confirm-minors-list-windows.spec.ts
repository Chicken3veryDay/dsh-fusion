/** The desktop facade's id guidance names list_windows; check the model can call it next to the facade. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import Interaction, { DESKTOP_ACTION_TOOLS } from '@deepseek-ai/dsh-interaction'
import * as InteractionTools from '@deepseek-ai/dsh-interaction-tools'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import * as NativeProvider from '../src/index.ts'

let driverInstalled = false
try {
  import.meta.resolve('@trycua/cua-driver')
  driverInstalled = true
} catch (error) {
  // The optional native driver is not installed on every test host.
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

async function mounted(platform: NodeJS.Platform) {
  const original = process.platform
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(Interaction)
  await ctx.plugin(InteractionTools)
  ctx.llm.registerAdapter(['idle'], new IdleModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(NativeProvider)
  const agent = await harness.create(SessionId(`review-confirm-${platform}`), { provider: 'idle', model: 'fixture' })
  const signal = new AbortController().signal
  // Only the provider's availability report reads the platform; the native module loads for the real Host.
  Object.defineProperty(process, 'platform', { value: platform })
  const toolSet = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'idle', model: 'fixture' } })
  const names = ctx.tools.schemas(agent, toolSet).map(tool => tool.name)
  const descriptions = new Map(ctx.tools.schemas(agent, toolSet).map(tool => [tool.name, JSON.stringify(tool.parameters)]))
  return {
    ctx, agent, names, descriptions,
    async dispose() {
      toolSet.dispose()
      await ctx.fiber.dispose()
      Object.defineProperty(process, 'platform', { value: original })
    },
  }
}

it.skipIf(process.platform !== 'linux' || !driverInstalled)('installed catalog: the facade and the raw list_windows tool reach the same model request', async () => {
  const app = await mounted('linux')
  try {
    expect(app.names).toEqual(expect.arrayContaining(['desktop_observe', 'desktop_act', 'desktop_screenshot', 'cua_driver_native__list_windows']))
    expect(app.descriptions.get('desktop_observe')).toContain('list_windows')
    // Every kind the description lists executes against the installed catalog.
    expect(app.ctx.interaction.describe('desktop')?.actionKinds).toEqual(Object.keys(DESKTOP_ACTION_TOOLS))
  } finally { await app.dispose() }
}, 120_000)

it.skipIf(process.platform !== 'linux' || !driverInstalled)('the same composition on a macOS Host hides the facade, so its pinned schemas and guidance are Linux-only', async () => {
  const app = await mounted('darwin')
  try {
    expect(app.names).toContain('cua_driver_native__list_windows')
    expect(app.names).not.toContain('desktop_observe')
  } finally { await app.dispose() }
}, 120_000)
