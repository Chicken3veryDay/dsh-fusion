import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { assigned, harness, live, request } from './review-r5-harness.ts'

it('refuses to acknowledge a persisted operation through a detached root object', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticket-durable-retry-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const { ctx } = await harness(async (context) => { await context.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' }) })
  const root = await live(ctx, 'detached-operation-root')
  const { agent: worker } = await live(ctx, 'detached-operation-worker')
  const ticket = await assigned(ctx, root.agent, worker)
  const { rootSessionId: _root, ...prepare } = request(root.agent, ticket, 'detached-operation')
  const begin = { ...prepare, actorId: worker.id }
  await ctx.agents.withInitiator(worker, () => ctx.tickets.beginAttempt(root.agent.session, begin))
  root.detachSession()
  await expect(ctx.agents.withInitiator(worker, () => ctx.tickets.beginAttempt(root.agent.session, begin))).rejects.toMatchObject({ code: 'TICKET_ROOT_UNAVAILABLE' })
})

it('reports failed recovery and retries its known outcome on the next root resume', async () => {
  const { ctx } = await harness()
  const root = await live(ctx, 'failed-recovery-root')
  const { agent: worker } = await live(ctx, 'failed-recovery-worker')
  const ticket = await assigned(ctx, root.agent, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root.agent, ticket, 'failed-recovery'))
  const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValue(new Error('storage unavailable'))
  await expect(handle.dispose()).rejects.toThrow('storage unavailable')
  root.close()
  const warning = Promise.withResolvers<string>()
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message) => { warning.resolve(String(message)) })
  const resumed = await live(ctx, root.agent.id, root.agent.session)
  expect(await warning.promise).toContain('did not persist')
  expect(ctx.tickets.get(resumed.agent.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled' })
  flush.mockRestore()
  resumed.close()
  const recovered = await live(ctx, root.agent.id, resumed.agent.session)
  await ctx.tickets.whenIdle(recovered.agent.session)
  await expect(handle.dispose()).resolves.toBeUndefined()
})
