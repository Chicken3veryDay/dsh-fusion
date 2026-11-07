/** Review r4-script: a numeric `gh pr view` selector run from a `run_code` program resolves like a model-issued call. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import ShellExecutor from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { bench, pullUrl } from './fixtures.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function output(): ShellRunResult {
  return {
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1_234,
    stdout: { text: JSON.stringify({ url: pullUrl(9) }), truncated: false },
    stderr: { text: '', truncated: false },
  }
}

class LookupShell extends ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      ...request,
      workdir: request.workdir ?? process.cwd(), timeoutMs: request.timeoutMs ?? 1_234,
      onExpiry: 'kill', stdoutMaxBytes: 64_000, sandboxPolicy: request.sandboxPolicy,
    }
  }

  async execute(): Promise<ShellExecution> {
    const reader = { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) }
    return {
      status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(),
      observed: { stdout: reader, stderr: reader },
      readOutput: () => ({ delta: '', lossy: false }), kill: () => false, result: async () => output(),
    }
  }
}

async function fixture() {
  const b = await bench({ discoveryTimeoutMs: 1_234 })
  const { ctx } = b
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ShellEnv, { dshHome: process.cwd() })
  await ctx.plugin(LookupShell)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('nested-reference') })
  const result: ToolExecutionResult = {
    isError: false, content: [{ type: 'text', text: '{"number":9}' }],
    value: { kind: 'foreground', cwd: process.cwd(), exitCode: 0, signal: null, timedOut: false, aborted: false },
  }
  const records = () => agent.session.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:forge-session/binding' ? [record.data] : []
  })
  const execute = vi.spyOn(ctx.shell, 'execute')
  return { ctx, agent, result, records, execute }
}

const command = 'gh pr view 9 -R octo/demo --json number'

describe('PR reference lookup under the run_code default', () => {
  it('control: a model-issued bash call binds the resolved URL', async () => {
    const f = await fixture()
    const exec: ToolExecution = {
      name: 'bash', agent: f.agent, callId: ToolCallId('direct'), rootCallId: ToolCallId('direct'),
      token: Symbol('direct') as ToolExecutionToken, arguments: { command }, signal: new AbortController().signal,
    }
    f.ctx.emit('tools/result', exec, f.result)
    await vi.waitFor(() => { expect(f.records()).toEqual([{ action: 'reference', url: pullUrl(9) }]) })
  })

  it('a bash call a run_code program made binds the resolved URL too', async () => {
    const f = await fixture()
    // The PTC executor dispatches a nested call with `parent` set to the program's token and `callId` `<program>:ptc:<n>`.
    const program = Symbol('program') as ToolExecutionToken
    const exec: ToolExecution = {
      name: 'bash', agent: f.agent, callId: ToolCallId('prog:ptc:1'), rootCallId: ToolCallId('prog'),
      token: Symbol('nested') as ToolExecutionToken, parent: program, arguments: { command }, signal: new AbortController().signal,
    }
    f.ctx.emit('tools/result', exec, f.result)
    // A model-issued call emitted after it: once its lookup has recorded, the nested call's synchronous admission check ran long before.
    const direct: ToolExecution = {
      name: 'bash', agent: f.agent, callId: ToolCallId('direct'), rootCallId: ToolCallId('direct'),
      token: Symbol('direct') as ToolExecutionToken, arguments: { command }, signal: new AbortController().signal,
    }
    f.ctx.emit('tools/result', direct, f.result)
    await vi.waitFor(() => { expect(f.records()).toEqual([{ action: 'reference', url: pullUrl(9) }]) })
    // One lookup per completed foreground `gh pr view` call, nested or not.
    expect(f.execute.mock.calls.length, 'lookups started for [nested, direct]').toBe(2)
  })
})
