/** Review: Fusion projections must tolerate fork-inherited Fusion records in an unrelated child Session. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { DeliveryId } from '../src/index.ts'
import { ReactLoopAgent } from '../../../core/agent-loop/src/agent.ts'
import { mount, message } from './harness.ts'

it('keeps projection snapshots of a forked participant readable after delivery and a completed turn', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const target = task.roster.roles.participant!
  await task.delivery.admitUser({ deliveryId: DeliveryId('review-fork'), targetParticipantId: target,
    inboxTarget: 'next-turn', correlationId: null, text: 'delivered before fork' })
  const parked = await task.adopt('participant')
  if (!(parked.agent instanceof ReactLoopAgent)) throw new Error('expected production driver')
  await parked.agent.testOnlyTurn(message('complete one turn'))
  const participant = parked.agent.session
  expect(participant.snapshotEvents().some(event => event.type === 'fusion/delivery-accepted')).toBe(true)
  // Same seed as session-controller fork or a fork-context subagent: an exact copied prefix.
  const fork = ctx.sessions.fork(participant)
  // A non-Fusion client key; materialization still folds every registered unit.
  expect(() => ctx.sessionProjections.snapshot(fork, ['inbox'])).not.toThrow()
  await parked.dispose()
  await task.dispose()
}, 60_000)

it('keeps projection snapshots of a forked Fusion root readable', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const fork = ctx.sessions.fork(root)
  expect(() => ctx.sessionProjections.snapshot(fork)).not.toThrow()
  await task.dispose()
}, 60_000)

it('keeps eager projection drive for later client-visible units on a forked Fusion root', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  // A client-visible unit registered after Fusion, as any later-loaded plugin would.
  const counter = await ctx.sessionProjections.register({
    key: 'reviewOpusFusionCounter', stateVersion: 1, stateSchema: z.number(),
    init: () => 0, apply: (state: number) => state + 1,
    wire: { viewSchema: z.number(), view: (state: number) => state },
  } as never)
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const fork = ctx.sessions.fork(root)
  const changed: string[] = []
  ctx.sessionProjections.onChanged((session, key) => { if (session === fork) changed.push(key) })
  fork.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message('after fork')] })
  expect(changed).toContain('reviewOpusFusionCounter')
  await counter.dispose()
  await task.dispose()
}, 60_000)

it('control: notifies a later client-visible unit for a fork of a non-Fusion Session', async () => {
  const { ctx } = await mount()
  const counter = await ctx.sessionProjections.register({
    key: 'reviewOpusFusionControl', stateVersion: 1, stateSchema: z.number(),
    init: () => 0, apply: (state: number) => state + 1,
    wire: { viewSchema: z.number(), view: (state: number) => state },
  } as never)
  const plain = ctx.sessions.create()
  plain.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message('before fork')] })
  const fork = ctx.sessions.fork(plain)
  const changed: string[] = []
  ctx.sessionProjections.onChanged((session, key) => { if (session === fork) changed.push(key) })
  fork.append('agent/inbox/spliced', { target: 'next-turn', start: 1, inserted: [message('after fork')] })
  expect(changed).toContain('reviewOpusFusionControl')
  expect(() => ctx.sessionProjections.snapshot(fork)).not.toThrow()
  await counter.dispose()
}, 60_000)
