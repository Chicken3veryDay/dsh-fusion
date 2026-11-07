/** Delivery admission shares the documented declaring-host withdrawal cutoff. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { DeliveryId, type AdmissionSnapshot } from '../src/index.ts'
import { mount } from './harness.ts'

it('admits delivery while the host is active and refuses after the host drain completes', async () => {
  const { ctx, adapter } = await mount()
  const declaring = createScope(ctx, {})
  const task = await ctx.fusionParticipants.prepare('single-test')
  const host = await declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, {
    name: 'delivery-active-control', revision: '1', classify: () => 'read',
    registerHeld() { throw new Error('execution not requested') },
  })
  const input = { deliveryId: DeliveryId('ordinary-input'), targetParticipantId: task.roster.roles.participant!,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'ordinary input' }
  try {
    expect((await task.delivery.admitUser(input)).deliveryId).toBe(input.deliveryId)
    await declaring.ctx.fiber.restart()
    const before = task.delivery.snapshot()
    await expect(task.delivery.admitUser({ ...input, deliveryId: DeliveryId('after-drain') })).rejects.toThrow()
    expect(task.delivery.snapshot()).toEqual(before)
    expect(adapter.requests).toHaveLength(0)
  } finally { await declaring.dispose(); await host.dispose(); await task.dispose() }
})

it.each(['before', 'after'] as const)('refuses delivery on declaring-host reload with an observer installed %s enrollment', async (order) => {
  const { ctx, adapter } = await mount()
  const declaring = createScope(ctx, {})
  const task = await ctx.fusionParticipants.prepare('single-test')
  let observation: AdmissionSnapshot | undefined
  let pending: Promise<string> | undefined
  let observed = false
  const observe = () => ctx.root.on('internal/status', (fiber) => {
    if (fiber !== declaring.ctx.fiber || fiber.state !== FiberState.UNLOADING) return
    observed = true
    pending = task.delivery.admitUser({ deliveryId: DeliveryId('host-reload-input'),
      targetParticipantId: task.roster.roles.participant!, inboxTarget: 'next-turn', correlationId: null,
      text: 'must not reserve after host withdrawal' }).then(() => 'accepted', () => 'refused')
    observation = task.delivery.snapshot()
  })
  let remove: (() => void) | undefined
  if (order === 'before') remove = observe()
  const host = await declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, {
    name: 'delivery-withdrawal-probe', revision: '1', classify: () => 'read',
    registerHeld() { throw new Error('execution not requested') },
  })
  if (order === 'after') remove = observe()
  const before = task.delivery.snapshot()
  try {
    await declaring.ctx.fiber.restart()
    expect(await pending).toBe('refused')
    expect(observed).toBe(true)
    expect(adapter.requests).toHaveLength(0)
    expect(observation).toEqual(before)
  } finally {
    remove?.()
    await declaring.dispose()
    await host.dispose()
    await task.dispose()
  }
})

it('refuses new delivery while a withdrawn host waits for admitted producer cleanup', async () => {
  const { ctx, adapter } = await mount()
  const declaring = createScope(ctx, {})
  const task = await ctx.fusionParticipants.prepare('single-test')
  const resident = await task.adopt('participant')
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  let cleanups = 0, bodies = 0, stopped = false
  const host = await declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, {
    name: 'delivery-during-cleanup', revision: '1', classify: () => 'read',
    registerHeld() {
      return { async prepare() { return { async invoke() { bodies++; return 'completed' as const } } },
        cancel() {}, async cleanup() { entered.resolve(undefined); await resume.promise; cleanups++ } }
    },
  })
  const attempt = host.reserve(host.bindRun(host.issuer, resident.agent, new AbortController().signal), 'inspect')
  await host.register(attempt)
  const stopping = declaring.dispose().then(() => { stopped = true })
  try {
    await entered.promise
    expect(stopped).toBe(false)
    expect(declaring.ctx.fiber.uid).toBeNull()
    const outcome = await task.delivery.admitUser({ deliveryId: DeliveryId('during-host-cleanup'),
      targetParticipantId: resident.agent.id, inboxTarget: 'next-turn', correlationId: null,
      text: 'new durable instruction during host teardown' }).then(() => 'accepted', () => 'refused')
    if (outcome === 'accepted') {
      const reader = await ctx.sessionPersistence.open(resident.agent.id, 'read')
      try {
        const events = (await reader.read()).events
        expect(events.filter(event => event.type === 'fusion/delivery-accepted')).toHaveLength(1)
        expect(events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(1)
      } finally { await reader.close() }
    }
    expect(adapter.requests).toHaveLength(0)
    expect(bodies).toBe(0)
    expect(outcome).toBe('refused')
  } finally {
    resume.resolve(undefined)
    await stopping
    expect(cleanups).toBe(1)
    await host.dispose(); await resident.dispose(); await task.dispose()
  }
})
