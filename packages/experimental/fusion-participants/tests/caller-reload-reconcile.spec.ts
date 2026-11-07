/** Reconciliation and adoption are admission entries too: a reloading task caller must refuse them synchronously. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { DeliveryBlockedError } from '../src/index.ts'
import { mount } from './harness.ts'

it('refuses reconcile and adopt from an observer that runs before the status fence', async () => {
  const { ctx, adapter } = await mount()
  const caller = createScope(ctx, {})
  const outcomes: Promise<string>[] = []
  let observed = false
  const remove = ctx.root.on('internal/status', (fiber) => {
    if (fiber !== caller.ctx.fiber || fiber.state !== FiberState.UNLOADING || task === undefined) return
    observed = true
    const refusal = (error: unknown): string => error instanceof DeliveryBlockedError ? 'blocked' : 'other'
    outcomes.push(task.delivery.reconcile().then(() => 'accepted', refusal))
    outcomes.push(task.adopt('participant').then(() => 'accepted', refusal))
  })
  const task = await caller.ctx.get('fusionParticipants')!.prepare('single-test')
  try {
    await caller.ctx.fiber.restart()
    expect(observed).toBe(true)
    expect(await Promise.all(outcomes)).toEqual(['blocked', 'blocked'])
    expect(adapter.requests).toHaveLength(0)
  } finally {
    remove()
    await caller.dispose()
    await task.dispose()
  }
})
