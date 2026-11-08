/**
 * Claude account failover through the real agent loop, the real llm-retry
 * plugin, the real llm-pi-ai plugin with per-account credential documents, and a
 * local Messages endpoint that answers by bearer. A limited account must not end
 * the turn while another account can serve it, and the retry must not replay the
 * tool or the history.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as Retry from '../src/index.ts'

let root: string | undefined
let context: Context | undefined
let server: Server | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await new Promise<void>((resolve) => { server?.close(() => { resolve() }); server?.closeAllConnections() })
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

interface Seen {
  bearer: string | undefined
  body: { system: { text: string }[]; tools: { name: string }[]; messages: { role: string; content: unknown }[] }
}
type Reply = { status: number; headers?: Record<string, string>; body: string; delayMs?: number } | { events: Record<string, unknown>[] }

const token = (account: string): string => `sk-ant-oat-${account}`
const message = (id: string) => ({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } })
const text = (id: string, content: string): Reply => ({ events: [
  message(id),
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
] })
const toolUse = (id: string): Reply => ({ events: [
  message(id),
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_once', name: 'echo', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"side-effect"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 6 } },
  { type: 'message_stop' },
] })
const limited = (retryAfter?: string, delayMs?: number): Reply => ({
  status: 429,
  ...retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } },
  ...delayMs === undefined ? {} : { delayMs },
  body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }),
})
const revoked: Reply = {
  status: 401,
  body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid bearer token' } }),
}

/** A Messages endpoint whose replies are queued per account bearer, or in request order under `*`. */
async function endpoint(script: Record<string, Reply[]>): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const bearer = request.headers.authorization?.replace(/^Bearer /, '')
      seen.push({ bearer, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Seen['body'] })
      const reply = (script['*'] ?? (bearer === undefined ? undefined : script[bearer]))?.shift()
      if (reply === undefined) { response.writeHead(500).end('no scripted reply'); return }
      if ('events' in reply) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(reply.events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      } else {
        setTimeout(() => {
          response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers }).end(reply.body)
        }, reply.delayMs ?? 0)
      }
    })
  })
  await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

/** One 0600 credential document per account, each holding only that account's grant. */
async function documents(accounts: readonly string[]): Promise<{ id: string; credentialsPath: string }[]> {
  root = await mkdtemp(join(tmpdir(), 'dsh-account-failover-'))
  const entries: { id: string; credentialsPath: string }[] = []
  for (const id of accounts) {
    const credentialsPath = join(root, `${id}.credentials.yaml`)
    await writeFile(credentialsPath, [
      'version: 1', 'records:', '  llm-pi-ai/anthropic:', '    kind: grant',
      `    payload: { type: oauth, access: ${token(id)}, refresh: ${token(id)}-refresh, expires: 4102444800000 }`, '',
    ].join('\n'))
    await chmod(credentialsPath, 0o600)
    entries.push({ id, credentialsPath })
  }
  return entries
}

async function harness(
  url: string,
  accounts: readonly { id: string; credentialsPath: string }[],
  tool: () => void,
  cooldownMs = 60_000,
) {
  const ctx = new Context()
  context = ctx
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LlmPiAi, {
    providers: { anthropic: {
      baseURL: url,
      accounts,
      accountRateLimitCooldownMs: cooldownMs,
      retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 5, maxDelayMs: 50, jitterRatio: 0 } },
    } },
  })
  await ctx.plugin(Retry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'echo back',
    parameters: { text: { type: 'string' } },
    execute(args) {
      tool()
      return Promise.resolve([{ type: 'text', text: `echo: ${String(args.text)}` }])
    },
  }))
  const agent = await ctx.agentLoop.create(SessionId('account-failover'), { provider: 'anthropic', model: 'claude-haiku-4-5' })
  return { ctx, agent }
}

const run = async (agent: Awaited<ReturnType<typeof harness>>['agent']): Promise<void> => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the tool' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

const last = (agent: Awaited<ReturnType<typeof harness>>['agent']): string => {
  const final = agent.session.deriveMessages().at(-1)
  return final?.role === 'assistant' ? final.content.map(block => block.type === 'text' ? block.text : '').join('') : ''
}

