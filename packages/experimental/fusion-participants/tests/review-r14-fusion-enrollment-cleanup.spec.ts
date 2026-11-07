/** Refused host enrollment must release its root-owned status listener. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { ExecutionHostProvider } from '../src/index.ts'
import { mount } from './harness.ts'

it.each(['active', 'unloading'] as const)('releases enrollment listeners after %s enrollment and task cleanup', async (route) => {
  const { ctx, adapter } = await mount()
  const count = () => ctx.events['_hooks']['internal/status']?.length ?? 0
  const before = count()
  const after: number[] = []
  for (let index = 0; index < 3; index++) {
    const task = await ctx.fusionParticipants.prepare('single-test')
    const declaring = createScope(ctx, {})
    const provider: ExecutionHostProvider = {
      name: 'enrollment-cleanup', revision: '1', classify: () => 'read',
      registerHeld() { throw new Error('no producer allocation expected') },
    }
    let enrollment: Promise<string> | undefined
    const remove = ctx.root.on('internal/status', (fiber) => {
      if (fiber === declaring.ctx.fiber && fiber.state === FiberState.UNLOADING && route === 'unloading') {
        enrollment = declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
          .then(() => 'accepted', () => 'refused')
      }
    })
    try {
      if (route === 'active') {
        await declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
      }
      await declaring.ctx.fiber.restart()
      if (route === 'unloading') expect(await enrollment).toBe('refused')
    } finally {
      remove()
      await declaring.dispose()
      await task.dispose()
    }
    expect(ctx.sessions.list()).toEqual([])
    after.push(count() - before)
  }
  expect(adapter.requests).toHaveLength(0)
  expect(after).toEqual([0, 0, 0])
})
