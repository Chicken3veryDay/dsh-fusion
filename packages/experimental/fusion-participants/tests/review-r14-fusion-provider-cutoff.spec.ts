/** Provider withdrawal must fence task admission before dependent-fiber disposal starts. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Sessions from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { DeliveryId } from '../src/index.ts'
import { publicFixture } from './execution-public-harness.ts'

it.each(['active', 'loop', 'sessions', 'persistence'] as const)('checks admission at the %s provider reload edge', async (route) => {
  const f = await publicFixture()
  const plugin = route === 'loop' || route === 'active' ? Loop : route === 'sessions' ? Sessions : Jsonl
  const provider = [...f.ctx.registry.get(plugin)!.fibers][0]!
  await f.grant()
  const run = f.bind()
  const before = f.task.delivery.snapshot()
  let bound = false
  let registration: Promise<string> | undefined
  let delivery: Promise<string> | undefined
  let after = before
  let observed = false
  const deliveryId = DeliveryId(`provider-${route}`)
  const probe = () => {
    observed = true
    delivery = f.task.delivery.admitUser({ deliveryId,
      targetParticipantId: f.adopted.agent.id, inboxTarget: 'next-turn', correlationId: null,
      text: 'after provider withdrawal' }).then(() => 'accepted', () => 'refused')
    after = f.task.delivery.snapshot()
    try { f.bind(); bound = true } catch (_refused: unknown) { /* Expected after provider withdrawal. */ }
    try {
      const attempt = f.host.reserve(run, 'edit')
      registration = f.host.register(attempt).then(() => 'accepted', () => 'refused')
    } catch (_refused: unknown) { registration = Promise.resolve('refused') }
  }
  const remove = f.ctx.root.on('internal/status', (fiber) => {
    if (fiber === provider && fiber.state === FiberState.UNLOADING) probe()
  }, { prepend: true })
  try {
    if (route === 'active') probe()
    else await provider.restart()
    expect(observed).toBe(true)
    await delivery
    expect(f.control.bodies).toBe(0)
    expect({ bound, registration: await registration, registrations: f.control.registrations, after })
      .toEqual(route === 'active' ? { bound: true, registration: 'accepted', registrations: 1,
        after: { decisionInputRevision: 1, dirtyGeneration: 1, reservations: [deliveryId],
          transportPending: [deliveryId], classificationPending: [deliveryId] } }
        : { bound: false, registration: 'refused', registrations: 0, after: before })
  } finally {
    remove()
    await f.dispose()
  }
})
