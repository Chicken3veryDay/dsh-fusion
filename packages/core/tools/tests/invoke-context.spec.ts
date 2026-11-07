/** Host invocations take approval and pipeline listeners from the invoking context, in any call order. */
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

type Outcome = 'allowed-once' | 'rejected'

function approval(outcome: Outcome, asked: string[], label: string): Pick<ApprovalService, 'request'> {
  return { request: () => { asked.push(label); return Promise.resolve(outcome) } }
}

async function harness(rootOutcome: Outcome, realmOutcome: Outcome) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const asked: string[] = []
  ctx.provide('approval', approval(rootOutcome, asked, 'root'))
  const agent = { id: SessionId('invoke-context'), session: Session.create(SessionId('invoke-context')) } as Agent
  const executed: string[] = []
  const handle = ctx.tools.register(defineTool({
    name: 'probe', description: 'Side-effecting operation that needs approval.', parameters: {}, output,
    execute: async (_args, exec) => { executed.push(exec.callId); return 'ran' },
  }))
  ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'ask' }))
  const realm = ctx.isolate('approval')
  const observed: string[] = []
  let realmCtx!: Context
  const realmFiber = realm.plugin(Object.assign((inner: Context) => {
    inner.provide('approval', approval(realmOutcome, asked, 'realm'))
    inner.on('tools/result', (exec) => { observed.push(exec.callId) })
    realmCtx = inner
  }, { inject: ['tools'] }))
  await realmFiber
  const invoke = (caller: Context, id: string) => caller.tools.invoke({
    registration: handle.registration, agent, signal: new AbortController().signal, callId: ToolCallId(id), arguments: {},
  })
  return { ctx, realmCtx, realmFiber, invoke, asked, executed, observed }
}

it.each([
  ['root first', ['root', 'realm']],
  ['realm first', ['realm', 'root']],
  ['interleaved', ['root', 'realm', 'root', 'realm']],
] as const)('decides each invocation with its own context approval: %s', async (_label, order) => {
  const h = await harness('rejected', 'allowed-once')
  const outcomes: string[] = []
  for (const [index, caller] of order.entries()) {
    const result = await h.invoke(caller === 'root' ? h.ctx : h.realmCtx, `${caller}-${index}`)
    outcomes.push(`${caller}:${result.isError ? 'denied' : 'ran'}`)
  }
  expect(outcomes).toEqual(order.map(caller => `${caller}:${caller === 'root' ? 'denied' : 'ran'}`))
  expect(h.asked).toEqual([...order])
  expect(h.executed).toEqual(order.flatMap((caller, index) => caller === 'realm' ? [`realm-${index}`] : []))
})

it('decides concurrent invocations from different contexts independently', async () => {
  const h = await harness('allowed-once', 'rejected')
  const [root, realm] = await Promise.all([h.invoke(h.ctx, 'root'), h.invoke(h.realmCtx, 'realm')])
  expect({ root: root.isError, realm: realm.isError, executed: h.executed }).toEqual({ root: false, realm: true, executed: ['root'] })
})

it('stops consulting a disposed realm after it invoked first', async () => {
  const h = await harness('rejected', 'allowed-once')
  expect((await h.invoke(h.realmCtx, 'realm')).isError).toBe(false)
  expect(h.observed).toEqual(['realm'])
  await h.realmFiber.dispose()
  const result = await h.invoke(h.ctx, 'root')
  expect({ isError: result.isError, asked: h.asked, executed: h.executed, observed: h.observed }).toEqual({
    isError: true, asked: ['realm', 'root'], executed: ['realm'], observed: ['realm'],
  })
})
