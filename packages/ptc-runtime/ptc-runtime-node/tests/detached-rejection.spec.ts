/** Every execution mode attributes a detached rejection to the run that caused it. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { mountRuntime } from './setup.ts'

const modes = [
  { name: 'per-call', config: { executionMode: 'per-call' }, retains: false, complete: (value: number) => `return ${value}` },
  { name: 'vm-script', config: { executionMode: 'vm-script' }, retains: false, complete: String },
  { name: 'vm-script with persistence', config: { executionMode: 'vm-script', scriptPersistence: true }, retains: true, complete: String },
  { name: 'persistent-in-memory', config: { executionMode: 'persistent-in-memory' }, retains: true, complete: String },
] as const

const scenarios = [
  { name: 'completes', program: (complete: (value: number) => string) => complete(7) },
  { name: 'throws', program: () => 'throw new Error("thrown")' },
  { name: 'completes after awaiting', program: (complete: (value: number) => string) => `await new Promise(resolve => setTimeout(resolve, 20)); ${complete(7)}` },
] as const

describe.each(modes)('detached rejection in $name', (mode) => {
  it.each(scenarios)('fails the run that $name, discards retained state, and leaves the next run unaffected', async (scenario) => {
    const { runtime } = await mountRuntime(new Context(), mode.config)
    const stateOwner = {}
    const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
    if (mode.retains) expect((await run(`var kept = 17; ${mode.complete(1)}`)).value).toBe(1)
    const failed = await run(`void Promise.reject(new Error('detached matrix rejection')); ${scenario.program(mode.complete)}`)
    expect(failed.value).toBeUndefined()
    expect(failed.error?.kind).toBe('worker-exit')
    expect(failed.error?.message).toContain('detached matrix rejection')
    if (mode.retains) expect(failed.error?.message).toContain('retained variables were cleared')
    const next = await run(mode.complete(2))
    expect(next.error).toBeUndefined()
    expect(next.value).toBe(2)
    if (mode.retains) expect((await run('typeof kept')).value).toBe('undefined')
  })
})
