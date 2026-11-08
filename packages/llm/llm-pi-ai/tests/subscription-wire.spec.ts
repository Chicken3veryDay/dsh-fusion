/**
 * Recorded wire shapes for the subscription providers DSH signs in to directly:
 * ChatGPT's Codex Responses backend and GitHub Copilot. Nothing here reaches a
 * vendor; each case replays a scripted response and asserts what DSH sent and
 * what it made of the reply. Anything only a live subscription can show is
 * listed in the package README.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as PiAi from '../src/index.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
const ACCOUNT_TOKEN = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_fixture' } })

/** A context holding a stored ChatGPT sign-in and a Codex route aimed at the scripted server. */
async function signedInCodex(baseURL: string): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-codex-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai-codex'), () => Promise.resolve({
    kind: 'grant',
    payload: { type: 'oauth', access: ACCOUNT_TOKEN, refresh: 'r', expires: Date.now() + 3_600_000 },
  }))
  await ctx.plugin(PiAi, { providers: { 'openai-codex': { baseURL } } })
  return ctx
}

/** A Codex Responses stream: reasoning with replay state, then one `run_code` call. */
function runCodeTurn(): string[] {
  const items = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-reasoning', summary: [{ type: 'summary_text', text: 'plan' }] },
    {
      type: 'function_call', id: 'fc_1', call_id: 'call_run', name: 'run_code',
      arguments: JSON.stringify({ code: 'return await tools.read({ path: "a.txt" })' }),
    },
  ]
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
    ...items.flatMap((item, output_index) => [
      JSON.stringify({ type: 'response.output_item.added', output_index, item }),
      JSON.stringify({ type: 'response.output_item.done', output_index, item }),
    ]),
    JSON.stringify({ type: 'response.completed', response: {
      id: 'resp_1', status: 'completed', output: items,
      usage: {
        input_tokens: 120, output_tokens: 40, total_tokens: 160,
        input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 25 },
      },
    } }),
  ]
}

const RUN_CODE = {
  name: 'run_code',
  description: 'Run a program against the available tools.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}

describe('Codex Responses tool turn over a signed-in grant', () => {
  it('streams a run_code call with its reasoning and usage buckets, then replays both on the next request', async () => {
    const server = await mockServer([{ events: runCodeTurn() }, { events: runCodeTurn().slice(0, 1) }])
    const ctx = await signedInCodex(server.url)
    const model = (await ctx.llm.listModels('openai-codex'))[0]!.id
    const history: Message[] = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read a.txt.' }] })]

    const first = await assemble(ctx, { provider: 'openai-codex', model, messages: history, tools: [RUN_CODE] })

    expect(first.finish).toEqual({ kind: 'tool-calls' })
    const call = first.message.content.find(block => block.type === 'tool-call')
    expect(call).toMatchObject({ name: 'run_code' })
    expect(JSON.parse(call?.type === 'tool-call' ? call.arguments : '{}')).toEqual({ code: 'return await tools.read({ path: "a.txt" })' })
    expect(first.usage).toMatchObject({ inputTokens: 20, cacheReadTokens: 100, outputTokens: 40, reasoningTokens: 25 })
    const sent = server.requests[0] as { tools?: { name: string; parameters: unknown }[]; stream?: boolean; store?: boolean }
    expect(sent.tools?.map(entry => entry.name)).toEqual(['run_code'])
    expect(sent.tools?.[0]?.parameters).toMatchObject({ required: ['code'] })

    if (call === undefined || call.type !== 'tool-call') throw new Error('expected a tool call')
    history.push(first.message, createToolResultMessage({
      callId: call.id, content: [{ type: 'text', text: 'file body' }], isError: false,
    }))
    await assemble(ctx, { provider: 'openai-codex', model, messages: history, tools: [RUN_CODE] })

    const input = (server.requests[1] as { input: Record<string, unknown>[] }).input
    expect(input.find(item => item['type'] === 'reasoning')).toMatchObject({ encrypted_content: 'enc-reasoning' })
    expect(input.find(item => item['type'] === 'function_call')).toMatchObject({ name: 'run_code', call_id: 'call_run' })
    expect(input.find(item => item['type'] === 'function_call_output')).toMatchObject({ call_id: 'call_run' })
    expect(server.paths).toEqual(['/codex/responses', '/codex/responses'])
  })

  it('stops at one request when the caller cancels an open stream', async () => {
    const server = await mockServer([{ events: runCodeTurn().slice(0, 1), holdOpen: true }, { events: runCodeTurn() }])
    const ctx = await signedInCodex(server.url)
    const model = (await ctx.llm.listModels('openai-codex'))[0]!.id
    const controller = new AbortController()

    const pending = assemble(ctx, { provider: 'openai-codex', model, messages: [], signal: controller.signal })
    await server.requestReceived
    controller.abort()

    expect((await pending).finish.kind).toBe('aborted')
    await server.responseClosed
    expect(server.paths).toEqual(['/codex/responses'])
  })

  it('takes model capabilities from the installed catalog', async () => {
    const ctx = await signedInCodex('http://127.0.0.1:9')

    const models = await ctx.llm.listModels('openai-codex')
    const info = await ctx.llm.resolveModelInfo('openai-codex', models[0]!.id)

    expect(models.length).toBeGreaterThan(0)
    // Image input is whatever the catalog declares per model, not an assumption of this adapter.
    expect(models.some(model => model.inputModalities?.includes('image'))).toBe(true)
    expect(info.reasoning?.efforts.length).toBeGreaterThan(0)
  })
})

describe('GitHub Copilot routing over a signed-in grant', () => {
  async function copilot(): Promise<Context> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-copilot-wire-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
    await ctx.credentials.modifyRecord(PiAi.recordKeyFor('github-copilot'), () => Promise.resolve({
      kind: 'grant',
      payload: { type: 'oauth', access: 'tid=1;exp=9999999999', refresh: 'gh-refresh', expires: Date.now() + 3_600_000 },
    }))
    await ctx.plugin(PiAi)
    return ctx
  }

  // Offline by construction: the account's endpoint comes from its token, so the request is
  // observed at `fetch` and answered from the script instead of reaching GitHub.
  it.each([
    { model: 'claude-sonnet-5', path: '/v1/messages?beta=true' },
    { model: 'gpt-5.4-mini', path: '/responses' },
    { model: 'gemini-3.5-flash', path: '/chat/completions' },
  ])('sends $model to $path with the Copilot headers and maps a 402 to a quota failure', async ({ model, path }) => {
    const seen: { url: string; headers: Headers }[] = []
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers) })
      return Promise.resolve(new Response('{"error":{"message":"scripted"}}', { status: 402, headers: { 'retry-after': '5' } }))
    })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const ctx = await copilot()

    const { finish } = await assemble(ctx, { provider: 'github-copilot', model, messages: [] })

    expect(finish).toMatchObject({ kind: 'error', failure: { code: 'QUOTA', status: 402, providerRetryAfterMs: 5000 } })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(`https://api.individual.githubcopilot.com${path}`)
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer tid=1;exp=9999999999')
    expect(seen[0]?.headers.get('copilot-integration-id')).toBe('vscode-chat')
    expect(seen[0]?.headers.get('x-initiator')).toBe('user')
  })
})
