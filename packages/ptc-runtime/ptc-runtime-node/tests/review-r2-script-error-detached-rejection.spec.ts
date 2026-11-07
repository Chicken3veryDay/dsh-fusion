/**
 * Review r2-script: process.ts delays only a successful result past Node's
 * unhandled-rejection checkpoint. A retained program that throws while it also
 * leaves an immediate detached rejection publishes its error first; the process
 * then exits, and the NEXT, unrelated program is charged with that exit.
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { mountRuntime } from './setup.ts'

it('control: a retained thrown program does not fail the next program', async () => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence: true })
  const stateOwner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
  expect((await run('throw new Error("thrown")')).error?.message).toContain('thrown')
  const next = await run('1 + 1')
  expect(next.error).toBeUndefined()
  expect(next.value).toBe(2)
})

it('attributes an immediate detached rejection to the program that threw, not to the next program', async () => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence: true })
  const stateOwner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
  const failed = await run('void Promise.reject(new Error("detached")); throw new Error("thrown")')
  expect(failed.error).toBeDefined()
  const next = await run('1 + 1')
  // The next program neither threw nor rejected; it must run (fresh state is acceptable).
  expect(next.error).toBeUndefined()
  expect(next.value).toBe(2)
})
