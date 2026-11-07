import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { mountRuntime } from './setup.ts'

it.each(['per-call', 'vm-script', 'persistent-in-memory'] as const)(
  'attributes an immediate detached rejection to the completed run in %s', async (executionMode) => {
    const { runtime } = await mountRuntime(new Context(), { executionMode, scriptPersistence: executionMode === 'vm-script' })
    const stateOwner = {}
    const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
    const completion = executionMode === 'per-call' ? 'return 7' : '7'
    const control = await run(executionMode === 'per-call' ? completion : `var reviewKept = 17; ${completion}`)
    expect(control.error).toBeUndefined()
    expect(control.value).toBe(7)
    const failed = await run(`void Promise.reject(new Error('detached review rejection')); ${completion}`)
    expect.soft(failed.error, `a rejected evaluation must not publish successful value ${JSON.stringify(failed.value)}`).toBeDefined()
    expect.soft(failed.value).toBeUndefined()
    const next = await run(executionMode === 'per-call' ? 'return 2' : '2')
    expect(next.error).toBeUndefined()
    expect(next.value).toBe(2)
    if (executionMode !== 'per-call') expect((await run('typeof reviewKept')).value).toBe('undefined')
  },
)
