/** Task-first cleanup releases every registration Fusion places on a lifetime longer than the task. */
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { DeliveryId } from '../src/index.ts'
import type { ExecutionHostProvider } from '../src/index.ts'
import { mount } from './harness.ts'

const labels = (fiber: Context['fiber']) => fiber.getEffects().map(effect => effect.label).sort()

it('leaves no status listener or effect on root, caller or declaring lifetimes after task-first cleanup', async () => {
  const { ctx, adapter } = await mount()
  const caller = createScope(ctx, {}), declaring = createScope(ctx, {})
  const listeners = () => ctx.events['_hooks']['internal/status']?.length ?? 0
  const observe = () => ({ listeners: listeners(), root: labels(ctx.root.fiber),
    caller: labels(caller.ctx.fiber), declaring: labels(declaring.ctx.fiber) })
  const baseline = observe()
  const cycles: ReturnType<typeof observe>[] = []
  let cleanups = 0
  try {
    for (let index = 0; index < 3; index++) {
      // prepare: caller effect, root status fence, root fence effect, Session withdrawals and owner signal listeners.
      const task = await caller.ctx.get('fusionParticipants')!.prepare('single-test')
      const resident = await task.adopt('participant')
      const provider: ExecutionHostProvider = {
        name: 'registration-cleanup', revision: '1', classify: () => 'read',
        registerHeld() { return { async prepare() { throw new Error('must not prepare') }, cancel() {}, async cleanup() { cleanups++ } } },
      }
      // Host effect and its status listener on the long-lived declaring scope, plus lifetime writer listeners.
      const host = await declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
      // Held request signal listener, released after its settlement.
      const attempt = host.reserve(host.bindRun(host.issuer, resident.agent, new AbortController().signal), 'inspect')
      await host.register(attempt)
      expect(await host.release(attempt)).toEqual({ kind: 'settled', outcome: 'not-dispatched' })
      // Caller wait listener on a delivery signal.
      await task.delivery.admitUser({ deliveryId: DeliveryId(`cycle-${index}`), targetParticipantId: resident.agent.id,
        inboxTarget: 'next-turn', correlationId: null, text: 'cycle input' }, new AbortController().signal)
      expect(observe()).not.toEqual(baseline)
      await resident.dispose()
      await task.dispose()
      expect(ctx.sessions.list()).toEqual([])
      cycles.push(observe())
    }
  } finally { await declaring.dispose(); await caller.dispose() }
  expect(cycles).toEqual([baseline, baseline, baseline])
  expect(cleanups).toBe(3)
  expect(adapter.requests).toHaveLength(0)
})

it('reports a failed host listener rollback together with the enrollment failure', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const declaring = createScope(ctx, {})
  let failing = false
  const stop = ctx.on('internal/listener', (name) => {
    if (name === 'internal/status') return () => { if (failing) throw new Error('listener cleanup unavailable') }
  })
  const reserve = vi.spyOn(ctx.sessionPersistence, 'reserveSessionWriter').mockImplementationOnce(() => { throw new Error('transient writer refusal') })
  try {
    failing = true
    const enrollment = declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, {
      name: 'rollback-failure', revision: '1', classify: () => 'read',
      registerHeld() { throw new Error('must not allocate') },
    })
    const error = await enrollment.then(() => undefined, (refusal: unknown) => refusal)
    if (!(error instanceof AggregateError)) throw new Error('expected the enrollment and rollback failures together')
    expect(error.errors.map((cause: Error) => cause.message))
      .toEqual(['transient writer refusal', 'listener cleanup unavailable'])
  } finally {
    failing = false
    stop()
    reserve.mockRestore()
    await declaring.dispose()
    await task.dispose()
  }
})
