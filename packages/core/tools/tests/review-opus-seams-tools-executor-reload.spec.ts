/** Review probe: an accepted batch settles through its executor's pipeline after that executor's plugin unloads. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools, { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { afterEach, expect, it } from 'vitest'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] }

it('asks approval for a later call of a batch whose executor unloaded mid-batch', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  let asked = 0
  const fixedApproval: Pick<ApprovalService, 'request'> = { request: () => { asked++; return Promise.resolve('allowed-once') } }
  ctx.provide('approval', fixedApproval)
  const executorFiber = ctx.plugin(NativeToolExecutor)
  await executorFiber
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  ctx.tools.register(defineTool({
    name: 'slow', description: 'Blocks until released.', parameters: {}, output,
    execute: async () => { entered.resolve(undefined); await release.promise; return 'slow' },
  }))
  ctx.tools.register(defineTool({ name: 'guarded', description: 'Needs approval.', parameters: {}, output, execute: async () => 'guarded' }))
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => exec.name === 'guarded' ? { kind: 'ask' } : next())
  const agent = { id: SessionId('opus-exec-reload'), session: Session.create(SessionId('opus-exec-reload')) } as Agent
  const executor = ctx.tools.selectExecutor(agent)
  const batch = executor.execute({
    calls: [
      { type: 'tool-call', id: ToolCallId('a'), name: 'slow', arguments: '{}' },
      { type: 'tool-call', id: ToolCallId('b'), name: 'guarded', arguments: '{}' },
    ],
    agent, signal: new AbortController().signal,
  })
  await entered.promise
  await executorFiber.dispose()
  release.resolve(undefined)
  const settled = await batch
  expect(settled.results.map(entry => [entry.result.isError, entry.result.content[0]?.type === 'text' ? entry.result.content[0].text : ''])).toEqual([
    [false, 'slow'], [false, 'guarded'],
  ])
  expect(asked).toBe(1)
})

it('refuses a later call whose admitted tool is revoked while an earlier call of the batch runs', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let revokedRan = false
  ctx.tools.register(defineTool({
    name: 'slow', description: 'Blocks until released.', parameters: {}, output,
    execute: async () => { entered.resolve(undefined); await release.promise; return 'slow' },
  }))
  const revoke = ctx.tools.register(defineTool({ name: 'later', description: 'Revoked mid-batch.', parameters: {}, output, execute: async () => { revokedRan = true; return 'later' } }))
  const agent = { id: SessionId('opus-revoke'), session: Session.create(SessionId('opus-revoke')) } as Agent
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 't', model: 't' }, signal: new AbortController().signal })
  const batch = ctx.tools.execute({
    calls: [
      { type: 'tool-call', id: ToolCallId('a'), name: 'slow', arguments: '{}' },
      { type: 'tool-call', id: ToolCallId('b'), name: 'later', arguments: '{}' },
    ],
    agent, toolSet, signal: new AbortController().signal,
  })
  await entered.promise
  revoke()
  ctx.tools.register(defineTool({ name: 'later', description: 'Same-named replacement.', parameters: {}, output, execute: async () => { revokedRan = true; return 'replacement' } }))
  release.resolve(undefined)
  const settled = await batch
  toolSet.dispose()
  expect(settled.results[0]?.result.isError).toBe(false)
  expect(settled.results[1]?.result).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
  expect(revokedRan).toBe(false)
})
