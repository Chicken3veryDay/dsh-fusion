/** Every normalized browser operation resolves against the pinned server's discovered tool catalog. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import { chromeDevtoolsOperations } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import Interaction, { BROWSER_ACTION_KINDS, type BrowserOperation } from '@deepseek-ai/dsh-interaction'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import * as Provider from '../src/index.ts'

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

interface Parameters { properties?: Record<string, unknown>; required?: string[] }

/** The upstream server fills a declared default when the argument is omitted. */
function isDefaulted(parameters: Parameters, name: string): boolean {
  const property = parameters.properties?.[name]
  return typeof property === 'object' && property !== null && 'default' in property
}

const LISTING = { value: { content: [{ type: 'text', text: '## Pages\n2: https://a.invalid/\n7: https://b.invalid/ [selected]' }] } }
const ACTIONS: Record<string, Record<string, unknown>> = {
  click: { uid: '1_1', dblClick: true },
  hover: { uid: '1_1' },
  press_key: { key: 'Enter' },
  drag: { from_uid: '1_1', to_uid: '1_2' },
  navigate_back: {},
  select_option: { uid: '1_1', value: 'red' },
  wait_for: { text: 'Done' },
  type: { text: 'hello' },
  scroll: {},
}
const OPERATIONS: BrowserOperation[] = [
  { domain: 'browser', method: 'navigate', url: 'https://a.invalid/' },
  { domain: 'browser', method: 'navigate', tabId: '2', url: 'https://a.invalid/' },
  { domain: 'browser', method: 'observe' },
  { domain: 'browser', method: 'observe', tabId: '2' },
  { domain: 'browser', method: 'screenshot' },
  { domain: 'browser', method: 'screenshot', tabId: '2' },
  { domain: 'browser', method: 'tabs', operation: 'list' },
  { domain: 'browser', method: 'tabs', operation: 'new', url: 'https://a.invalid/' },
  { domain: 'browser', method: 'tabs', operation: 'select', tabId: '2' },
  { domain: 'browser', method: 'tabs', operation: 'close', tabId: '2' },
  ...BROWSER_ACTION_KINDS.filter(kind => ACTIONS[kind] !== undefined && kind !== 'scroll').flatMap((kind): BrowserOperation[] => [
    { domain: 'browser', method: 'act', action: { kind, ...ACTIONS[kind] as Record<string, never> } },
    { domain: 'browser', method: 'act', tabId: '2', action: { kind, ...ACTIONS[kind] as Record<string, never> } },
  ]),
]

it('plans every supported operation onto tools and arguments the discovered DevTools catalog declares', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-devtools-catalog-'))
  const ctx = new Context()
  try {
    provideWorkingDirectoryFixture(ctx, root)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(BrowserUse)
    await ctx.plugin(Interaction)
    ctx.llm.registerAdapter(['idle'], new IdleModel())
    const harness = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(Provider, Provider.Config({ mode: 'launch' }))
    const agent = await harness.create(SessionId('devtools-catalog-mapping'), { provider: 'idle', model: 'fixture' })
    const catalog = new Map(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('mcp__chrome-devtools-mcp__'))
      .map(tool => [tool.name.slice('mcp__chrome-devtools-mcp__'.length), tool.parameters as Parameters]))
    expect(chromeDevtoolsOperations.methods(raw => catalog.has(raw))).toEqual(['navigate', 'tabs', 'observe', 'act', 'screenshot'])
    expect(ctx.interaction.describe('browser')?.methods).toEqual(['navigate', 'tabs', 'observe', 'act', 'screenshot'])
    for (const operation of OPERATIONS) {
      const settled: unknown[] = []
      for (const call of chromeDevtoolsOperations.plan(operation)) {
        const tool = call.tools.find(raw => catalog.has(raw))
        expect(tool, JSON.stringify(operation)).toBeDefined()
        const parameters = catalog.get(tool!)!
        const args = call.args(settled as never)
        for (const key of Object.keys(args)) expect(Object.keys(parameters.properties ?? {}), `${tool}.${key}`).toContain(key)
        for (const key of (parameters.required ?? []).filter(name => !isDefaulted(parameters, name))) expect(args, `${tool} requires ${key}`).toHaveProperty(key)
        settled.push(LISTING)
      }
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
