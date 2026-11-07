/** Reference observation through Cordis services without a platform shell or CLI process. */

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
const releases: (() => void)[] = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function output(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1_234,
    stdout: { text: JSON.stringify({ url: pullUrl(9) }), truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

function execution(result: () => Promise<ShellRunResult>): ShellExecution {
  const reader = { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) }
  return {
    status: 'completed', exitCode: 0, signal: null, done: Promise.resolve(),
    observed: { stdout: reader, stderr: reader },
    readOutput: () => ({ delta: '', lossy: false }), kill: () => false, result,
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
    return execution(async () => output())
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
  const { agent } = await ctx.agents.create({ sessionId: SessionId('reference-observer') })
  const controller = new AbortController()
  const exec: ToolExecution = {
    name: 'bash', agent,
    callId: ToolCallId('reference'), rootCallId: ToolCallId('reference'), token: Symbol('reference') as ToolExecutionToken,
    arguments: { command: 'gh pr view 9 -R octo/demo --json number' }, signal: controller.signal,
  }
  const result: ToolExecutionResult = {
    isError: false, content: [{ type: 'text', text: '{"number":9}' }],
    value: { kind: 'foreground', cwd: process.cwd(), exitCode: 0, signal: null, timedOut: false, aborted: false },
  }
  const records = () => agent.session.snapshotEvents().flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:forge-session/binding' ? [record.data] : []
  })
  const execute = vi.spyOn(ctx.shell, 'execute')
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const emit = (call: ToolExecution = exec, outcome: ToolExecutionResult = result) => { ctx.emit('tools/result', call, outcome) }
  return { ...b, agent, exec, result, controller, records, execute, warn, emit }
}

describe('review r3: Forge references under the Script default', () => {
  it.each([false, true])('records the confirmed reference when nested=%s', async (nested) => {
    const f = await fixture()
    f.emit(nested ? { ...f.exec, parent: f.exec.token } : f.exec)
    // Disposal joins every admitted lookup, so this assertion cannot race it.
    await f.service.dispose()
    expect(f.records()).toEqual([{ action: 'reference', url: pullUrl(9) }])
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
})
