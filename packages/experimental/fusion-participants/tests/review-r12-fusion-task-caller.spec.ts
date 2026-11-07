/** Task ownership withdrawal must also fence hosts declared by another live fiber. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { mount } from './harness.ts'

it.each(['before', 'after'] as const)(
  'refuses held allocation during task-caller reload with an observer installed %s preparation', async (order) => {
    const { ctx, adapter } = await mount()
    const caller = createScope(ctx, {})
    let pending: Promise<unknown> | undefined
    let registrations = 0, cleanups = 0, bodies = 0
    let refused = false
    const observe = () => ctx.root.on('internal/status', (fiber) => {
      if (fiber !== caller.ctx.fiber || fiber.state !== FiberState.UNLOADING || host === undefined || agent === undefined) return
      try {
        const run = host.bindRun(host.issuer, agent, new AbortController().signal)
        const attempt = host.reserve(run, 'edit')
        pending = host.register(attempt).catch(() => { refused = true })
      } catch (_error: unknown) { refused = true }
    })
    let remove: (() => void) | undefined
    if (order === 'before') remove = observe()
    const task = await caller.ctx.get('fusionParticipants')!.prepare('single-test')
    const resident = await task.adopt('participant')
    const agent = resident.agent
    const host = await ctx.fusionParticipants.registerExecutionHost(task, {
      name: 'task-caller-probe', revision: '1', classify: () => 'mutation',
      registerHeld() {
        registrations++
        return {
          async prepare() { return { async invoke() { bodies++; return 'completed' as const } } },
          cancel() {}, async cleanup() { cleanups++ },
        }
      },
    })
    await host.grant(host.controller, agent.id)
    if (order === 'after') remove = observe()
    try {
      await caller.ctx.fiber.restart()
      await pending
      expect(bodies).toBe(0)
      expect(cleanups).toBe(registrations)
      expect(adapter.requests).toHaveLength(0)
      expect({ refused, registrations }).toEqual({ refused: true, registrations: 0 })
    } finally {
      remove?.()
      await caller.dispose()
      await host.dispose()
      await resident.dispose()
      await task.dispose()
    }
  },
)
