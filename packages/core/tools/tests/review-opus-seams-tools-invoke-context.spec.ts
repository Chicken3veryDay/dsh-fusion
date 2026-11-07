/** Review probe: `tools.invoke()` must route each call through its own caller's context, not the first caller's. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { afterEach, expect, it } from 'vitest'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] }

function approval(outcome: 'allowed-once' | 'rejected'): Pick<ApprovalService, 'request'> {
  return { request: () => Promise.resolve(outcome) }
}

it.each([
  ['isolated realm allows, root rejects', 'allowed-once', 'rejected'],
  ['isolated realm rejects, root allows', 'rejected', 'allowed-once'],
] as const)('routes approval through the calling context: %s', async (_label, realmOutcome, rootOutcome) => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.provide('approval', approval(rootOutcome))
  const agent = { id: SessionId('opus-invoke'), session: Session.create(SessionId('opus-invoke')) } as Agent
  let executed = 0
  const handle = ctx.tools.register(defineTool({
    name: 'probe', description: 'Side-effecting operation that needs approval.', parameters: {}, output,
    execute: async () => { executed++; return 'ran' },
  }))
  ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'ask' }))

  // A host component inside an isolated realm (as an agent preset mounts) invokes first.
  const realm = ctx.isolate('approval')
  let realmCtx!: Context
  await realm.plugin(Object.assign((inner: Context) => {
    inner.provide('approval', approval(realmOutcome))
    realmCtx = inner
  }, { inject: ['tools'] }))
  const first = await realmCtx.tools.invoke({ registration: handle.registration, agent, signal: new AbortController().signal, callId: ToolCallId('realm'), arguments: {} })
  expect(first.isError).toBe(realmOutcome === 'rejected')
  const afterRealm = executed

  // A root-scope host component invokes the same registration; root approval must decide.
  const second = await ctx.tools.invoke({ registration: handle.registration, agent, signal: new AbortController().signal, callId: ToolCallId('root'), arguments: {} })
  expect({ isError: second.isError, executed: executed - afterRealm }).toEqual(
    rootOutcome === 'rejected' ? { isError: true, executed: 0 } : { isError: false, executed: 1 },
  )
})

it('keeps routing approval after the first invoking fiber unloads', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const agent = { id: SessionId('opus-invoke-unload'), session: Session.create(SessionId('opus-invoke-unload')) } as Agent
  let executed = 0
  const handle = ctx.tools.register(defineTool({
    name: 'probe', description: 'Side-effecting operation that needs approval.', parameters: {}, output,
    execute: async () => { executed++; return 'ran' },
  }))
  let ask = false
  ctx.on('tools/pre-execute', async (_exec, next): Promise<PreToolDecision> => ask ? { kind: 'ask' } : next())
  // A short-lived host component (for example one browser session's scope) invokes first, then unloads.
  let first!: Context
  const fiber = ctx.plugin(Object.assign((inner: Context) => { first = inner }, { inject: ['tools'] }))
  await fiber
  await first.tools.invoke({ registration: handle.registration, agent, signal: new AbortController().signal, callId: ToolCallId('first'), arguments: {} })
  await fiber.dispose()
  ctx.provide('approval', approval('allowed-once'))
  ask = true
  const result = await ctx.tools.invoke({ registration: handle.registration, agent, signal: new AbortController().signal, callId: ToolCallId('later'), arguments: {} })
  expect({ isError: result.isError, text: result.content[0]?.type === 'text' ? result.content[0].text : '', executed }).toEqual({ isError: false, text: 'ran', executed: 2 })
})
