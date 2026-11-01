/** Real retained root/receiver logs, synchronous reservation and writer barriers. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DeliveryId } from '../src/index.ts'
import { mount, read } from './harness.ts'

it('delivers ordinary text once, keeps blocking input and retains original metadata through restart', async () => {
  const { ctx, root, adapter } = await mount()
  const claims = vi.fn()
  ctx.on('agent/inbox/claimed', claims)
  const task = await ctx.fusionParticipants.prepare('single-test')
  const targetParticipantId = task.roster.roles.participant!
  const input = { deliveryId: DeliveryId('ordinary-ok'), targetParticipantId, inboxTarget: 'next-turn' as const, correlationId: null, text: 'ok\r\n𝄞' }
  const opening = vi.spyOn(ctx.sessionPersistence, 'open')
  const creating = vi.spyOn(ctx.agents, 'create')
  const admission = task.delivery.admitUser(input)
  expect(task.delivery.snapshot()).toMatchObject({ decisionInputRevision: 1, dirtyGeneration: 1,
    reservations: [input.deliveryId], classificationPending: [input.deliveryId], transportPending: [input.deliveryId] })
  input.text = 'mutated after submission'
  const receipt = await admission
  expect(receipt.messageId).not.toBe(input.deliveryId)
  expect(await task.delivery.admitUser({ ...input, text: 'ok\r\n𝄞' })).toEqual(receipt)
  await expect(task.delivery.admitUser(input)).rejects.toMatchObject({ code: 'fusion-participants/delivery-blocked' })
  expect(opening).not.toHaveBeenCalled()
  expect(creating).not.toHaveBeenCalled()
  expect(task.delivery.snapshot()).toMatchObject({ decisionInputRevision: 1,
    classificationPending: [input.deliveryId], transportPending: [], reservations: [] })
  const rootLog = await read(ctx, task.roster.rootSessionId)
  expect(rootLog.filter(row => row.type.startsWith('fusion/delivery-')).map(row => row.type)).toEqual(['fusion/delivery-intent', 'fusion/delivery-completed'])
  const receiver = await read(ctx, targetParticipantId)
  const acceptance = receiver.find(row => row.type === 'fusion/delivery-accepted')!
  const insertion = receiver.find(row => row.type === 'agent/inbox/spliced')!
  expect(insertion.seq).toBe(acceptance.seq + 1)
  if (insertion.type !== 'agent/inbox/spliced') throw new Error('missing insertion')
  expect(insertion.data.inserted[0]).toMatchObject({ id: receipt.messageId, content: [{ type: 'text', text: 'ok\r\n𝄞' }], source: { kind: 'fusion-delivery', origin: { kind: 'user' }, deliveryId: input.deliveryId } })
  const parked = await task.adopt('participant')
  expect(parked.agent.inbox.nextTurn).toHaveLength(1)
  parked.agent.cancel()
  expect(claims).not.toHaveBeenCalled()
  expect(adapter.requests).toHaveLength(0)
  await task.dispose()
  const restarted = await mount(root)
  const recovered = await restarted.ctx.fusionParticipants.recover(task.roster.rootSessionId)
  expect(await recovered.delivery.admitUser({ ...input, text: 'ok\r\n𝄞' })).toEqual(receipt)
  expect((await read(restarted.ctx, targetParticipantId)).filter(row => row.type === 'agent/inbox/spliced' && row.data.inserted.length > 0)).toHaveLength(1)
  expect(restarted.adapter.requests).toHaveLength(0)
  await recovered.dispose()
})

it('reserves distinct concurrent input and joins identical retries before the root barrier', async () => {
  const { ctx, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const target = ctx.sessions.get(task.roster.roles.participant!)!
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let held = false
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    if (session === root && !held) { held = true; entered.resolve(undefined); await release.promise }
    return flush(session)
  })
  const a = { deliveryId: DeliveryId('a'), targetParticipantId: target.id, inboxTarget: 'next-turn' as const, correlationId: 'c', text: 'first' }
  const first = task.delivery.admitUser(a)
  const duplicate = task.delivery.admitUser(a)
  expect(duplicate).toBe(first)
  await expect(task.delivery.admitUser({ ...a, text: 'changed' })).rejects.toThrow()
  const second = task.delivery.admitUser({ ...a, deliveryId: DeliveryId('b'), text: 'second' })
  expect(task.delivery.snapshot()).toMatchObject({ decisionInputRevision: 2, reservations: ['a', 'b'] })
  await entered.promise
  expect((await read(ctx, target.id)).some(row => row.type === 'fusion/delivery-accepted')).toBe(false)
  release.resolve(undefined)
  const receipts = await Promise.all([first, duplicate, second])
  expect(receipts.map(row => row.order)).toEqual([1, 1, 2])
  const parked = await task.adopt('participant')
  expect(parked.agent.inbox.nextTurn.map(row => row.id)).toEqual([receipts[0].messageId, receipts[2].messageId])
  expect(adapter.requests).toHaveLength(0)
  await task.dispose()
})

it.each(['root', 'receiver', 'completion'] as const)('blocks dependent delivery on an unproven %s barrier, then reconciles the original assignment', async (phase) => {
  const { ctx, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const target = ctx.sessions.get(task.roster.roles.participant!)!
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  let rootBarriers = 0
  const spy = vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    if (session === root) rootBarriers++
    if (phase === 'root' && session === root && rootBarriers === 1 || phase === 'receiver' && session === target
      || phase === 'completion' && session === root && rootBarriers === 2) return { kind: 'refused', reason: 'coverage' }
    return flush(session)
  })
  const input = { deliveryId: DeliveryId('failed'), targetParticipantId: target.id, inboxTarget: 'next-step' as const, correlationId: null, text: 'correction labelled status' }
  await expect(task.delivery.admitUser(input)).rejects.toThrow()
  expect(task.delivery.snapshot()).toMatchObject({ decisionInputRevision: 1, transportPending: ['failed'], classificationPending: ['failed'] })
  if (phase === 'root') expect((await read(ctx, target.id)).some(row => row.type === 'fusion/delivery-accepted')).toBe(false)
  if (phase === 'receiver') expect((await read(ctx, root.id)).some(row => row.type === 'fusion/delivery-completed')).toBe(false)
  await expect(task.delivery.admitUser(input)).rejects.toThrow()
  spy.mockRestore()
  await task.delivery.reconcile()
  const receipt = await task.delivery.admitUser(input)
  expect(receipt.decisionInputRevision).toBe(1)
  expect((await read(ctx, root.id)).filter(row => row.type === 'fusion/delivery-intent')).toHaveLength(1)
  expect((await read(ctx, target.id)).filter(row => row.type === 'agent/inbox/spliced' && row.data.inserted.length > 0)).toHaveLength(1)
  expect(adapter.requests).toHaveLength(0)
  await task.dispose()
})

it('authenticates exact live task peers, rejects foreign targets and preserves peer attribution', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('top')
  const peer = await task.adopt('userFacingLead')
  const input = { deliveryId: DeliveryId('peer'), targetParticipantId: task.roster.roles.executor!, inboxTarget: 'next-turn' as const, correlationId: null, text: 'peer evidence' }
  const receipt = await task.delivery.admitPeer(peer.agent, input)
  expect(receipt.order).toBe(1)
  await expect(task.delivery.admitPeer(peer.agent, { ...input, targetParticipantId: peer.agent.id })).rejects.toThrow()
  await expect(task.delivery.admitUser({ ...input, targetParticipantId: SessionId('foreign') })).rejects.toThrow()
  await expect(task.delivery.admitUser(input)).rejects.toThrow()
  await peer.dispose()
  await expect(task.delivery.admitPeer(peer.agent, input)).rejects.toThrow()
  const records = await read(ctx, input.targetParticipantId)
  expect(records.find(row => row.type === 'fusion/delivery-accepted')?.data).toMatchObject({ origin: { kind: 'peer', sessionId: peer.agent.id } })
  await task.dispose()
})
