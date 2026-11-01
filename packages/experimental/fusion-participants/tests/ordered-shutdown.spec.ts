/** Real Loader resources are inspected while teardown is blocked, before releasing work. */
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import Loop from '@deepseek-ai/dsh-agent-loop'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
import Participants, { DeliveryId } from '../src/index.ts'
import { DeliveryOwner } from '../src/delivery.ts'
import { mount, read } from './harness.ts'

const phases = ['root', 'receiver', 'completion'] as const
const routes = ['root', 'root-restart', 'root-update', 'owner', 'loop', 'loop-restart', 'persistence', 'persistence-restart', 'task', 'caller'] as const
const cases = [false, true].flatMap(loopFirst => ['writer', 'service'].flatMap(layer =>
  phases.flatMap(phase => routes.map(route => ({ loopFirst, layer, phase, route }))),
))

it.each(cases)('retains exact writers through $route at $layer $phase (loop first=$loopFirst)', async ({ loopFirst, layer, phase, route }) => {
  const { ctx, root: directory, adapter } = await mount(undefined, 'none', loopFirst)
  const caller = createScope(ctx, {})
  const task = await (route === 'caller' ? caller.ctx : ctx).get('fusionParticipants')!.prepare('single-test')
  const sessions = ctx.sessions
  const root = sessions.get(task.roster.rootSessionId)!
  const target = sessions.get(task.roster.roles.participant!)!
  const persistence = ctx.sessionPersistence
  const flush = persistence.flushSessionDurably.bind(persistence)
  const proof = await flush(root)
  const receiverProof = await flush(target)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const draining = Promise.withResolvers<undefined>()
  const closes: string[] = []
  const events: string[] = []
  let held = false
  let admissionSettled = false
  let disposalSettled = false
  let drainSettled = false
  const writers = new Map<string, JsonlSessionHandle>()
  // oxlint-disable-next-line typescript/unbound-method -- invoked with its real receiver.
  const rawFlush = JsonlSessionHandle.prototype.flush
  // oxlint-disable-next-line typescript/unbound-method -- invoked with its real receiver.
  const rawClose = JsonlSessionHandle.prototype.close
  // oxlint-disable-next-line typescript/unbound-method -- invoked with its real receiver.
  const rawDrain = DeliveryOwner.prototype.dispose
  vi.spyOn(DeliveryOwner.prototype, 'dispose').mockImplementation(function (this: DeliveryOwner) {
    draining.resolve(undefined)
    return rawDrain.call(this).then(() => { drainSettled = true; events.push('drained') })
  })
  vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementation(function (this: JsonlSessionHandle) {
    if (this.access === 'write') { closes.push(this.id); events.push(`close:${this.id}`) }
    return rawClose.call(this)
  })
  const shouldHold = (id: string): boolean => !held && id === (phase === 'receiver' ? target.id : root.id)
    && root.snapshotEvents().some(row => row.type === 'fusion/delivery-completed') === (phase === 'completion')
  {
    vi.spyOn(JsonlSessionHandle.prototype, 'flush').mockImplementation(async function (this: JsonlSessionHandle, options) {
      writers.set(this.id, this)
      if (layer === 'writer' && shouldHold(this.id)) { held = true; entered.resolve(undefined); await release.promise }
      return rawFlush.call(this, options)
    })
  }
  if (layer === 'service') {
    vi.spyOn(persistence, 'flushSessionDurably').mockImplementation(async (session) => {
      if (shouldHold(session.id)) { held = true; entered.resolve(undefined); await release.promise }
      return flush(session)
    })
  }
  const input = { deliveryId: DeliveryId(`shutdown-${phase}`), targetParticipantId: target.id,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'kept until drained' }
  const admission = task.delivery.admitUser(input).finally(() => { admissionSettled = true; events.push('admission') })
  const rejected = expect(admission).rejects.toMatchObject({ code: 'fusion-participants/delivery-blocked' })
  const queued = task.delivery.admitUser({ ...input, deliveryId: DeliveryId('queued') })
  const queueRejected = expect(queued).rejects.toThrow()
  await entered.promise
  const fiber = route.startsWith('loop') ? [...ctx.registry.get(Loop)!.fibers][0]!
    : route.startsWith('persistence') ? [...ctx.registry.get(Jsonl)!.fibers][0]!
      : [...ctx.registry.get(Participants)!.fibers][0]!
  const dispose = route === 'root' ? ctx.fiber.dispose()
    : route === 'root-restart' ? ctx.fiber.restart()
      : route === 'root-update' ? Promise.resolve(ctx.fiber.update({}))
        : route === 'task' ? task.dispose() : route === 'caller' ? caller.dispose()
          : route.endsWith('restart') ? fiber.restart() : fiber.dispose()
  const disposal = Promise.resolve(dispose).then(() => { disposalSettled = true })
  await draining.promise
  // One event-loop turn lets every independently scheduled Cordis disposer enter its barrier.
  await setImmediate()
  try {
    expect(closes).toEqual([])
    expect(admissionSettled).toBe(false)
    expect(disposalSettled).toBe(false)
    expect(drainSettled).toBe(false)
    expect(sessions.get(root.id)).toBe(root)
    expect(sessions.get(target.id)).toBe(target)
    // Provider withdrawal can invalidate new service proofs; its real live writer route must still flush.
    for (const [session, initial] of [[root, proof], [target, receiverProof]] as const) {
      await sessions.flush(session)
      const writer = writers.get(session.id)!
      expect(writer.durabilityOpen).toBe(true)
      expect(initial.kind === 'durable' && writer.durabilityIdentity === initial.writer).toBe(true)
      const generation = writer.durabilityGeneration
      await rawFlush.call(writer)
      expect(await writer.verifyDurability(session, session.seq, generation)).toBe(true)
    }
    await expect(task.adopt('participant')).rejects.toThrow()
    await expect(task.delivery.admitUser({ ...input, deliveryId: DeliveryId('post-stop') })).rejects.toThrow()
  } finally { release.resolve(undefined) }
  await Promise.all([rejected, queueRejected, disposal])
  expect(events.indexOf('drained')).toBeLessThan(events.findIndex(event => event.startsWith('close:')))
  expect(new Set(closes)).toEqual(new Set([root.id, target.id]))
  expect(adapter.requests).toHaveLength(0)
  vi.restoreAllMocks()
  const second = await mount(directory, 'none', loopFirst)
  const opens: string[] = []
  const open = second.ctx.sessionPersistence.open.bind(second.ctx.sessionPersistence)
  vi.spyOn(second.ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => {
    if (access === 'write') opens.push(id)
    return open(id, access, options)
  })
  const recovered = await second.ctx.fusionParticipants.recover(root.id)
  expect(recovered.roster).toEqual(task.roster)
  expect(opens).toEqual([root.id, target.id])
  const receipt = await recovered.delivery.admitUser(input)
  expect(receipt.decisionInputRevision).toBe(1)
  expect(receipt.messageId).toBe((await recovered.delivery.admitUser(input)).messageId)
  const rootEvents = await read(second.ctx, root.id)
  const targetEvents = await read(second.ctx, target.id)
  expect(rootEvents.filter(row => row.type === 'fusion/delivery-intent')).toHaveLength(1)
  expect(rootEvents.filter(row => row.type === 'fusion/delivery-completed')).toHaveLength(1)
  expect(targetEvents.filter(row => row.type === 'fusion/delivery-accepted')).toHaveLength(1)
  expect(targetEvents.filter(row => row.type === 'agent/inbox/spliced' && row.data.inserted.length > 0)).toHaveLength(1)
  expect(second.adapter.requests).toHaveLength(0)
  await recovered.dispose()
})
