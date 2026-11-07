/** Native browser ownership through real Agent, Session, and ToolRuntime services. */
import Interaction from '@deepseek-ai/dsh-interaction'
import * as InteractionTools from '@deepseek-ai/dsh-interaction-tools'
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeBrowserConfig } from '../src/native.ts'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Provider from '../src/index.ts'
import { fixture, nativeModel, resetFixture } from './fixtures/stagehand.ts'

const acquisition = vi.hoisted(() => ({
  signal: undefined as AbortSignal | undefined, warning: undefined as string | undefined,
  closeError: undefined as Error | undefined, chromiumCloseError: undefined as Error | undefined,
}))

vi.mock('@browserbasehq/stagehand', async importActual => ({
  ...await importActual<typeof import('@browserbasehq/stagehand')>(),
  ...await import('./fixtures/stagehand.ts'),
}))
vi.mock('@puppeteer/browsers', async () => import('./fixtures/chromium.ts'))
vi.mock('../src/launch.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/launch.ts')>()
  return {
    async launchChromium(...args: Parameters<typeof actual.launchChromium>) {
      const chromium = await actual.launchChromium(...args)
      return {
        ...chromium,
        async close() {
          await chromium.close()
          if (acquisition.chromiumCloseError !== undefined) throw acquisition.chromiumCloseError
        },
      }
    },
  }
})
vi.mock('../src/worker-client.ts', async () => {
  const { openNativeBrowser } = await import('../src/native.ts')
  return {
    async openBrowserWorker(config: NativeBrowserConfig, signal: AbortSignal, warn: (message: string) => void) {
      acquisition.signal = signal
      const native = await openNativeBrowser(config)
      let closing: Promise<void> | undefined
      const close = () => closing ??= (async () => {
        if (acquisition.warning !== undefined) warn(acquisition.warning)
        if (acquisition.closeError !== undefined) throw acquisition.closeError
        await native.close()
      })()
      return {
        async execute(method: import('../src/native.ts').BrowserMethod, args: unknown, signal?: AbortSignal) {
          if (closing !== undefined) throw new Error('Fixture connection is closed')
          const cancel = () => { void close().catch(() => {}) }
          signal?.addEventListener('abort', cancel, { once: true })
          try { return await native.execute(method, args) } finally { signal?.removeEventListener('abort', cancel) }
        },
        close,
      }
    },
  }
})

let ctx: Context
let first: Agent

class IndependentSessionModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('Stagehand called the Session model') }
}

beforeEach(async () => {
  resetFixture()
  acquisition.signal = undefined
  acquisition.warning = undefined
  acquisition.closeError = undefined
  acquisition.chromiumCloseError = undefined
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  await ctx.plugin(Interaction)
  await ctx.plugin(InteractionTools)
  ctx.llm.registerAdapter(['fixture'], new IndependentSessionModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  first = await harness.create(SessionId('stagehand-first'), { provider: 'fixture', model: 'structured' })
})

afterEach(async () => { await ctx.fiber.dispose() })

function execute(agent: Agent, suffix: string, args: unknown, signal = new AbortController().signal) {
  return executeToolFixture(ctx, { agent, name: `stagehand_${suffix}`, arguments: args, callId: ToolCallId(`test-${suffix}`), signal })
}

it('applies the same approval policy to normalized Stagehand navigation as to its raw tool', async () => {
  await ctx.plugin(Provider, { model: nativeModel, mode: 'launch' })
  let denied = 0
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'stagehand_navigate') return next()
    denied += 1
    return { kind: 'deny', reason: 'Navigation is denied by this Host policy' }
  })
  const control = await execute(first, 'navigate', { url: 'https://example.invalid/' })
  expect(control.isError).toBe(true)
  expect(fixture.browsers).toEqual([])
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent: first, signal, modelSelection: { provider: 'fixture', model: 'structured' } })
  try {
    const result = await executeModelToolFixture(ctx, {
      agent: first, name: 'browser_navigate', arguments: { url: 'https://example.invalid/' },
      callId: ToolCallId('normalized-navigation'), signal, toolSet,
    })
    expect({ denied, browsersAcquired: fixture.browsers.length, isError: result.isError })
      .toEqual({ denied: 2, browsersAcquired: 0, isError: true })
  } finally { toolSet.dispose() }
})
