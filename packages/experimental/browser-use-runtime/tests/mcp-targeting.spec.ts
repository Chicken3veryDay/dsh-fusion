/** Explicit tab targeting through the normalized browser facade, observed on an inert stdio server's call log. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import Interaction, { type BrowserOperation, type InteractionOperation } from '@deepseek-ai/dsh-interaction'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSessionMcp, type SessionMcpOptions } from '../src/mcp.ts'

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

/** Serves the named tools and appends each call's `name` and `arguments` to the log file. */
const serverSource = String.raw`
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const [log, ...names] = process.argv.slice(2)
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  if (request.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy fixture' } }) + '\n')
  } else if (request.method === 'initialize') {
    reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'target-fixture', version: '1' } })
  } else if (request.method === 'tools/list') {
    reply({ tools: names.map(name => ({ name, description: name, inputSchema: { type: 'object' } })) })
  } else if (request.method === 'tools/call') {
    const { name, arguments: args } = request.params
    appendFileSync(log, JSON.stringify({ name, args }) + '\n')
    const failing = name === 'browser_tabs' && args.action === 'select' && args.index === 9
    reply({ isError: failing, content: [{ type: 'text', text: failing ? 'No tab 9' : name + ' ok' }] })
  } else throw new Error('Unexpected method: ' + request.method)
})
`
const PLAYWRIGHT_TOOLS = ['browser_tabs', 'browser_navigate', 'browser_snapshot', 'browser_take_screenshot', 'browser_click', 'browser_press_key']

interface Harness {
  run(operation: InteractionOperation): Promise<unknown>
  calls(): Promise<Array<{ name: string; args: Record<string, unknown> }>>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function start(tools: readonly string[], extra: Partial<SessionMcpOptions> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-targeting-'))
  const script = join(root, 'server.mjs')
  const log = join(root, 'calls.jsonl')
  await writeFile(script, serverSource)
  await writeFile(log, '')
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  provideWorkingDirectoryFixture(ctx, root)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUse)
  await ctx.plugin(Interaction)
  ctx.llm.registerAdapter(['idle'], new IdleModel())
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin({ name: 'target-browser', inject: ['tools', 'browserUse', 'agents', 'systemPrompt'], apply(inner: Context) {
    mountSessionMcp(inner, { name: 'target-fixture', exclusive: false, command: process.execPath, args: [script, log, ...tools], ...extra })
  } })
  const agent = await harness.create(SessionId('mcp-targeting'), { provider: 'idle', model: 'fixture' })
  const signal = new AbortController().signal
  return {
    run: operation => ctx.interaction.run(agent, 'browser', operation, signal),
    calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { name: string; args: Record<string, unknown> }),
  }
}

