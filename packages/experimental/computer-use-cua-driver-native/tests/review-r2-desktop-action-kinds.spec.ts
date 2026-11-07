/** The native adapter resolves a normalized action kind to one exact driver tool and rejects the rest before any call. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InteractionProvider } from '@deepseek-ai/dsh-interaction'
import * as NativeProvider from '../src/index.ts'
import { fixture, resetFixture } from './fixtures/cua-driver.ts'

vi.mock('@trycua/cua-driver', async () => import('./fixtures/cua-driver.ts'))

const window = { pid: { type: 'integer' }, window_id: { type: 'integer' } }
const tool = (name: string, properties: Record<string, unknown>) => ({
  name,
  description: name,
  inputSchema: { type: 'object', additionalProperties: false, properties },
})
/** `browser_type` is listed first: a substring match for "type" would route there. */
const catalog = {
  tools: [
    tool('browser_type', { tab_id: { type: 'string' }, text: { type: 'string' } }),
    tool('get_window_state', window),
    tool('type_text', { ...window, text: { type: 'string' } }),
  ],
}

let ctx: Context
let provider: InteractionProvider | undefined

beforeEach(async () => {
  resetFixture()
  fixture.list = async () => JSON.stringify(catalog)
  ctx = new Context()
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('interaction', { register(registered: InteractionProvider) { provider = registered; return () => Promise.resolve() } })
  await ctx.plugin(NativeProvider)
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

const open = async () => provider!.open({ id: 'interaction-agent' } as Agent, new AbortController().signal)

it('advertises only the methods and kinds the live catalog executes', () => {
  expect(provider?.describe()).toMatchObject({ methods: ['observe', 'screenshot', 'act'], actionKinds: ['type'] })
})

it('routes type to type_text and never to a tool that merely contains "type"', async () => {
  const session = await open()
  await session.execute({ domain: 'desktop', method: 'act', applicationId: '4242', windowId: '7', action: { kind: 'type', text: 'hi' } }, new AbortController().signal)
  expect(fixture.calls).toMatchObject([{ name: 'type_text', args: { pid: 4242, window_id: 7, text: 'hi' } }])
})

it.each(['select', 'perform_action', 'click', 'browser_type'])('rejects action kind %j before any driver call', async (kind) => {
  const session = await open()
  await expect(session.execute({ domain: 'desktop', method: 'act', action: { kind } }, new AbortController().signal)).rejects.toThrow('not supported')
  expect(fixture.calls).toEqual([])
})

it('sends a window observation with the driver\'s integer ids and rejects an unaddressable target before a call', async () => {
  const session = await open()
  await session.execute({ domain: 'desktop', method: 'observe', applicationId: '4242', windowId: '7' }, new AbortController().signal)
  expect(fixture.calls).toMatchObject([{ name: 'get_window_state', args: { pid: 4242, window_id: 7 } }])
  fixture.calls = []
  await expect(session.execute({ domain: 'desktop', method: 'observe', applicationId: 'firefox', windowId: '7' }, new AbortController().signal)).rejects.toThrow('positive integer')
  await expect(session.execute({ domain: 'desktop', method: 'observe' }, new AbortController().signal)).rejects.toThrow('needs applicationId and windowId')
  expect(fixture.calls).toEqual([])
})
