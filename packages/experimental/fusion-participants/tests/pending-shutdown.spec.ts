/** Cancellation joins real acquisition, provisioning, adoption and rejecting cleanup. */
import { setImmediate } from 'node:timers/promises'
import { CleanupObservation } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { expect, it, vi } from 'vitest'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
import Participants, { DeliveryId } from '../src/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mount } from './harness.ts'

it.each(['prepare', 'recover'] as const)('joins pending %s at acquisition, provisioning and rollback', async (operation) => {
  for (const point of ['root', 'participant', 'provision', 'rollback'] as const) {
    const { ctx, adapter } = await mount()
    const seed = await ctx.fusionParticipants.prepare('single-test')
    const id = seed.roster.rootSessionId
    await seed.dispose()
    const caller = createScope(ctx, {})
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const closes: string[] = []
    const sessions = ctx.sessions
    let calls = 0
    let live: ReturnType<typeof sessions.get>
    // oxlint-disable-next-line typescript/unbound-method -- real receiver preserved.
    const close = JsonlSessionHandle.prototype.close
    vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementation(async function (this: JsonlSessionHandle) {
      if (this.access === 'write') {
        if (point === 'rollback') { entered.resolve(undefined); await release.promise }
        closes.push(this.id)
      }
      return close.call(this)
    })
    const persistence = ctx.sessionPersistence
    const acquire = operation === 'prepare' ? persistence.create.bind(persistence) : persistence.open.bind(persistence)
    if (operation === 'prepare') {
      const create = persistence.create.bind(persistence)
      vi.spyOn(persistence, 'create').mockImplementation(async (...args) => {
        const writer = await create(...args)
        if (++calls === (point === 'participant' ? 2 : 1) && (point === 'root' || point === 'participant')) {
          live = sessions.list()[0]; entered.resolve(undefined); await release.promise
        }
        return writer
      })
    } else {
      const open = persistence.open.bind(persistence)
      vi.spyOn(persistence, 'open').mockImplementation(async (...args) => {
        const writer = await open(...args)
        if (args[1] === 'write' && ++calls === (point === 'participant' ? 2 : 1) && (point === 'root' || point === 'participant')) {
          live = sessions.list()[0]; entered.resolve(undefined); await release.promise
        }
        return writer
      })
    }
    expect(acquire).toBeTypeOf('function')
    const preset = ctx.agentPresets.mount.bind(ctx.agentPresets)
    vi.spyOn(ctx.agentPresets, 'mount').mockImplementation(async (...args) => {
      const value = await preset(...args)
      if (point === 'provision') { live = sessions.list()[0]; entered.resolve(undefined); await release.promise }
      if (point === 'rollback') throw new Error('force rollback')
      return value
    })
    const service = caller.ctx.get('fusionParticipants')!
    const pending = operation === 'prepare' ? service.prepare('single-test') : service.recover(id)
    const rejected = expect(pending).rejects.toThrow()
    await entered.promise
    const owner = [...ctx.registry.get(Participants)!.fibers][0]!
    let finished = false
    const stop = owner.dispose().then(() => { finished = true })
    const callerStop = caller.dispose()
    await setImmediate()
    try {
      expect(finished).toBe(false)
      expect(closes).toEqual([])
      if (live !== undefined) expect(sessions.get(live.id)).toBe(live)
    } finally { release.resolve(undefined) }
    await Promise.all([stop, callerStop, rejected])
    expect(sessions.list()).toHaveLength(0)
    expect(new Set(closes).size).toBe(closes.length)
    expect(adapter.requests).toHaveLength(0)
    vi.restoreAllMocks()
  }
})

