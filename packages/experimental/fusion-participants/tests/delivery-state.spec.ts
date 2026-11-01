/** Strict durable input, contained fold failures and real checkpoint/suffix restoration. */
import { expect, it, vi } from 'vitest'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { admissionProjection, receiverProjection, createIntent, DeliveryId, intentSchema, contentHash } from '../src/delivery-state.ts'
import { mount, read } from './harness.ts'

it('restores the full root input from a checkpoint plus suffix, retaining state for unrelated records', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const handle = await ctx.sessionProjections.register(admissionProjection)
  const initial = handle.stateOf(root)
  root.append('session/end-seed', {})
  expect(handle.stateOf(root)).toBe(initial)
  const intent = createIntent({ deliveryId: DeliveryId('checkpoint'), targetParticipantId: task.roster.roles.participant!,
    inboxTarget: 'next-turn', correlationId: null, text: 'all original input' }, root.id, { kind: 'user' }, 1)
  root.append('fusion/delivery-intent', intent)
  const prefix = ctx.sessionProjections.checkpoint(root)
  const offset = root.seq
  await task.delivery.reconcile()
  const full = ctx.sessionProjections.checkpoint(root)
  const events = await read(ctx, root.id)
  const restored = ctx.sessionProjections.restore(prefix, events.slice(offset), offset, root.header, root.inheritedEventCount)
  expect(restored.checkpoint.fusionAdmissions).toEqual(full.fusionAdmissions)
  const replay = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), root.header, root.inheritedEventCount)
  expect(replay.checkpoint.fusionAdmissions).toEqual(full.fusionAdmissions)
  const incompatible = { ...prefix, fusionAdmissions: { ...prefix.fusionAdmissions!, ver: 99 } }
  expect(() => ctx.sessionProjections.restore(incompatible, events.slice(offset), offset, root.header, root.inheritedEventCount)).toThrow()
  expect(ctx.sessionProjections.restore(incompatible, events, SessionLogOffset(0), root.header, root.inheritedEventCount)
    .checkpoint.fusionAdmissions).toEqual(full.fusionAdmissions)
  const ahead = { ...prefix, fusionAdmissions: { ...prefix.fusionAdmissions!, seq: SessionSeq(events.length + 10) } }
  expect(() => ctx.sessionProjections.restore(ahead, [], root.seq, root.header, root.inheritedEventCount)).toThrow()
  expect(handle.stateOf(root).entries[0]?.intent.text).toBe('all original input')
  await handle.dispose()
  await task.dispose()
})

it.each(['duplicate-intent', 'duplicate-acceptance', 'orphan-instruction', 'interleaving', 'wrong-instruction'] as const)(
  'contains an invalid %s append and blocks dependent work instead of trusting append success', async (invalid) => {
    const { ctx, adapter } = await mount()
    const task = await ctx.fusionParticipants.prepare('single-test')
    const root = ctx.sessions.get(task.roster.rootSessionId)!
    const target = ctx.sessions.get(task.roster.roles.participant!)!
    const intents = await ctx.sessionProjections.register(admissionProjection)
    const deliveries = await ctx.sessionProjections.register(receiverProjection)
    const intent = createIntent({ deliveryId: DeliveryId('bad-history'), targetParticipantId: target.id,
      inboxTarget: 'next-turn', correlationId: null, text: 'original' }, root.id, { kind: 'user' }, 1)
    root.append('fusion/delivery-intent', intent)
    if (invalid === 'duplicate-intent') {
      root.append('fusion/delivery-intent', intent)
      expect(() => intents.stateOf(root)).toThrow()
    } else {
      if (invalid !== 'orphan-instruction') target.append('fusion/delivery-accepted', intent)
      switch (invalid) {
        case 'duplicate-acceptance': target.append('fusion/delivery-accepted', intent); break
        case 'interleaving': target.append('turn/start', { turn: 4 }); break
        case 'wrong-instruction': target.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [intent.instruction] }); break
        case 'orphan-instruction': target.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [intent.instruction] }); break
      }
      expect(() => deliveries.stateOf(target)).toThrow()
    }
    await expect(task.delivery.reconcile()).rejects.toThrow()
    await expect(task.adopt('participant')).rejects.toThrow()
    expect(adapter.requests).toHaveLength(0)
    await task.dispose()
  },
)

