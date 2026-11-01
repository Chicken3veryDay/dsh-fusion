/** Explicit test-only consumption and real compaction leave permanent transport identities intact. */
import { expect, it, vi } from 'vitest'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { ReactLoopInbox } from '../../../core/agent-loop/src/inbox.ts'
import { DeliveryId } from '../src/index.ts'
import { mount, read } from './harness.ts'

class RecordedCompaction extends BasicCompactionEngine {
  override summarize() {
    return Promise.resolve({ summary: [{ type: 'text' as const, text: 'recorded compact summary' }], provider: 'fake', model: 'fake' })
  }
}

it('never reinserts claimed or canceled text after real model-surface compaction and restart', async () => {
  const { ctx, root, adapter } = await mount()
  await ctx.plugin(TokenMeter)
  const compact = new RecordedCompaction(ctx, { auto: false })
  const task = await ctx.fusionParticipants.prepare('single-test')
  const target = task.roster.roles.participant!
  const input = { deliveryId: DeliveryId('claimed'), targetParticipantId: target,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'original must remain reconstructable '.repeat(100) }
  const receipt = await task.delivery.admitUser(input)
  const canceled = { ...input, deliveryId: DeliveryId('canceled'), text: 'canceled original' }
  const other = await task.delivery.admitUser(canceled)
  const parked = await task.adopt('participant')
  const claims = vi.fn()
  ctx.on('agent/inbox/claimed', claims)
  expect(adapter.requests).toHaveLength(0)
  const { session, inbox } = parked.agent
  if (!(inbox instanceof ReactLoopInbox)) throw new Error('expected real retained inbox')
  session.append('turn/start', { turn: 1 })
  const consumed = inbox.claim('next-turn', 1)
  expect(consumed.map(row => row.id)).toEqual([receipt.messageId])
  const claimed = consumed[0]
  if (claimed === undefined) throw new Error('delivery was not claimable')
  const first = session.append('user/message', claimed, { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  const last = session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'fake', model: 'fake' }, content: [{ type: 'text', text: 'recorded answer' }],
  }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  inbox.clear()
  session.append('turn/start', { turn: 2 })
  const result = await compact.compactRegion(first.seq, last.seq, parked.agent)
  expect(result.shadowedSeqs).toContain(first.seq)
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  expect(session.deriveMessages().some(row => row.id === receipt.messageId)).toBe(false)
  expect(await task.delivery.admitUser(input)).toEqual(receipt)
  expect(await task.delivery.admitUser(canceled)).toEqual(other)
  expect(inbox.hasPending).toBe(false)
  expect(claims).toHaveBeenCalledTimes(1)
  expect(adapter.requests).toHaveLength(0)
  await task.dispose()
  const next = await mount(root)
  const recovered = await next.ctx.fusionParticipants.recover(task.roster.rootSessionId)
  expect(await recovered.delivery.admitUser(input)).toEqual(receipt)
  expect(await recovered.delivery.admitUser(canceled)).toEqual(other)
  const adopted = await recovered.adopt('participant')
  expect(adopted.agent.inbox.nextTurn).toHaveLength(0)
  expect(adopted.agent.inbox.nextStep).toHaveLength(0)
  const records = await read(next.ctx, target)
  expect(records.filter(row => row.type === 'agent/inbox/spliced' && row.data.inserted.length > 0)).toHaveLength(2)
  expect(records.some(row => row.type === 'compaction/summary')).toBe(true)
  expect(next.adapter.requests).toHaveLength(0)
  await recovered.dispose()
})
