/** A completed task must not retain host listeners on its still-live declaring scope. */
import { expect, it, vi } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { ExecutionHostProvider } from '../src/index.ts'
import { mount } from './harness.ts'

it.each(['task-first', 'declaring-first', 'failed-enrollment'] as const)(
  'releases host enrollment effects after %s cleanup', async (route) => {
    const { ctx, adapter } = await mount()
    const shared = createScope(ctx, {})
    const count = () => ctx.events['_hooks']['internal/status']?.length ?? 0
    const before = count()
    const remaining: number[] = []
    const scopes = [shared]
    try {
      for (let index = 0; index < 3; index++) {
        const task = await ctx.fusionParticipants.prepare('single-test')
        const declaring = route === 'declaring-first' ? createScope(ctx, {}) : shared
        if (declaring !== shared) scopes.push(declaring)
        const provider: ExecutionHostProvider = {
          name: 'task-host-cleanup', revision: '1', classify: () => 'read',
          registerHeld() { throw new Error('must not allocate') },
        }
        const persistence = ctx.sessionPersistence
        const reserve = route === 'failed-enrollment'
          ? vi.spyOn(persistence, 'reserveSessionWriter').mockImplementationOnce(() => { throw new Error('transient writer refusal') })
          : undefined
        try {
          const enrollment = declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
          if (route === 'failed-enrollment') await expect(enrollment).rejects.toThrow('transient writer refusal')
          else {
            const host = await enrollment
            expect(await declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)).toBe(host)
          }
          reserve?.mockRestore()
          if (route === 'declaring-first') await declaring.dispose()
          await task.dispose()
          expect(ctx.sessions.list()).toEqual([])
          // Measure before releasing a long-lived caller: task cleanup itself must release the task's listener.
          remaining.push(count() - before)
        } finally {
          reserve?.mockRestore()
          await task.dispose()
        }
      }
    } finally { for (const scope of scopes) await scope.dispose() }
    expect(adapter.requests).toHaveLength(0)
    expect(remaining).toEqual([0, 0, 0])
  },
)
