/** A startup-time cancellation error is not the producer's terminal outcome. */
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { expect, it } from 'vitest'
import { assigned, code, competing, harness, live, request } from './review-r5-harness.ts'

it('R7-3 a throwing cancellation after Job startup cannot settle its still-running producer', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'r7-start-root')
  const { agent: worker } = await live(ctx, 'r7-start-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'r7-start'))
  const done = Promise.withResolvers<JobOutcome>()
  let producerFinished = false
  const completion = done.promise.then((outcome) => { producerFinished = true; return outcome })
  let disposal: Promise<string> | undefined
  const startup = await handle.startJob('startup requests stop before publishing hooks', () => {
    disposal = handle.dispose().then(() => 'settled', code)
    return { cancel() { throw new Error('temporary cancellation failure after producer startup') }, done: completion }
  }).then(() => 'admitted', code)
  if (disposal === undefined) throw new Error('producer startup did not request disposal')
  const stopped = await disposal
  const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
  const observed = { startup, stopped, producerFinished, attempt: attempt?.status,
    competing: await competing(ctx, 'r7-start-conflict') }
  done.resolve({ status: 'killed' })
  await completion
  await handle.dispose().catch(code)
  expect(observed).toEqual({
    startup: 'Error: temporary cancellation failure after producer startup',
    stopped: 'TICKET_ATTEMPT_STATE', producerFinished: false, attempt: 'unknown', competing: 'TICKET_ATTEMPT_STATE',
  })
})