it.each(['before', 'after'] as const)('reserves work before reentrant stop and closes admission (%s publication)', async (order) => {
  const { ctx, adapter } = await mount()
  const service = ctx.fusionParticipants
  const owner = [...ctx.registry.get(Participants)!.fibers][0]!
  let stopping: Promise<void> | undefined
  if (order === 'before') {
    const read = ctx.agentPresets.readDocument.bind(ctx.agentPresets)
    vi.spyOn(ctx.agentPresets, 'readDocument').mockImplementation(async (preset) => {
      stopping = owner.dispose()
      return read(preset)
    })
    await expect(service.prepare('single-test')).rejects.toThrow('disposed')
  } else {
    const task = await service.prepare('single-test')
    stopping = owner.dispose()
    await stopping
    await expect(task.adopt('participant')).rejects.toThrow()
  }
  await stopping
  const selection = vi.spyOn(ctx.fusionConfig, 'selection')
  const document = vi.spyOn(ctx.agentPresets, 'readDocument')
  document.mockClear()
  const create = vi.spyOn(ctx.sessionPersistence, 'create')
  const open = vi.spyOn(ctx.sessionPersistence, 'open')
  const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
  await expect(service.prepare('single-test')).rejects.toThrow('disposed')
  await expect(service.recover(SessionId('stopped'))).rejects.toThrow('disposed')
  for (const spy of [selection, document, create, open, stat]) expect(spy).not.toHaveBeenCalled()
  expect(adapter.requests).toHaveLength(0)
})

it.each(['flush', 'created'] as const)('joins active and queued adoption at %s without publishing after stop', async (point) => {
  const { ctx, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const closes: string[] = []
  const target = task.roster.roles.participant!
  const session = ctx.sessions.get(target)!
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (current) => {
    if (point === 'flush' && current === session) { entered.resolve(undefined); await release.promise }
    return flush(current)
  })
  let stopping: Promise<void> | undefined
  if (point === 'created') ctx.on('agent/created', async () => {
    stopping = task.dispose()
    entered.resolve(undefined)
    await release.promise
  })
  // oxlint-disable-next-line typescript/unbound-method -- real receiver preserved.
  const close = JsonlSessionHandle.prototype.close
  vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementation(function (this: JsonlSessionHandle) {
    if (this.access === 'write') closes.push(this.id)
    return close.call(this)
  })
  const adopted = task.adopt('participant')
  const rejected = expect(adopted).rejects.toThrow()
  const queued = task.adopt('participant')
  const queueRejected = expect(queued).rejects.toThrow()
  await entered.promise
  stopping ??= task.dispose()
  const duplicate = task.dispose()
  expect(duplicate).toBe(stopping)
  let settled = false
  void stopping.then(() => { settled = true })
  await setImmediate()
  try {
    expect(settled).toBe(false)
    expect(closes).toEqual([])
    expect(ctx.sessions.get(target)).toBe(session)
  } finally { release.resolve(undefined) }
  await Promise.all([stopping, duplicate, rejected, queueRejected])
  expect(ctx.agents.list()).toHaveLength(0)
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
})