it('validates durable reconstruction and checkpoint invariants without normalizing text or hashing identities', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const input = { deliveryId: DeliveryId('unicode'), targetParticipantId: task.roster.roles.participant!,
    inboxTarget: 'next-turn' as const, correlationId: null, text: '\ud800\r\né' }
  const intent = createIntent(input, task.roster.rootSessionId, { kind: 'user' }, 1)
  expect(intentSchema.parse(JSON.parse(JSON.stringify(intent)))).toEqual(intent)
  expect(intentSchema.safeParse({ ...intent, arbitrary: true }).success).toBe(false)
  expect(intentSchema.safeParse({ ...intent, instruction: undefined }).success).toBe(false)
  expect(intentSchema.safeParse({ ...intent, text: 'changed' }).success).toBe(false)
  expect(contentHash({ ...input, rootSessionId: task.roster.rootSessionId, origin: { kind: 'user' } }))
    .not.toBe(contentHash({ ...input, text: '\ud800\né', rootSessionId: task.roster.rootSessionId, origin: { kind: 'user' } }))
  const state = { sessionId: task.roster.rootSessionId, entries: [{ intent, intentSeq: SessionSeq(1), completion: null }] }
  expect(admissionProjection.stateSchema.safeParse(state).success).toBe(true)
  expect(admissionProjection.stateSchema.safeParse({ ...state, entries: [...state.entries, ...state.entries] }).success).toBe(false)
  expect(admissionProjection.stateSchema.safeParse({ ...state, sessionId: input.targetParticipantId }).success).toBe(false)
  expect(receiverProjection.stateSchema.safeParse({ sessionId: input.targetParticipantId, turn: null, step: null, calls: [],
    entries: [{ intent, acceptanceSeq: SessionSeq(2), instructionSeq: SessionSeq(1) }] }).success).toBe(false)
  await task.dispose()
})

it('rejects every mismatched completion field and retains unrelated ordered entries', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const first = await task.delivery.admitUser({ deliveryId: DeliveryId('first-completion'),
    targetParticipantId: task.roster.roles.participant!, inboxTarget: 'next-turn', correlationId: null, text: 'first' })
  const second = await task.delivery.admitUser({ deliveryId: DeliveryId('second-completion'),
    targetParticipantId: task.roster.roles.participant!, inboxTarget: 'next-turn', correlationId: null, text: 'second' })
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const handle = await ctx.sessionProjections.register(admissionProjection)
  const state = handle.stateOf(root)
  const pending = { ...state, entries: state.entries.map(row => ({ ...row, completion: null })) }
  const { messageId: _messageId, ...completion } = second
  const event = { type: 'fusion/delivery-completed', seq: SessionSeq(root.seq), time: 0, data: completion } as const
  const restored = admissionProjection.apply(pending, event)
  expect(restored.entries[0]).toBe(pending.entries[0])
  expect(restored.entries[1]?.completion).toEqual(completion)
  for (const patch of [
    { deliveryId: first.deliveryId }, { contentHash: first.contentHash }, { order: first.order },
    { decisionInputRevision: first.decisionInputRevision }, { targetParticipantId: root.id },
  ]) {
    const invalid = { ...event, data: { ...completion, ...patch } }
    expect(() => admissionProjection.apply(pending, invalid)).toThrow('invalid root delivery completion')
    expect(admissionProjection.stateSchema.safeParse({ ...state,
      entries: state.entries.map((row, index) => index === 1 ? { ...row, completion: invalid.data } : row),
    }).success).toBe(false)
  }
  expect(() => admissionProjection.apply(state, event)).toThrow('invalid root delivery completion')
  await task.dispose()
})

