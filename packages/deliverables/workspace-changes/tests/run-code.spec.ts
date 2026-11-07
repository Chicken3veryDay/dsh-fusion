/** File edits made by nested tool calls of a Node PTC `run_code` program are attributed to the turn's Review record. */
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { useProcessGroupContainment } from '@deepseek-ai/dsh-subprocess-testkit'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as WorkspaceChanges from '../src/index.ts'
import { changes, endTurn, git, scratchDir, settle, startTurn } from './support.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

async function boot(environment: 'non-git' | 'git-unavailable' | 'git') {
  const cwd = await realpath(await scratchDir('dsh-run-code-review-', cleanups))
  if (environment === 'git') git(cwd, 'init', '-q', '-b', 'main')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'ptc' } })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  useProcessGroupContainment(ctx)
  if (environment === 'git-unavailable') {
    const resolve = ctx.subprocess.resolveExecutable.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation((name, ...args) => {
      if (name === 'git') return Promise.reject(new Error('git unavailable in this fixture'))
      return resolve(name, ...args)
    })
  }
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(NodeRuntime)
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  await ctx.plugin(WorkspaceChanges)
  const agent = await harness.create(SessionId('run-code-review'), { provider: 'mock', model: 'mock' }, { cwd })
  const session = agent.session
  const signal = new AbortController().signal
  let callNumber = 0
  /** Log and run one `run_code` call the way the agent loop does: call, nested dispatches, then one result. */
  async function program(code: string) {
    const callId = ToolCallId(`run-code-review-${++callNumber}`)
    const args = { code, description: 'Edit files through nested calls' }
    const serialized = JSON.stringify(args)
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: serialized }],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
    }, { surfaceOp: 'append' })
    const source = session.append('tool/call', { turn: 1, step: 1, callId, name: 'run_code', arguments: serialized })
    const result = await executeModelToolFixture(ctx, { signal, callId, name: 'run_code', arguments: args, agent })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      ...result.meta === undefined ? {} : { meta: result.meta },
    }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    return result
  }
  async function finish() {
    endTurn(session, 1)
    await settle(ctx, session)
    return changes(ctx, session)
  }
  return { ctx, cwd, session, program, finish, seed: (path: string, text: string) => writeFile(join(cwd, path), text),
    bytes: (path: string) => readFile(join(cwd, path), 'utf8') }
}

describe.each(['non-git', 'git-unavailable', 'git'] as const)('run_code Review in %s', (environment) => {
  it('lists edits made by nested read, edit and write calls with their first baselines', async () => {
    const t = await boot(environment)
    await t.seed('a', 'old\n')
    startTurn(t.session, 1)
    const result = await t.program(`
      await tools.read({ file_path: 'a' })
      await tools.edit({ file_path: 'a', old_string: 'old', new_string: 'new' })
      await tools.edit({ file_path: 'a', old_string: 'new', new_string: 'final' })
      await tools.write({ file_path: 'b', content: 'created\\n' })
      return 'ok'`)
    expect(result.isError).toBe(false)
    expect(t.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(4)
    const [summary] = await t.finish()
    expect(summary?.files).toEqual([
      { path: 'a', display: 'a', added: 1, deleted: 1 },
      { path: 'b', display: 'b', added: 1, deleted: 0 },
    ])
    expect(await t.bytes('a')).toBe('final\n')
  })

  it('still records a program whose nested edit succeeded before the program itself failed', async () => {
    const t = await boot(environment)
    await t.seed('a', 'old\n')
    startTurn(t.session, 1)
    const result = await t.program(`
      await tools.read({ file_path: 'a' })
      await tools.edit({ file_path: 'a', old_string: 'old', new_string: 'new' })
      throw new Error('program failed after the edit')`)
    expect(result.isError).toBe(true)
    const [summary] = await t.finish()
    expect(summary?.files).toEqual([{ path: 'a', display: 'a', added: 1, deleted: 1 }])
  })
})