it.each(['caller', 'root'] as const)('retains writers during nonsettling descendant cleanup and all failures through %s', async (route) => {
  const { ctx, adapter } = await mount()
  const observation = new CleanupObservation()
  const host = createScope(ctx.extend({ [CleanupObservation.key]: observation }), {}, { observeCleanup: true })
  const task = await host.ctx.get('fusionParticipants')!.prepare('single-test')
  const resident = await task.adopt('participant')
  const sessions = ctx.sessions
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const descendantError = new Error('descendant failed')
  const closeError = new Error('writer failed')
  const closes: string[] = []
  const logger = vi.spyOn(ctx.logger, 'error')
  await resident.agent.ctx.plugin((owner) => {
    owner.effect(() => async () => { entered.resolve(undefined); await release.promise; throw descendantError })
  })
  // oxlint-disable-next-line typescript/unbound-method -- real receiver preserved.
  const close = JsonlSessionHandle.prototype.close
  vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementation(async function (this: JsonlSessionHandle) {
    if (this.access === 'write') closes.push(this.id)
    await close.call(this)
    if (this.id === resident.agent.id) throw closeError
  })
  const stop = route === 'root' ? ctx.fiber.dispose() : host.dispose()
  const hostRejected = route === 'root' ? stop : expect(stop).rejects.toThrow()
  await entered.promise
  let settled = false
  void stop.then(() => { settled = true }, () => { settled = true })
  await setImmediate()
  try {
    expect(settled).toBe(false)
    expect(closes).toEqual([])
    const writer = ctx.sessions.get(resident.agent.id)!
    expect((await ctx.sessionPersistence.flushSessionDurably(writer)).kind).toBe('durable')
  } finally { release.resolve(undefined) }
  await hostRejected
  const failure: unknown = await task.dispose().catch((error: unknown) => error)
  const causes = (error: unknown): unknown[] => [error,
    ...error instanceof AggregateError ? error.errors.flatMap(causes) : [],
    ...error instanceof Error && error.cause !== undefined ? causes(error.cause) : [],
  ]
  expect(causes(failure)).toContain(descendantError)
  expect(causes(failure)).toContain(closeError)
  if (route === 'root') await expect(host.dispose()).rejects.toThrow()
  expect(logger).toHaveBeenCalled()
  expect(sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
  const observed: unknown = await observation.settle().catch((error: unknown) => error)
  expect(causes(observed)).toContain(descendantError)
  expect(causes(observed)).toContain(closeError)
})

it('publishes the owner join before synchronous cancellation reentrancy and retains duplicate cleanup results', async () => {
  const { ctx } = await mount()
  const service = ctx.fusionParticipants
  const task = await service.prepare('single-test')
  const stop: unknown = Reflect.get(service, 'stop')
  if (typeof stop !== 'function') throw new Error('missing owner cleanup driver')
  const first: unknown = stop.call(service)
  expect(stop.call(service)).toBe(first)
  await first
  await task.dispose()
})

it('drains every published task before releasing any owner writer', async () => {
  const { ctx } = await mount()
  const first = await ctx.fusionParticipants.prepare('single-test')
  const second = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(first.roster.rootSessionId)!
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    if (session === root) { entered.resolve(undefined); await release.promise }
    return flush(session)
  })
  const closed: string[] = []
  // oxlint-disable-next-line typescript/unbound-method -- real receiver preserved.
  const close = JsonlSessionHandle.prototype.close
  vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementation(function (this: JsonlSessionHandle) {
    if (this.access === 'write') closed.push(this.id)
    return close.call(this)
  })
  const admission = first.delivery.admitUser({ deliveryId: DeliveryId('all-owned'), targetParticipantId: first.roster.roles.participant!, inboxTarget: 'next-turn', correlationId: null, text: 'held' })
  const rejected = expect(admission).rejects.toThrow()
  await entered.promise
  const disposal = ctx.fiber.dispose()
  await setImmediate()
  const premature = [...closed]
  release.resolve(undefined)
  await Promise.all([disposal, rejected])
  expect(premature).toEqual([])
  expect(new Set(closed).size).toBe(4)
  await second.dispose()
})

it.each([false, true])('joins pending provisioning and published admission before any owner release (loop first=%s)', async (loopFirst) => {
  const { ctx, adapter } = await mount(undefined, 'none', loopFirst)
  const service = ctx.fusionParticipants
  const task = await service.prepare('single-test')
  const sessions = ctx.sessions
  const root = sessions.get(task.roster.rootSessionId)!
  const provisioned = Promise.withResolvers<undefined>()
  const provisionRelease = Promise.withResolvers<undefined>()
  const admitted = Promise.withResolvers<undefined>()
  const admissionRelease = Promise.withResolvers<undefined>()
  const mountPreset = ctx.agentPresets.mount.bind(ctx.agentPresets)
  vi.spyOn(ctx.agentPresets, 'mount').mockImplementation(async (...args) => {
    const preset = await mountPreset(...args)
    provisioned.resolve(undefined)
    await provisionRelease.promise
    return preset
  })
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    if (session === root) { admitted.resolve(undefined); await admissionRelease.promise }
    return flush(session)
  })
  const pending = service.prepare('single-test')
  const pendingRejected = expect(pending).rejects.toThrow()
  await provisioned.promise
  const admission = task.delivery.admitUser({ deliveryId: DeliveryId('mixed-owner'), targetParticipantId: task.roster.roles.participant!, inboxTarget: 'next-turn', correlationId: null, text: 'held' })
  const admissionRejected = expect(admission).rejects.toThrow()
  await admitted.promise
  const closes: string[] = []
  // oxlint-disable-next-line typescript/unbound-method -- real receiver preserved.
  const close = JsonlSessionHandle.prototype.close
  vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementation(function (this: JsonlSessionHandle) {
    if (this.access === 'write') closes.push(this.id)
    return close.call(this)
  })
  let settled = false
  const stop = ctx.fiber.dispose().then(() => { settled = true })
  provisionRelease.resolve(undefined)
  await setImmediate()
  try {
    expect(settled).toBe(false)
    expect(closes).toEqual([])
    expect(sessions.get(root.id)).toBe(root)
    await sessions.flush(root)
  } finally { admissionRelease.resolve(undefined) }
  await Promise.all([stop, pendingRejected, admissionRejected])
  expect(new Set(closes).size).toBe(3)
  expect(adapter.requests).toHaveLength(0)
})

