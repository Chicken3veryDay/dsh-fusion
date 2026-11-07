/** An inert stdio browser records which tab actually receives normalized navigation. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import Interaction from '@deepseek-ai/dsh-interaction'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

interface TabState { selected: number; tabs: string[] }
const readState = async (path: string): Promise<TabState> => JSON.parse(await readFile(path, 'utf8')) as TabState
import { mountSessionMcp } from '../src/mcp.ts'

class IdleModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}
const serverSource = String.raw`
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
let selected = 0
const tabs = ['https://first.invalid/', 'https://second.invalid/']
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  if (request.method === 'server/discover') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy fixture' } }) + '\n')
  } else if (request.method === 'initialize') {
    reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tab-fixture', version: '1' } })
  } else if (request.method === 'tools/list') {
    reply({ tools: ['browser_tabs', 'browser_navigate'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })) })
  } else if (request.method === 'tools/call') {
    const { name, arguments: args } = request.params
    if (name === 'browser_tabs' && args.action === 'select') selected = args.index
    if (name === 'browser_navigate') tabs[selected] = args.url
    writeFileSync(process.argv[2], JSON.stringify({ selected, tabs }))
    reply({ content: [{ type: 'text', text: JSON.stringify({ selected, tabs }) }] })
  } else throw new Error('Unexpected method: ' + request.method)
})
`

it('navigates the supplied tabId even when another tab is active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-tabs-'))
  const script = join(root, 'server.mjs')
  const statePath = join(root, 'state.json')
  await writeFile(script, serverSource)
  const ctx = new Context()
  try {
    provideWorkingDirectoryFixture(ctx, root)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(BrowserUse)
    await ctx.plugin(Interaction)
    ctx.llm.registerAdapter(['idle'], new IdleModel())
    const harness = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin({ name: 'tab-browser', inject: ['tools', 'browserUse', 'agents', 'systemPrompt'], apply(inner: Context) {
      mountSessionMcp(inner, { name: 'tab-fixture', exclusive: false, command: process.execPath, args: [script, statePath] })
    } })
    const agent = await harness.create(SessionId('review-tab-target'), { provider: 'idle', model: 'fixture' })
    const signal = new AbortController().signal
    const run = (operation: Parameters<typeof ctx.interaction.run>[2]) => ctx.interaction.run(agent, 'browser', operation, signal)
    await run({ domain: 'browser', method: 'tabs', operation: 'select', tabId: '1' })
    expect((await readState(statePath)).selected).toBe(1)
    await run({ domain: 'browser', method: 'tabs', operation: 'select', tabId: '0' })
    await run({ domain: 'browser', method: 'navigate', tabId: '1', url: 'https://requested.invalid/' })
    expect((await readState(statePath)).tabs)
      .toEqual(['https://first.invalid/', 'https://requested.invalid/'])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
