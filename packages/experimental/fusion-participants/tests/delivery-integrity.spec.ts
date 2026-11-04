/** Current reader/writer identity and post-append projection coverage are required evidence. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DeliveryOwner } from '../src/delivery.ts'
import { admissionProjection, receiverProjection, createIntent, DeliveryId } from '../src/delivery-state.ts'
import { TaskOrder } from '../src/task-order.ts'
import { mount } from './harness.ts'

async function fixture() {
  const { ctx, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const target = ctx.sessions.get(task.roster.roles.participant!)!
  const admissions = await ctx.sessionProjections.register(admissionProjection)
  const receivers = await ctx.sessionProjections.register(receiverProjection)
  const participants = new Map([[target.id, target]])
  const owner = new DeliveryOwner({ ctx, root, participants,
    projections: { admissions, receivers }, signal: new AbortController().signal })
  const input = { deliveryId: DeliveryId('integrity'), targetParticipantId: target.id,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'retained original' }
  return { ctx, task, root, target, admissions, receivers, owner, input, adapter, participants }
}

it.each(['root-checkpoint', 'receiver-checkpoint', 'lost-intent', 'lost-acceptance', 'lost-insertion', 'lost-completion'] as const)(
  'refuses publication when a reader supplies %s instead of the current committed facts', async (fault) => {
    const f = await fixture()
    const originalRoot = f.admissions.stateOf.bind(f.admissions)
    const originalReceiver = f.receivers.stateOf.bind(f.receivers)
    let rootReads = 0
    let receiverReads = 0
    if (fault === 'root-checkpoint') vi.spyOn(f.admissions, 'stateOf').mockImplementation(session => ({ ...originalRoot(session), sessionId: SessionId('other') }))
    if (fault === 'receiver-checkpoint') vi.spyOn(f.receivers, 'stateOf').mockImplementation(session => ({ ...originalReceiver(session), sessionId: SessionId('other') }))
    if (fault === 'lost-intent') vi.spyOn(f.admissions, 'stateOf').mockImplementation(session => ({ ...originalRoot(session), entries: [] }))
    if (fault === 'lost-completion') vi.spyOn(f.admissions, 'stateOf').mockImplementation((session) => {
      rootReads++
      const state = originalRoot(session)
      return rootReads >= 4 ? { ...state, entries: state.entries.map(row => ({ ...row, completion: null })) } : state
    })
    if (fault === 'lost-acceptance' || fault === 'lost-insertion') vi.spyOn(f.receivers, 'stateOf').mockImplementation((session) => {
      receiverReads++
      const state = originalReceiver(session)
      return fault === 'lost-acceptance' ? { ...state, entries: [] }
        : receiverReads >= 3 ? { ...state, entries: state.entries.map(row => ({ ...row, instructionSeq: null })) } : state
    })
    await expect(f.owner.admitUser(f.input)).rejects.toThrow()
    expect(f.adapter.requests).toHaveLength(0)
    vi.restoreAllMocks()
    await f.owner.dispose()
    await f.task.dispose()
  },
)

it.each(['true-store', 'wrong-session', 'short-boundary', 'changed-writer', 'reject'] as const)(
  'requires current writer proof even with %s', async (fault) => {
    const f = await fixture()
    const flush = f.ctx.sessionPersistence.flushSessionDurably.bind(f.ctx.sessionPersistence)
    if (fault === 'true-store') vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValue(true)
    if (fault === 'reject') vi.spyOn(f.ctx.sessionPersistence, 'flushSessionDurably').mockRejectedValue(new Error('flush failed'))
    if (fault === 'wrong-session' || fault === 'short-boundary') {
      vi.spyOn(f.ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
        const result = await flush(session)
        return result.kind === 'durable' ? { ...result,
          ...fault === 'wrong-session' ? { session: f.target } : { boundary: f.target.seq },
        } : result
      })
    }
    if (fault === 'changed-writer') {
      await f.owner.admitUser(f.input)
      vi.spyOn(f.ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
        const result = await flush(session)
        return result.kind === 'durable' ? { ...result, writer: Symbol('different-writer') } : result
      })
    }
    await expect(f.owner.admitUser(f.input)).rejects.toThrow()
    expect(f.owner.snapshot().classificationPending).toEqual([f.input.deliveryId])
    expect(f.adapter.requests).toHaveLength(0)
    vi.restoreAllMocks()
    await f.owner.dispose()
    await f.task.dispose()
  },
)

it.each(['root-acceptance', 'receiver-intent', 'foreign-target', 'foreign-peer', 'self-peer', 'orphan-acceptance', 'different-root-intent'] as const)(
  'blocks reconciliation of %s history without a receiver instruction or execution', async (fault) => {
    const f = await fixture()
    const origin = fault === 'foreign-peer' ? { kind: 'peer' as const, sessionId: SessionId('foreign') }
      : fault === 'self-peer' ? { kind: 'peer' as const, sessionId: f.target.id } : { kind: 'user' as const }
    const target = fault === 'root-acceptance' ? f.root.id : fault === 'foreign-target' ? SessionId('foreign') : f.target.id
    const intent = createIntent({ ...f.input, targetParticipantId: target },
      fault === 'receiver-intent' ? f.target.id : f.root.id, origin, 1)
    if (fault === 'root-acceptance') f.root.append('fusion/delivery-accepted', intent)
    else if (fault === 'receiver-intent') f.target.append('fusion/delivery-intent', intent)
    else if (fault === 'orphan-acceptance') f.target.append('fusion/delivery-accepted', intent)
    else {
      f.root.append('fusion/delivery-intent', intent)
      if (fault === 'different-root-intent') f.target.append('fusion/delivery-accepted', createIntent({ ...f.input, text: 'different' }, f.root.id, origin, 1))
    }
    await expect(f.owner.reconcile()).rejects.toThrow()
    expect(f.adapter.requests).toHaveLength(0)
    await f.owner.dispose()
    await f.task.dispose()
  },
)

it('retains cleanup rejection separately and drains all retained writers', async () => {
  const f = await fixture()
  const failure = new Error('delivery cleanup failed')
  const dispose = vi.spyOn(DeliveryOwner.prototype, 'dispose').mockRejectedValue(failure)
  const first = f.task.dispose()
  expect(f.task.dispose()).toBe(first)
  await expect(first).rejects.toThrow('participant task drain failed')
  expect(f.ctx.sessions.get(f.root.id)).toBeDefined()
  dispose.mockRestore()
  await f.owner.dispose()
})

it('rejects queued operations on close and retains a non-Error failure as a structured cause', async () => {
  const order = new TaskOrder()
  const first = order.reserve(async () => { throw 'untyped external failure' })
  await expect(first).rejects.toBe('untyped external failure')
  await expect(order.reserve(async () => {})).rejects.toMatchObject({ cause: 'untyped external failure' })
  const queued = order.reserve(async () => {})
  await order.close()
  await expect(queued).rejects.toThrow('closed')
})


it('blocks a target removed while the root writer barrier is in flight', async () => {
  const f = await fixture()
  const flush = f.ctx.sessionPersistence.flushSessionDurably.bind(f.ctx.sessionPersistence)
  vi.spyOn(f.ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    const result = await flush(session)
    if (session === f.root) f.participants.delete(f.target.id)
    return result
  })
  await expect(f.owner.admitUser(f.input)).rejects.toMatchObject({ cause: { message: 'root intent targets a foreign participant' } })
  await f.owner.dispose()
  await f.task.dispose()
})

it('refuses a conflicting receiver projection on a same-ID completed retry', async () => {
  const f = await fixture()
  await f.owner.admitUser(f.input)
  const state = f.receivers.stateOf(f.target)
  const different = createIntent({ ...f.input, text: 'different' }, f.root.id, { kind: 'user' }, 1)
  vi.spyOn(f.receivers, 'stateOf').mockReturnValue({ ...state, entries: state.entries.map(row => ({ ...row, intent: different })) })
  await expect(f.owner.admitUser(f.input)).rejects.toMatchObject({ cause: { message: 'receiver acceptance differs from root intent' } })
  vi.restoreAllMocks()
  await f.owner.dispose()
  await f.task.dispose()
})
