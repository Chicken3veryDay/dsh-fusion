/** Caller ancestry fences new admission while accepted held work retains its settlement route. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { DeliveryId, type ExecutionHostProvider } from '../src/index.ts'
import { mount } from './harness.ts'

it.each(['caller', 'ancestor'] as const)('fences all capability entries at the %s reload edge', async (lifetime) => {
  const { ctx, adapter } = await mount()
  const parent = lifetime === 'ancestor' ? createScope(ctx, {}) : undefined
  const caller = createScope(parent?.ctx ?? ctx, {})
  const watched = parent ?? caller
  let registrations = 0, preparations = 0, bodies = 0, cleanups = 0
  const provider: ExecutionHostProvider = {
    name: 'independent-lifetime', revision: '1', classify: () => 'mutation',
    registerHeld() {
      registrations++
      return { async prepare() { preparations++; return { async invoke() { bodies++; return 'completed' as const } } },
        cancel() {}, async cleanup() { cleanups++ } }
    },
  }
  let probe: (() => void) | undefined
  const remove = ctx.root.on('internal/status', (fiber) => {
    if (fiber === watched.ctx.fiber && fiber.state === FiberState.UNLOADING) probe?.()
  })
  const task = await caller.ctx.get('fusionParticipants')!.prepare('single-test')
  const resident = await task.adopt('participant')
  const host = await ctx.fusionParticipants.registerExecutionHost(task, provider)
  await host.grant(host.controller, resident.agent.id)
  const run = host.bindRun(host.issuer, resident.agent, new AbortController().signal)
  const unregistered = host.reserve(run, 'edit'), registered = host.reserve(run, 'edit')
  await host.register(registered)
  const before = task.delivery.snapshot()
  const outcomes: Promise<string>[] = []
  const sync: string[] = []
  let state: FiberState | undefined, observed = false
  const result = (operation: Promise<unknown>) => outcomes.push(operation.then(() => 'accepted', () => 'refused'))
  probe = () => {
    observed = true
    state = caller.ctx.fiber.state
    for (const operation of [() => host.bindRun(host.issuer, resident.agent, new AbortController().signal),
      () => host.reserve(run, 'edit')]) {
      try { operation(); sync.push('accepted') } catch (_error: unknown) { sync.push('refused') }
    }
    result(host.register(unregistered))
    outcomes.push(host.release(registered).then(settlement => settlement.kind === 'settled' ? settlement.outcome : 'blocked'))
    result(task.delivery.admitUser({ deliveryId: DeliveryId('late-ancestor-input'),
      targetParticipantId: resident.agent.id, inboxTarget: 'next-turn', correlationId: null, text: 'late input' }))
    result(task.delivery.reconcile())
    result(task.adopt('participant'))
    expect(task.delivery.snapshot()).toEqual(before)
  }
  try {
    await watched.ctx.fiber.restart()
    expect(observed).toBe(true)
    expect(state).toBe(lifetime === 'ancestor' ? FiberState.ACTIVE : FiberState.UNLOADING)
    expect(sync).toEqual(['refused', 'refused'])
    expect(await Promise.all(outcomes)).toEqual(['refused', 'not-dispatched', 'refused', 'refused', 'refused'])
    expect({ registrations, preparations, bodies, cleanups }).toEqual({ registrations: 1, preparations: 0, bodies: 0, cleanups: 1 })
    expect(adapter.requests).toHaveLength(0)
  } finally {
    probe = undefined
    remove()
    await host.dispose()
    await resident.dispose()
    await task.dispose()
    await caller.dispose()
    await parent?.dispose()
  }
})

it.each(['grant', 'enroll'] as const)('refuses %s at an ancestor reload edge', async (route) => {
  const { ctx } = await mount()
  const parent = createScope(ctx, {}), caller = createScope(parent.ctx, {})
  let probe: (() => void) | undefined
  const remove = ctx.root.on('internal/status', (fiber) => {
    if (fiber === parent.ctx.fiber && fiber.state === FiberState.UNLOADING) probe?.()
  })
  const task = await caller.ctx.get('fusionParticipants')!.prepare('single-test')
  const resident = await task.adopt('participant')
  const provider: ExecutionHostProvider = { name: 'late-enrollment', revision: '1', classify: () => 'read',
    registerHeld() { throw new Error('no allocation expected') } }
  const host = route === 'grant' ? await ctx.fusionParticipants.registerExecutionHost(task, provider) : undefined
  let outcome: Promise<string> | undefined
  probe = () => {
    expect(caller.ctx.fiber.state).toBe(FiberState.ACTIVE)
    const operation = route === 'grant' ? host!.grant(host!.controller, resident.agent.id)
      : ctx.fusionParticipants.registerExecutionHost(task, provider)
    outcome = operation.then(() => 'accepted', () => 'refused')
  }
  try {
    await parent.ctx.fiber.restart()
    expect(await outcome).toBe('refused')
    expect(task.execution.owner).toBeNull()
    expect(task.execution.generation).toBe(0)
  } finally {
    probe = undefined; remove()
    await host?.dispose(); await resident.dispose(); await task.dispose(); await parent.dispose()
  }
})

it.each(['caller', 'ancestor'] as const)('settles an admitted body after %s withdrawal', async (lifetime) => {
  const { ctx, adapter } = await mount()
  const parent = lifetime === 'ancestor' ? createScope(ctx, {}) : undefined
  const caller = createScope(parent?.ctx ?? ctx, {})
  const task = await caller.ctx.get('fusionParticipants')!.prepare('single-test')
  const resident = await task.adopt('participant')
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const cleaning = Promise.withResolvers<undefined>(), releaseCleanup = Promise.withResolvers<undefined>()
  let cleanups = 0, canceled = 0, disposed = false
  const host = await ctx.fusionParticipants.registerExecutionHost(task, {
    name: 'settlement-after-withdrawal', revision: '1', classify: () => 'mutation',
    registerHeld() {
      return { async prepare() { return { async invoke() { entered.resolve(undefined); await resume.promise; return 'completed' as const } } },
        cancel() { canceled++ }, async cleanup() { cleaning.resolve(undefined); await releaseCleanup.promise; cleanups++ } }
    },
  })
  await host.grant(host.controller, resident.agent.id)
  const attempt = host.reserve(host.bindRun(host.issuer, resident.agent, new AbortController().signal), 'edit')
  await host.register(attempt)
  const work = host.release(attempt)
  await entered.promise
  const disposal = (parent ?? caller).ctx.fiber.restart().then(() => { disposed = true })
  try {
    expect(() => host.bindRun(host.issuer, resident.agent, new AbortController().signal)).toThrow()
    resume.resolve(undefined)
    await cleaning.promise
    expect(disposed).toBe(false)
    expect(ctx.sessions.get(resident.agent.id)).toBe(resident.agent.session)
    await ctx.sessions.flush(resident.agent.session)
    releaseCleanup.resolve(undefined)
    expect(await work).toEqual({ kind: 'settled', outcome: 'completed' })
    await disposal
    expect({ cleanups, canceled }).toEqual({ cleanups: 1, canceled: 1 })
    const reader = await ctx.sessionPersistence.open(resident.agent.id, 'read')
    try {
      const events = (await reader.read()).events
      expect(events.filter(event => event.type === 'fusion/effect-started')).toHaveLength(1)
      expect(events.filter(event => event.type === 'fusion/effect-settled').map(event => event.data.outcome)).toEqual(['completed'])
    } finally { await reader.close() }
    expect(adapter.requests).toHaveLength(0)
  } finally {
    resume.resolve(undefined); releaseCleanup.resolve(undefined)
    await Promise.allSettled([work, disposal])
    await host.dispose(); await resident.dispose(); await task.dispose(); await caller.dispose(); await parent?.dispose()
  }
})
