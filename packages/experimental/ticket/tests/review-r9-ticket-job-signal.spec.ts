/** A producer cancellation failure must stay inside the attempt, including AbortSignal delivery. */
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { expect, it, onTestFinished } from 'vitest'
import { assigned, harness, live, request } from './review-r5-harness.ts'

it.each([false, true])('M2 Job caller abort contains a throwing cancel: %s', async (throws) => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, `r9-job-signal-${throws}-root`)
  const { agent: worker } = await live(ctx, `r9-job-signal-${throws}-worker`)
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, `r9-job-signal-${throws}`))
  const done = Promise.withResolvers<JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'killed' }) })
  const signal = new AbortController()
  let cancellations = 0
  await handle.startJob('writer', () => ({
    cancel() {
      cancellations++
      if (throws) throw new Error('producer refused signal cancellation')
      done.resolve({ status: 'killed' })
    },
    done: done.promise,
  }), signal.signal)
  expect(process.hasUncaughtExceptionCaptureCallback()).toBe(false)
  const escaped: Error[] = []
  // Capture the actual Node fatal-exception delivery without terminating the review runner.
  process.setUncaughtExceptionCaptureCallback((error) => { escaped.push(error) })
  try {
    signal.abort()
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally {
    process.setUncaughtExceptionCaptureCallback(null)
    done.resolve({ status: 'killed' })
  }
  await done.promise
  await handle.settle()
  expect(cancellations).toBe(1)
  expect(escaped.map(error => error.message)).toEqual([])
})
