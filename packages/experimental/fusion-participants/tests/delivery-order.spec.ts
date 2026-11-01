/** Private order tests use synthetic phase cuts and deterministic latches only. */
import { expect, it, vi } from 'vitest'
import { TaskOrder } from '../src/task-order.ts'
import { DeliveryId } from '../src/index.ts'
import { mount, read } from './harness.ts'

it('holds a synthetic cut behind prior work and reserves successors outside its frozen segment', async () => {
  const order = new TaskOrder()
  const before = Promise.withResolvers<undefined>()
  const cutEntered = Promise.withResolvers<undefined>()
  const cutRelease = Promise.withResolvers<undefined>()
  const seen: string[] = []
  const first = order.reserve(async (segment) => { seen.push(`before:${segment}`); await before.promise })
  const cut = order.cut(async (segment) => { seen.push(`cut:${segment}`); cutEntered.resolve(undefined); await cutRelease.promise })
  const successor = order.reserve(async (segment) => { seen.push(`after:${segment}`) })
  expect(seen).toEqual([])
  before.resolve(undefined)
  await first
  await cutEntered.promise
  expect(seen).toEqual(['before:0', 'cut:0'])
  cutRelease.resolve(undefined)
  await Promise.all([cut, successor])
  expect(seen).toEqual(['before:0', 'cut:0', 'after:1'])
  await order.close()
  await expect(order.reserve(async () => {})).rejects.toThrow('closed')
})

it('retains an uncertain cut until explicit reconciliation and never runs its successor', async () => {
  const order = new TaskOrder()
  const dispatch = vi.fn()
  const cut = order.cut(async () => { throw new Error('uncertain cut') })
  const successor = order.reserve(async () => { dispatch() })
  await expect(cut).rejects.toThrow('uncertain cut')
  await expect(successor).rejects.toThrow('uncertain cut')
  expect(dispatch).not.toHaveBeenCalled()
  await order.reserve(async () => {}, true)
  await order.reserve(async (segment) => { expect(segment).toBe(1) })
  await order.close()
})

it('drains delayed admission before writer close and suppresses receipts after disposal', async () => {
  const { ctx, root, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const rootSession = ctx.sessions.get(task.roster.rootSessionId)!
  const target = task.roster.roles.participant!
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const spy = vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    if (session === rootSession) { entered.resolve(undefined); await release.promise }
    return flush(session)
  })
  const input = { deliveryId: DeliveryId('dispose'), targetParticipantId: target, inboxTarget: 'next-turn' as const,
    correlationId: null, text: 'must survive caller lifetime' }
  const admission = task.delivery.admitUser(input)
  const rejected = expect(admission).rejects.toMatchObject({ code: 'fusion-participants/delivery-blocked' })
  await entered.promise
  const disposal = task.dispose()
  expect(ctx.sessions.get(rootSession.id)).toBe(rootSession)
  await expect(ctx.sessionPersistence.open(rootSession.id, 'write')).rejects.toThrow()
  release.resolve(undefined)
  await rejected
  await disposal
  spy.mockRestore()
  expect(ctx.sessions.get(rootSession.id)).toBeUndefined()
  expect((await read(ctx, target)).filter(row => row.type === 'fusion/delivery-accepted')).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
  const second = await mount(root)
  const recovered = await second.ctx.fusionParticipants.recover(rootSession.id)
  expect(await recovered.delivery.admitUser(input)).toMatchObject({ decisionInputRevision: 1 })
  expect(second.adapter.requests).toHaveLength(0)
  await recovered.dispose()
})

it('honors an aborted duplicate caller without canceling the original durable operation', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let held = false
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    if (session === root && !held) { held = true; entered.resolve(undefined); await release.promise }
    return flush(session)
  })
  const input = { deliveryId: DeliveryId('duplicate-abort'), targetParticipantId: task.roster.roles.participant!,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'ok' }
  const first = task.delivery.admitUser(input)
  const cancellation = new AbortController()
  const duplicate = task.delivery.admitUser(input, cancellation.signal)
  const rejected = expect(duplicate).rejects.toThrow('caller stopped')
  await entered.promise
  cancellation.abort(new Error('caller stopped'))
  release.resolve(undefined)
  const receipt = await first
  await rejected
  expect(await task.delivery.admitUser(input)).toEqual(receipt)
  expect(task.delivery.snapshot().decisionInputRevision).toBe(1)
  await task.dispose()
})

it.each(['queued', 'recorded'] as const)('retains a %s canceled admission until explicit reconciliation', async (phase) => {
  const { ctx, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let held = false
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    if (session === root && !held) { held = true; entered.resolve(undefined); await release.promise }
    return flush(session)
  })
  const input = { deliveryId: DeliveryId('canceled-call'), targetParticipantId: task.roster.roles.participant!,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'ok' }
  const cancellation = new AbortController()
  const admission = task.delivery.admitUser(input, cancellation.signal)
  const rejected = expect(admission).rejects.toMatchObject({ code: 'fusion-participants/delivery-blocked' })
  if (phase === 'recorded') await entered.promise
  cancellation.abort(new Error('caller stopped'))
  release.resolve(undefined)
  await rejected
  expect(task.delivery.snapshot().classificationPending).toEqual([input.deliveryId])
  await expect(task.delivery.admitUser(input)).rejects.toThrow()
  await task.delivery.reconcile()
  const receipt = await task.delivery.admitUser(input)
  expect(receipt.decisionInputRevision).toBe(1)
  expect((await read(ctx, input.targetParticipantId)).filter(row => row.type === 'agent/inbox/spliced'
    && row.data.inserted.length > 0)).toHaveLength(1)
  expect(adapter.requests).toHaveLength(0)
  await task.dispose()
})
