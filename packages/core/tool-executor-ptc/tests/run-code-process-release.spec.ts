/** Every process a `run_code` call spawns, and its `dsh-subprocess-*` scope, is gone once it settles by completion, abort, or timeout. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

/** Live `dsh-subprocess-*` units this worker launched (the unit name carries its pid), or `undefined` where systemd cannot list them. */
async function liveScopes(): Promise<string[] | undefined> {
  try {
    const { stdout } = await promisify(execFile)('systemctl', ['--user', 'list-units', 'dsh-subprocess-*', '--all', '--no-legend', '--plain'])
    return stdout.split('\n').map(line => line.trim())
      .filter(line => line.startsWith(`dsh-subprocess-${process.pid}-`) && /\s(active|activating|deactivating)\s/.test(line))
  } catch (_noSystemd) {
    return undefined
  }
}

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'ptc' } })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(NodeRuntime)
  const entered = Promise.withResolvers<undefined>()
  ctx.tools.register(defineTool({
    name: 'hang', description: 'Block until the call is aborted.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(_args, exec) {
      entered.resolve(undefined)
      return new Promise<string>((_resolve, reject) => {
        exec.signal.addEventListener('abort', () => { reject(new Error('hang aborted')) }, { once: true })
      })
    },
  }))
  const handles: SubprocessHandle[] = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = spawn(spec)
    handles.push(handle)
    return handle
  })
  const agent = await harness.create(SessionId('release'), { provider: 'mock', model: 'mock' })
  const run = (args: object, signal: AbortSignal) => executeModelToolFixture(ctx, {
    signal, callId: ToolCallId('release-call'), name: 'run_code', arguments: { description: 'Exercise release', ...args }, agent,
  })
  return { run, handles, entered: entered.promise }
}

/** Every spawned process's managed range is empty, and no unit of this run's scopes remains. */
async function expectReleased(handles: SubprocessHandle[]): Promise<void> {
  expect(handles.length).toBeGreaterThan(0)
  const emptied = await Promise.all(handles.map(handle => handle.waitForExit(AbortSignal.timeout(10_000))))
  expect(emptied).toEqual(handles.map(() => true))
  const scopes = await liveScopes()
  if (scopes !== undefined) expect(scopes).toEqual([])
}

describe('run_code runtime process release', () => {
  it('releases the runtime process and scope after a program completes', async () => {
    const { run, handles } = await boot()
    const result = await run({ code: 'return 1 + 1' }, new AbortController().signal)
    expect(result.isError).toBe(false)
    await expectReleased(handles)
  })

  it('releases them when the caller aborts a program blocked in a nested call', async () => {
    const { run, handles, entered } = await boot()
    const controller = new AbortController()
    const result = run({ code: 'return await tools.hang({})' }, controller.signal)
    await entered
    const scopes = await liveScopes()
    if (scopes !== undefined) expect(scopes.length).toBeGreaterThan(0)
    controller.abort(new Error('caller gave up'))
    expect((await result).isError).toBe(true)
    await expectReleased(handles)
  })

  it('releases them when the program times out inside a nested call', async () => {
    const { run, handles } = await boot()
    const result = await run({ code: 'return await tools.hang({})', timeoutMs: 800 }, new AbortController().signal)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('timeout')
    await expectReleased(handles)
  })

  it('releases them when the program throws', async () => {
    const { run, handles } = await boot()
    const result = await run({ code: "throw new Error('program failed')" }, new AbortController().signal)
    expect(result.isError).toBe(true)
    await expectReleased(handles)
  })
})