it('rejects receiver checkpoints with reversed acceptance order or a nonterminal pending pair', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const target = ctx.sessions.get(task.roster.roles.participant!)!
  for (const id of ['one', 'two']) await task.delivery.admitUser({ deliveryId: DeliveryId(id),
    targetParticipantId: target.id, inboxTarget: 'next-turn', correlationId: null, text: id })
  const handle = await ctx.sessionProjections.register(receiverProjection)
  const state = handle.stateOf(target)
  expect(receiverProjection.stateSchema.parse(state)).toEqual(state)
  expect(receiverProjection.stateSchema.safeParse({ ...state, entries: state.entries.map((row, index) =>
    index === 0 ? { ...row, instructionSeq: null } : row) }).success).toBe(false)
  expect(receiverProjection.stateSchema.safeParse({ ...state, entries: state.entries.map((row, index) =>
    index === 1 ? { ...row, acceptanceSeq: SessionSeq(0) } : row) }).success).toBe(false)
  expect(receiverProjection.stateSchema.safeParse({ ...state, entries: state.entries.map((row, index) =>
    index === 1 ? { ...row, intent: { ...row.intent, targetParticipantId: task.roster.rootSessionId } } : row) }).success).toBe(false)
  await task.dispose()
})

it('registers after history, falls back from unusable checkpoints and disposes drives while retaining its pure reader', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const input = { deliveryId: DeliveryId('late-projection'), targetParticipantId: task.roster.roles.participant!,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'retained protocol data' }
  await task.delivery.admitUser(input)
  const definition = { ...admissionProjection, key: 'lateFusionAdmissions' }
  const handle = await ctx.sessionProjections.register(definition)
  const state = handle.stateOf(root)
  expect(state.entries[0]?.intent.text).toBe(input.text)
  const full = ctx.sessionProjections.checkpoint(root)
  const events = await read(ctx, root.id)
  for (const checkpoint of [
    {},
    { lateFusionAdmissions: { ...full.lateFusionAdmissions!, ver: 99 } },
    { lateFusionAdmissions: { ...full.lateFusionAdmissions!, seq: SessionSeq(events.length + 1) } },
  ]) {
    expect(ctx.sessionProjections.restore(checkpoint, events, SessionLogOffset(0), root.header, root.inheritedEventCount)
      .checkpoint.lateFusionAdmissions).toEqual(full.lateFusionAdmissions)
  }
  await expect(Promise.resolve(ctx.sessionProjections.register({ ...definition, stateVersion: definition.stateVersion + 1 }))).rejects.toThrow('already registered')
  const open = vi.spyOn(ctx.sessionPersistence, 'open')
  const append = vi.spyOn(root, 'append')
  expect(handle.stateOf(root)).toBe(state)
  expect(open).not.toHaveBeenCalled()
  expect(append).not.toHaveBeenCalled()
  await handle.dispose()
  expect(ctx.sessionProjections.checkpoint(root)).not.toHaveProperty('lateFusionAdmissions')
  root.append('session/end-seed', {})
  const calls = append.mock.calls.length
  expect(handle.stateOf(root)).toBe(state)
  expect(handle.stateOf(root).entries[0]?.intent.text).toBe(input.text)
  expect(append).toHaveBeenCalledTimes(calls)
  expect(open).not.toHaveBeenCalled()
  await task.dispose()
})

it('restores receiver protocol data through version fallback and removes late registration without fold effects', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const target = ctx.sessions.get(task.roster.roles.participant!)!
  const input = { deliveryId: DeliveryId('receiver-lifecycle'), targetParticipantId: target.id,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'receiver original protocol' }
  await task.delivery.admitUser(input)
  const handle = await ctx.sessionProjections.register({ ...receiverProjection, key: 'lateFusionReceiver' })
  const state = handle.stateOf(target)
  const checkpoint = ctx.sessionProjections.checkpoint(target)
  const events = await read(ctx, target.id)
  const stale = { lateFusionReceiver: { ...checkpoint.lateFusionReceiver!, ver: 99 } }
  expect(ctx.sessionProjections.restore(stale, events, SessionLogOffset(0), target.header, target.inheritedEventCount)
    .checkpoint.lateFusionReceiver).toEqual(checkpoint.lateFusionReceiver)
  const open = vi.spyOn(ctx.sessionPersistence, 'open')
  const emit = vi.spyOn(ctx, 'emit')
  expect(handle.stateOf(target)).toBe(state)
  expect(state.entries[0]?.intent.text).toBe(input.text)
  expect(open).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
  await handle.dispose()
  expect(ctx.sessionProjections.checkpoint(target)).not.toHaveProperty('lateFusionReceiver')
  expect(handle.stateOf(target)).toBe(state)
  await task.dispose()
})
