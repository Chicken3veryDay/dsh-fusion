/** Live producers must remain reserved across replacement even without a visible Job. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it, onTestFinished, vi } from 'vitest'
import TicketService, { TicketExecutionService } from '../src/index.ts'
import { assigned, code, competing, harness, live, request } from './review-r5-harness.ts'

it.each(['worker-only', 'job-record-removed'] as const)(
  'R7-2 replacement retains a deleted root reservation with a live %s producer', async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), 'ticket-r7-replacement-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const { ctx, tickets, execution } = await harness(async (context) => {
      await context.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
    })
    await execution.dispose()
    const adapter = await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 20 })
    const root = await live(ctx, `r7-${kind}-root`)
    const ready = Promise.withResolvers<Context>()
    const owner = ctx.plugin({ name: `r7-${kind}-owner`, inject: ['sessions', 'agents'], apply(child: Context) { ready.resolve(child) } })
    await owner
    const worker = await live(await ready.promise, `r7-${kind}-worker`)
    const writer = await ctx.sessionPersistence.create(root.agent.session.header)
    onTestFinished(() => writer.close())
    await writer.append(root.agent.session.snapshotEvents())
    const ticket = await assigned(ctx, root.agent, worker.agent)
    const handle = await ctx.ticketExecution.prepare(worker.agent, request(root.agent, ticket, `r7-${kind}`))
    const done = Promise.withResolvers<JobOutcome>()
    let producerFinished = false
    const completion = done.promise.then((result) => { producerFinished = true; return result })
    onTestFinished(() => { done.resolve({ status: 'killed' }) })
    if (kind === 'worker-only') {
      vi.spyOn(worker.agent, 'whenIdle').mockImplementation(async () => { await completion })
    } else {
      await handle.startJob('producer whose cancellation throws', () => ({
        cancel() { throw new Error('transient producer cancellation failure') }, done: completion,
      }))
      // Real Job owner cleanup force-fails/removes its record when cancellation throws.
      await owner.dispose()
      expect(ctx.jobs.list(worker.agent.id)).toEqual([])
    }
    const stat = await ctx.sessionPersistence.stat(root.agent.id)
    if (stat?.location?.kind !== 'jsonl') throw new Error('expected JSONL storage')
    root.close()
    await handle.dispose().catch(code)
    await writer.close()
    await rm(stat.location.path)
    expect(await competing(ctx, `r7-${kind}-before`)).toBe('TICKET_ATTEMPT_STATE')
    await adapter.dispose()
    await tickets.dispose()
    await ctx.plugin(TicketService)
    await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 20 })
    const observed = { producerFinished, admission: await competing(ctx, `r7-${kind}-after`) }
    done.resolve({ status: 'killed' })
    await completion
    await handle.dispose().catch(code)
    expect(observed).toEqual({ producerFinished: false, admission: 'TICKET_ATTEMPT_STATE' })
  },
)