describe('Claude account failover through the real loop', () => {
  it('moves a rate-limited step to the other account without replaying the tool or the history', async () => {
    const accounts = await documents(['account-1', 'account-2'])
    // The first account is a random tie, so replies go by request order: whichever account is asked
    // first is limited, and the other one serves the tool call and the final text.
    const { url, seen } = await endpoint({ '*': [limited('30'), toolUse('msg_tool'), text('msg_done', 'finished on the second account')] })
    let executions = 0
    const { agent } = await harness(url, accounts, () => { executions += 1 })
    await run(agent)

    const [limitedAccount, servingAccount] = [seen[0]?.bearer, seen[1]?.bearer]
    expect(limitedAccount).not.toBe(servingAccount)
    expect(seen.map(request => request.bearer)).toEqual([limitedAccount, servingAccount, servingAccount])
    expect(executions).toBe(1)
    expect(last(agent)).toBe('finished on the second account')
    // The retried request is the same step: identical history, no tool result before the tool ran.
    expect(seen[1]?.body.messages).toEqual(seen[0]?.body.messages)
    expect(JSON.stringify(seen[1]?.body.messages)).not.toContain('tool_result')
    expect(JSON.stringify(seen[2]?.body.messages)).toContain('tool_result')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
    // The maintained transport prefix is the only text added to the system prompt, and the main store was never touched.
    expect(seen[0]?.body.system[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
    expect(seen.every(request => request.bearer !== undefined && request.bearer.startsWith('sk-ant-oat-account-'))).toBe(true)
  })

  it('ends the turn with the earliest reset and no further inference once every account is cooling', async () => {
    const accounts = await documents(['account-1', 'account-2'])
    const { url, seen } = await endpoint({
      [token('account-1')]: [limited('3000'), limited('3000')],
      [token('account-2')]: [limited('2000'), limited('2000')],
    })
    const { agent } = await harness(url, accounts, () => undefined)
    await run(agent)

    // The first account is a random tie; each account is asked exactly once.
    expect(new Set(seen.map(request => request.bearer))).toEqual(new Set([token('account-1'), token('account-2')]))
    expect(seen).toHaveLength(2)
    // The turn ends with the earliest reset (the 2000 s account), not the 3000 s one and not a retry loop.
    const end = agent.session.snapshotEvents().find(event => event.type === 'turn/end')
    expect(end?.data.reason).toMatchObject({ kind: 'error', error: { code: 'RATE_LIMIT' } })
    const delay = end?.data.reason.kind === 'error' ? end.data.reason.error.providerRetryAfterMs : undefined
    expect(delay).toBeGreaterThan(1_900_000)
    expect(delay).toBeLessThanOrEqual(2_000_000)
    expect(last(agent)).toBe('')
  })

  it('reports an AUTH failure after the last account is rejected, with no further inference', async () => {
    const accounts = await documents(['account-1', 'account-2'])
    const { url, seen } = await endpoint({
      [token('account-1')]: [revoked, revoked],
      [token('account-2')]: [revoked, revoked],
    })
    const { agent } = await harness(url, accounts, () => undefined)
    await run(agent)

    expect(new Set(seen.map(request => request.bearer))).toEqual(new Set([token('account-1'), token('account-2')]))
    expect(seen).toHaveLength(2)
    expect(JSON.stringify(agent.session.snapshotEvents())).toContain('AUTH')
  })

  it('bounds failover per step when limits do not cool the account', async () => {
    const accounts = await documents(['account-1', 'account-2'])
    // Each answer takes longer than the 1 ms cooldown, so the limited account is eligible again at once.
    const forever = (): Reply[] => Array.from({ length: 12 }, () => limited(undefined, 10))
    const { url, seen } = await endpoint({ [token('account-1')]: forever(), [token('account-2')]: forever() })
    const { agent } = await harness(url, accounts, () => undefined, 1)
    await run(agent)

    // Two failovers for the step, then llm-retry's own bounded retries: never an unbounded loop.
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(seen.length).toBeLessThanOrEqual(1 + 2 + 2)
  })
})
