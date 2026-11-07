/** Round-17 probes: host registration release and rollback against declaring teardown that is still in progress. */
import { expect, it, vi } from 'vitest'
import { FiberState, Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { DeliveryId } from '../src/index.ts'
import type { ExecutionHostProvider } from '../src/index.ts'
import { mount } from './harness.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { r17Declaring: Service }
}

const HOST = 'fusion-participants.execution-host'
const labels = (fiber: Context['fiber']) => fiber.getEffects().map(effect => effect.label)
const provider = (name: string): ExecutionHostProvider => ({
  name, revision: '1', classify: () => 'read',
  registerHeld() { throw new Error('must not allocate') },
})

it('releases a task-first host registration while its declaring fiber waits for a dependent to unload', async () => {
  const { ctx, adapter } = await mount()
  let declaring!: Context
  class Declaring extends Service {
    static inject = ['fusionParticipants']
    constructor(ctx: Context) { super(ctx, 'r17Declaring'); declaring = ctx }
  }
  const entered = Promise.withResolvers<undefined>(), hold = Promise.withResolvers<undefined>()
  const declaringFiber = ctx.plugin(Declaring)
  const dependentFiber = ctx.plugin({ name: 'r17-dependent', inject: ['r17Declaring'], apply(ctx: Context) {
    ctx.effect(() => async () => { entered.resolve(undefined); await hold.promise }, 'r17-dependent-hold')
  } })
  await declaringFiber.await()
  await dependentFiber.await()
  const listeners = () => ctx.events['_hooks']['internal/status']?.length ?? 0
  const before = listeners()
  const task = await ctx.fusionParticipants.prepare('single-test')
  let teardown: Promise<void> | undefined
  try {
    await declaring.fusionParticipants.registerExecutionHost(task, provider('r17-dependent-hold'))
    expect(labels(declaringFiber)).toContain(HOST)
    teardown = Promise.resolve(declaringFiber.dispose())
    await entered.promise
    // The status edge has already closed the task; the host effect has not run because a dependent still unloads.
    expect(declaringFiber.state).toBe(FiberState.UNLOADING)
    expect(['revoking', 'stopped']).toContain(task.execution.phase)
    expect(labels(declaringFiber)).toContain(HOST)
    await task.dispose()
    expect(labels(declaringFiber)).not.toContain(HOST)
    expect(ctx.sessions.list()).toEqual([])
    expect(listeners()).toBe(before)
  } finally {
    hold.resolve(undefined)
    await teardown
    await task.dispose()
  }
  expect(listeners()).toBe(before)
  expect(adapter.requests).toHaveLength(0)
})

it('keeps the declaring teardown join when enrollment rolls back during that teardown', async () => {
  const { ctx, adapter } = await mount()
  const listeners = () => ctx.events['_hooks']['internal/status']?.length ?? 0
  const base = listeners()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const declaring = createScope(ctx, {})
  const before = listeners()
  const persistence = ctx.sessionPersistence
  const original = persistence.reserveSessionWriter.bind(persistence)
  const releasing = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  let calls = 0
  const order: string[] = []
  const reserve = vi.spyOn(persistence, 'reserveSessionWriter').mockImplementation((session) => {
    calls++
    if (calls === 2) throw new Error('participant writer refusal')
    const reserved = original(session)
    if (calls === 1 && reserved.kind === 'reserved') {
      const release = reserved.reservation.release.bind(reserved.reservation)
      reserved.reservation.release = async () => {
        releasing.resolve(undefined); await resume.promise
        const released = await release()
        order.push('pin-released')
        return released
      }
    }
    return reserved
  })
  let teardown: Promise<void> | undefined
  try {
    const enrollment = declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider('r17-rollback-race'))
    const refusal = enrollment.then(() => undefined, (error: unknown) => error)
    // Enrollment acquired the root pin, refused the participant pin and now awaits the root pin's release.
    await releasing.promise
    reserve.mockRestore()
    teardown = declaring.dispose().finally(() => { order.push('teardown') })
    resume.resolve(undefined)
    const error = await refusal
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('participant writer refusal')
    await teardown
    // Declaring teardown joined the owner disposal, which waits for enrollment's partial writer rollback.
    expect(order).toEqual(['pin-released', 'teardown'])
    expect(['revoking', 'stopped']).toContain(task.execution.phase)
    expect(listeners()).toBe(before)
    await task.dispose()
    expect(ctx.sessions.list()).toEqual([])
  } finally {
    resume.resolve(undefined)
    reserve.mockRestore()
    await teardown
    await task.dispose()
  }
  expect(listeners()).toBe(base)
  expect(adapter.requests).toHaveLength(0)
})

it('refuses an exact-provider retry from another declaring fiber after rollback without accumulating registrations', async () => {
  const { ctx, adapter } = await mount()
  const base = ctx.events['_hooks']['internal/status']?.length ?? 0
  const task = await ctx.fusionParticipants.prepare('single-test')
  const resident = await task.adopt('participant')
  const first = createScope(ctx, {}), second = createScope(ctx, {}, { observeCleanup: true })
  const listeners = () => ctx.events['_hooks']['internal/status']?.length ?? 0
  const before = { listeners: listeners(), first: labels(first.ctx.fiber), second: labels(second.ctx.fiber) }
  const shared = provider('r17-cross-fiber')
  const reserve = vi.spyOn(ctx.sessionPersistence, 'reserveSessionWriter').mockImplementationOnce(() => { throw new Error('transient writer refusal') })
  try {
    await expect(first.ctx.get('fusionParticipants')!.registerExecutionHost(task, shared)).rejects.toThrow('transient writer refusal')
    reserve.mockRestore()
    for (let index = 0; index < 3; index++) {
      await expect(second.ctx.get('fusionParticipants')!.registerExecutionHost(task, shared)).rejects.toThrow('transient writer refusal')
    }
    expect({ listeners: listeners(), first: labels(first.ctx.fiber), second: labels(second.ctx.fiber) }).toEqual(before)
    // Neither rolled-back declaring lifetime still fences the task.
    await first.dispose()
    await second.dispose()
    await task.delivery.admitUser({ deliveryId: DeliveryId('r17-after-rollback'), targetParticipantId: resident.agent.id,
      inboxTarget: 'next-turn', correlationId: null, text: 'after rollback' })
    expect(task.execution.phase).toBe('closed')
    await resident.dispose()
    await task.dispose()
    expect(ctx.sessions.list()).toEqual([])
  } finally {
    reserve.mockRestore()
    await resident.dispose()
    await task.dispose()
  }
  expect(listeners()).toBe(base)
  expect(adapter.requests).toHaveLength(0)
})

it('leaves an observed declaring scope clean after task-first release', async () => {
  const { ctx, adapter } = await mount()
  const declaring = createScope(ctx, {}, { observeCleanup: true })
  const before = labels(declaring.ctx.fiber)
  for (let index = 0; index < 2; index++) {
    const task = await ctx.fusionParticipants.prepare('single-test')
    try {
      await declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider(`r17-observed-${index}`))
      expect(labels(declaring.ctx.fiber)).toContain(HOST)
    } finally { await task.dispose() }
    expect(labels(declaring.ctx.fiber)).toEqual(before)
  }
  // Observed cleanup reports every failure recorded on this lifetime, including detached host releases.
  await declaring.dispose()
  expect(ctx.sessions.list()).toEqual([])
  expect(adapter.requests).toHaveLength(0)
})