describe('explicit tab targeting on a current-tab provider', () => {
  it.each<[string, BrowserOperation, { name: string; args: Record<string, unknown> }]>([
    ['navigate', { domain: 'browser', method: 'navigate', tabId: '1', url: 'https://a.invalid/' }, { name: 'browser_navigate', args: { url: 'https://a.invalid/' } }],
    ['observe', { domain: 'browser', method: 'observe', tabId: '1' }, { name: 'browser_snapshot', args: {} }],
    ['screenshot', { domain: 'browser', method: 'screenshot', tabId: '1' }, { name: 'browser_take_screenshot', args: {} }],
    ['act', { domain: 'browser', method: 'act', tabId: '1', action: { kind: 'press_key', key: 'Enter' } }, { name: 'browser_press_key', args: { key: 'Enter' } }],
  ])('selects the tab before %s', async (_label, operation, expected) => {
    const harness = await start(PLAYWRIGHT_TOOLS)
    await harness.run(operation)
    expect(await harness.calls()).toEqual([{ name: 'browser_tabs', args: { action: 'select', index: 1 } }, expected])
  })

  it('leaves the active tab alone when no tab is requested', async () => {
    const harness = await start(PLAYWRIGHT_TOOLS)
    await harness.run({ domain: 'browser', method: 'navigate', url: 'https://a.invalid/' })
    expect(await harness.calls()).toEqual([{ name: 'browser_navigate', args: { url: 'https://a.invalid/' } }])
  })

  it('rejects a desktop operation without calling the browser server', async () => {
    const harness = await start(PLAYWRIGHT_TOOLS)
    await expect(harness.run({ domain: 'desktop', method: 'observe' })).rejects.toThrow('received a desktop operation')
    expect(await harness.calls()).toEqual([])
  })

  it.each(['abc', '-1', '1.5', ''])('rejects the invalid tab id %j before any provider call', async (tabId) => {
    const harness = await start(PLAYWRIGHT_TOOLS)
    await expect(harness.run({ domain: 'browser', method: 'navigate', tabId, url: 'https://a.invalid/' })).rejects.toThrow('non-negative integer')
    expect(await harness.calls()).toEqual([])
  })

  it('does not run the operation when the tab selection fails', async () => {
    const harness = await start(PLAYWRIGHT_TOOLS)
    const result = await harness.run({ domain: 'browser', method: 'navigate', tabId: '9', url: 'https://a.invalid/' })
    expect(result).toMatchObject({ isError: true })
    expect(await harness.calls()).toEqual([{ name: 'browser_tabs', args: { action: 'select', index: 9 } }])
  })

  it('rejects targeting before mutating when the catalog cannot select a tab', async () => {
    const harness = await start(['browser_navigate'])
    await expect(harness.run({ domain: 'browser', method: 'navigate', tabId: '1', url: 'https://a.invalid/' })).rejects.toThrow('browser_tabs')
    expect(await harness.calls()).toEqual([])
  })

  it('rejects a tabId on list and new, and select without one', async () => {
    const harness = await start(PLAYWRIGHT_TOOLS)
    await expect(harness.run({ domain: 'browser', method: 'tabs', operation: 'list', tabId: '1' })).rejects.toThrow('does not accept a tabId')
    await expect(harness.run({ domain: 'browser', method: 'tabs', operation: 'new', tabId: '1' })).rejects.toThrow('does not accept a tabId')
    await expect(harness.run({ domain: 'browser', method: 'tabs', operation: 'select' })).rejects.toThrow('requires a tabId')
    expect(await harness.calls()).toEqual([])
  })

  it('advertises only the methods the live catalog can execute', async () => {
    const ctx = new Context()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-methods-'))
    cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    const script = join(root, 'server.mjs')
    await writeFile(script, serverSource)
    provideWorkingDirectoryFixture(ctx, root)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(BrowserUse)
    await ctx.plugin(Interaction)
    ctx.llm.registerAdapter(['idle'], new IdleModel())
    const harness = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin({ name: 'method-browser', inject: ['tools', 'browserUse', 'agents', 'systemPrompt'], apply(inner: Context) {
      mountSessionMcp(inner, { name: 'target-fixture', exclusive: false, command: process.execPath, args: [script, join(root, 'log'), 'browser_navigate', 'browser_snapshot'] })
    } })
    expect(ctx.interaction.describe('browser')?.methods).toEqual(['navigate', 'tabs', 'observe', 'act', 'screenshot'])
    const agent = await harness.create(SessionId('mcp-methods'), { provider: 'idle', model: 'fixture' })
    expect(ctx.interaction.describe('browser')?.methods).toEqual(['navigate', 'observe'])
    expect(ctx.interaction.available(agent, 'browser', 'tabs')).toBe(false)
    expect(ctx.interaction.available(agent, 'browser', 'navigate')).toBe(true)
    await harness.create(SessionId('mcp-methods-second'), { provider: 'idle', model: 'fixture' })
    expect(ctx.interaction.describe('browser')?.methods).toEqual(['navigate', 'observe'])
  })
})
