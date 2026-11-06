/** Round-6 execution lifetime and retry reproductions. */
import { expect, it, onTestFinished, vi } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { TicketTools } from '../src/index.ts'
import { assigned, code, competing, harness, live, request } from './review-r5-harness.ts'

it('R6-1 preparation cancellation during the runtime flush must reject before publishing a handle', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'r6-publication-root')
  const { agent: worker } = await live(ctx, 'r6-publication-worker')
  const ticket = await assigned(ctx, root, worker)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let flushes = 0
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (++flushes === 3) { entered.resolve(undefined); await release.promise }
    return await flush(session)
  })
  const cancellation = new AbortController()
  const preparation = ctx.ticketExecution.prepare(worker, {
    ...request(root, ticket, 'r6-publication'), signal: cancellation.signal,
  }).then(handle => ({ kind: 'published' as const, handle }), (error: unknown) => ({ kind: 'rejected' as const, error }))
  await entered.promise
  cancellation.abort(new Error('preparation cancelled before publication'))
  release.resolve(undefined)
  const result = await preparation
  spy.mockRestore()
  const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
  const observed = { result: result.kind, status: attempt?.status,
    outcome: attempt?.status === 'settled' ? attempt.outcome : undefined }
  if (result.kind === 'published') await result.handle.dispose()
  expect(observed).toEqual({ result: 'rejected', status: 'settled', outcome: 'cancelled' })
})

it('R6-2 explicit disposal retries cancellation after a transient producer stop error', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'r6-stop-retry-root')
  const { agent: worker } = await live(ctx, 'r6-stop-retry-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'r6-stop-retry'))
  const done = Promise.withResolvers<import('@deepseek-ai/dsh-jobs').JobOutcome>()
  onTestFinished(() => { done.resolve({ status: 'killed' }) })
  let cancellations = 0
  await handle.startJob('transient stop failure', () => ({
    cancel() {
      cancellations++
      if (cancellations === 1) throw new Error('transient producer stop failure')
      done.resolve({ status: 'killed' })
    },
    done: done.promise,
  }))
  const first = await handle.dispose().then(() => 'settled', code)
  expect(first).toBe('Error: transient producer stop failure')
  const retry = await handle.dispose().then(() => 'settled', code)
  // Finish the owned producer even on the broken retry path, then try once more with a known outcome.
  done.resolve({ status: 'killed' })
  await done.promise
  const afterProducerEnded = await handle.dispose().then(() => 'settled', code)
  const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
  const observed = { retry, afterProducerEnded, cancellations, status: attempt?.status,
    competing: await competing(ctx, 'r6-stop-retry-competing') }
  expect(observed).toEqual({ retry: 'settled', afterProducerEnded: 'settled', cancellations: 2,
    status: 'settled', competing: 'admitted' })
})

it('R6-3 a failed settled execution can end its Ticket with a failed outcome', async () => {
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'r6-failed-ticket-root')
  const { agent: worker } = await live(ctx, 'r6-failed-ticket-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'r6-failed-ticket'))
  await handle.startJob('failed build', () => ({ cancel() {}, done: Promise.resolve({ status: 'failed' }) }))
  await handle.settle()
  const settled = ctx.tickets.get(root.session, ticket.id)
  expect(settled.attempts[0]).toMatchObject({ status: 'settled', outcome: 'failed' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(TicketTools)
  const result = await executeToolFixture(ctx, { agent: root, name: 'ticket_fail', callId: ToolCallId('r6-fail'),
    signal: new AbortController().signal, arguments: { root_session_id: root.id, ticket_id: ticket.id,
      expected_revision: settled.revision, summary: 'The build failed' } })
  const after = ctx.tickets.get(root.session, ticket.id)
  expect({ toolFailed: result.isError, status: after.status, outcome: after.terminalOutcome?.kind })
    .toEqual({ toolFailed: false, status: 'failed', outcome: 'failed' })
})
