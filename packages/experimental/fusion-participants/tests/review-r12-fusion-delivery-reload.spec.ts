/** Delivery withdrawal must refuse before publishing synchronous reservation facts. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { DeliveryId, type AdmissionSnapshot } from '../src/index.ts'
import { mount } from './harness.ts'

it.each(['before', 'after'] as const)(
  'does not reserve delivery during caller reload when the observer is installed %s preparation', async (order) => {
    const { ctx, adapter } = await mount()
    const caller = createScope(ctx, {})
    let observation: AdmissionSnapshot | undefined
    let pending: Promise<unknown> | undefined
    const observe = () => ctx.root.on('internal/status', (fiber) => {
      if (fiber !== caller.ctx.fiber || fiber.state !== FiberState.UNLOADING || task === undefined) return
      pending = task.delivery.admitUser({
        deliveryId: DeliveryId('during-reload'), targetParticipantId: task.roster.roles.participant!,
        inboxTarget: 'next-turn', correlationId: null, text: 'must not reserve after withdrawal',
      }).then(() => 'accepted', () => 'refused')
      observation = task.delivery.snapshot()
    })
    let remove: (() => void) | undefined
    if (order === 'before') remove = observe()
    const task = await caller.ctx.get('fusionParticipants')!.prepare('single-test')
    if (order === 'after') remove = observe()
    const before = task.delivery.snapshot()
    const root = ctx.sessions.get(task.roster.rootSessionId)!
    try {
      await caller.ctx.fiber.restart()
      expect(await pending).toBe('refused')
      expect(adapter.requests).toHaveLength(0)
      expect(root.ownEvents().filter(event => event.type.startsWith('fusion/delivery-'))).toEqual([])
      expect(observation).toEqual(before)
    } finally {
      remove?.()
      await caller.dispose()
      await task.dispose()
    }
  },
)
