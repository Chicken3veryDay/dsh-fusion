/** The helper moves a local runtime off per-spawn systemd scopes on Linux and refuses other providers. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, onTestFinished } from 'vitest'
import { useProcessGroupContainment } from '../src/index.ts'

async function mount(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalSubprocessRuntime)
  return ctx
}

async function childCgroup(runtime: SubprocessRuntime): Promise<string> {
  const spec: SubprocessSpawnSpec = {
    argv: ['cat', '/proc/self/cgroup'],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096, spill: { maxBytes: 4096 } }, stderr: 'pipe' },
    graceMs: 200,
  }
  const handle = runtime.spawn(spec)
  const result = await handle.done
  expect(result.exitCode).toBe(0)
  return handle.collected.stdout!.readFrom(0).text
}

const linux = process.platform === 'linux'

it.runIf(linux)('keeps the spawned command in the host cgroup instead of a dsh-subprocess scope', async () => {
  const ctx = await mount()
  useProcessGroupContainment(ctx)
  expect(await childCgroup(ctx.subprocess)).toBe(readFileSync('/proc/self/cgroup', 'utf8'))
})

it.runIf(linux)('preserves the other runtime internals', async () => {
  const ctx = await mount()
  const taskkill = (): void => {}
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { taskkill }
  useProcessGroupContainment(ctx)
  expect((ctx.subprocess as LocalSubprocessRuntime).internals).toEqual({ taskkill, platform: 'darwin' })
})

it('rejects a composition that does not mount the local runtime', () => {
  expect(() => { useProcessGroupContainment(new Context()) }).toThrow('does not mount the local subprocess runtime')
})
