/** Round-7 review: in-place reconciliation replacements survive JSONL persistence and resume. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

const REVOKE = 'revoke probe'
const revocation = (): UserMessage => createUserMessage({ content: [{ type: 'text', text: REVOKE }], source: { kind: 'user' } })

/** Changes per turn so turn 2's step-4 snapshot is new and reconciliation must replace it. */
let revision = 'r1'

async function mount(root: string, adapter: MockAdapter, inHistory: boolean): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (inHistory) {
    adapter.systemPromptUpdate = 'in-history'
    adapter.toolUpdate = 'in-history'
  }
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineTool({
    name: 'probe', description: 'Test operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'done',
  }))
  ctx.tools.registerAdmissionPolicy(({ agent, candidates }) =>
    agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text === REVOKE))
      ? [] : candidates.keys())
  // Runtime context and a prompt section that both change when admission changes, so reconciliation
  // replaces the attempt's own unsent snapshot and in-history prompt in place.
  ctx.systemPrompt.context({ name: 'admission-fact', order: 0, text: ({ agent, toolSet }) =>
    `${revision}: probe ${ctx.tools.get('probe', agent, toolSet) === undefined ? 'disabled' : 'enabled'}` })
  ctx.systemPrompt.section({ name: 'admission-guidance', order: 0, complete: true, text: ({ agent, toolSet }) =>
    `${revision}: probe ${ctx.tools.get('probe', agent, toolSet) === undefined ? 'disabled' : 'enabled'}` })
  return ctx
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

it.each([false, true])('resumes a stored Session whose attempt replaced its unsent nodes (in-history route: %s)', async (inHistory) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-r7-resume-'))
  dirs.push(root)
  revision = 'r1'
  const id = SessionId(`review-r7-resume-${inHistory}`)
  const first = new MockAdapter([textResponse('one'), textResponse('two')])
  const ctx = await mount(root, first, inHistory)
  const agent = await ctx.agentLoop.create(id, { provider: 'mock', model: 'model' })
  await send(agent, 'first')
  // Turn 2 revokes `probe` from request context on its first attempt.
  let publish = true
  ctx.on('system-prompt/request-context', async (_context, pending, next) =>
    [...await next(), ...publish && pending.length > 0 ? [revocation()] : []])
  revision = 'r2'
  await send(agent, 'second')
  publish = false
  const sent = first.requests[1]?.messages
  const replaced = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.surfaceOp !== 'append'
    && event.data.source.kind === 'runtime-context')
  expect(replaced.length).toBeGreaterThan(0)
  expect(Session.create(agent.id, agent.session.snapshotEvents()).deriveMessages().slice(0, sent?.length)).toEqual(sent)
  await ctx.fiber.dispose()

  const next = new MockAdapter([textResponse('three')])
  const resumed = await mount(root, next, inHistory)
  try {
    const handle = await resumed.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'model' } })
    expect(handle.agent.session.deriveMessages().slice(0, sent?.length)).toEqual(sent)
    await send(handle.agent, 'third')
    const third = next.requests[0]?.messages ?? []
    const snapshots = third.filter(message => message.role === 'user' && message.source?.kind === 'runtime-context')
      .map(message => message.content.map(block => block.type === 'text' ? block.text.split('\n').at(-1) : '').join(''))
    expect({
      turnEnd: handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason,
      // The resumed request keeps every message the stored request carried, in order.
      prefixKept: sent?.every(message => third.some(candidate => candidate.id === message.id)),
      // The restored projection knows the replacement is retained, so resume adds no duplicate snapshot.
      lastSnapshot: snapshots.at(-1),
      snapshotCount: snapshots.length,
    }).toEqual({ turnEnd: { kind: 'completed' }, prefixKept: true, lastSnapshot: 'r2: probe disabled', snapshotCount: 2 })
  } finally {
    await resumed.fiber.dispose()
  }
})