it.each(['prepare', 'recover'] as const)('reserves %s before synchronous read reentrancy and joins cleanup reentrancy', async (operation) => {
  const { ctx, adapter } = await mount()
  const service = ctx.fusionParticipants
  const task = await service.prepare('single-test')
  const id = task.roster.rootSessionId
  await task.dispose()
  const owner = [...ctx.registry.get(Participants)!.fibers][0]!
  const read = ctx.agentPresets.readDocument.bind(ctx.agentPresets)
  let stopping: Promise<void> | undefined
  vi.spyOn(ctx.agentPresets, 'readDocument').mockImplementation(async (...args) => {
    stopping = owner.dispose()
    return read(...args)
  })
  const work = operation === 'prepare' ? service.prepare('single-test') : service.recover(id)
  await expect(work).rejects.toThrow()
  await stopping
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
})

it('memoizes stop before descendant cleanup synchronously reenters it', async () => {
  const { ctx } = await mount()
  const service = ctx.fusionParticipants
  const task = await service.prepare('single-test')
  const resident = await task.adopt('participant')
  const stop: unknown = Reflect.get(service, 'stop')
  if (typeof stop !== 'function') throw new Error('missing owner cleanup driver')
  let nested: unknown
  await resident.agent.ctx.plugin((child) => {
    child.effect(() => () => { nested = stop.call(service) })
  })
  const first: unknown = stop.call(service)
  await first
  expect(nested).toBe(first)
  await task.dispose()
})

it.each(['reject', 'lost-writer'] as const)('retains writers until the actual held flush settles with %s', async (fault) => {
  const { ctx, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const sessions = ctx.sessions
  const root = sessions.get(task.roster.rootSessionId)!
  const target = sessions.get(task.roster.roles.participant!)!
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const failure = new Error('actual held writer failed')
  const closes: string[] = []
  let held = false
  // oxlint-disable-next-line typescript/unbound-method -- real receiver preserved.
  const flush = JsonlSessionHandle.prototype.flush
  // oxlint-disable-next-line typescript/unbound-method -- real receiver preserved.
  const close = JsonlSessionHandle.prototype.close
  vi.spyOn(JsonlSessionHandle.prototype, 'flush').mockImplementation(async function (this: JsonlSessionHandle, ...args) {
    if (!held && this.id === root.id) {
      held = true; entered.resolve(undefined); await release.promise
      if (fault === 'reject') throw failure
      await this.close()
    }
    return flush.apply(this, args)
  })
  vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementation(function (this: JsonlSessionHandle) {
    if (this.access === 'write') closes.push(this.id)
    return close.call(this)
  })
  const admission = task.delivery.admitUser({ deliveryId: DeliveryId('failed-held'), targetParticipantId: target.id, inboxTarget: 'next-turn', correlationId: null, text: 'held' })
  const blocked = expect(admission).rejects.toThrow()
  await entered.promise
  let settled = false
  const stop = ctx.fiber.dispose().then(() => { settled = true })
  await setImmediate()
  try {
    expect(settled).toBe(false)
    expect(closes).toEqual([])
    expect(sessions.get(root.id)).toBe(root)
    expect(sessions.get(target.id)).toBe(target)
  } finally { release.resolve(undefined) }
  await Promise.all([stop, blocked])
  expect(new Set(closes)).toEqual(new Set([root.id, target.id]))
  expect(adapter.requests).toHaveLength(0)
})
