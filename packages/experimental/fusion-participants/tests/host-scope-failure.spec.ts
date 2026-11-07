import { expect, it, vi } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-scope'
import { publicFixture } from './execution-public-harness.ts'
import { mount } from './harness.ts'

it('fences execution when its declaring scope unloads with an uncertain producer cleanup', async () => {
  let scope: ReturnType<typeof createScope> | undefined
  const f = await publicFixture((ctx, task, provider) => {
    scope = createScope(ctx, {})
    return scope.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
  })
  await f.grant()
  const attempt = f.host.reserve(f.bind(), 'edit')
  await f.host.register(attempt)
  f.control.cleanupError = new Error('cleanup unavailable')
  const logger = vi.spyOn(f.ctx.logger, 'error')
  await scope!.dispose().catch(() => {})
  expect(f.task.execution.phase).toBe('blocked')
  expect(f.control.bodies).toBe(0)
  expect(f.control.cleanups).toBe(0)
  expect(logger).toHaveBeenCalled()
  await expect(f.host.dispose()).rejects.toThrow()
})

it('wraps a non-Error framework listener failure when registering a host', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const remove = ctx.on('internal/listener', (name) => {
    if (name === 'internal/status') throw 'listener unavailable'
  })
  try {
    await expect(ctx.fusionParticipants.registerExecutionHost(task, {
      name: 'listener-test', revision: '1', classify: () => undefined,
      registerHeld: () => { throw new Error('must not allocate') },
    })).rejects.toMatchObject({ reason: 'not-live', cause: 'listener unavailable' })
  } finally { remove(); await task.dispose() }
})

it('reports a failure from a framework-provided listener disposer during task cleanup', async () => {
  const { ctx } = await mount()
  let removed = 0, failing = false
  const stop = ctx.on('internal/listener', (name) => {
    if (name === 'internal/status') return () => { removed++; if (failing) throw new Error('listener cleanup unavailable') }
  })
  const task = await ctx.fusionParticipants.prepare('single-test')
  failing = true
  stop()
  await expect(task.dispose()).rejects.toThrow('participant task cleanup failed')
  expect(removed).toBeGreaterThan(0)
})
