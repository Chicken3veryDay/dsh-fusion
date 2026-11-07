import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
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

it('does not recover a root withdrawn before its queued creation recovery runs', async () => {
  const { ctx } = await harness()
  const { agent: barrier } = await live(ctx, 'withdrawal-barrier')
  const session = ctx.sessions.prepare(SessionId('withdrawn-before-created'))
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const before = session.snapshotEvents()
  detach()
  await ctx.agents.withInitiator(barrier, () => ctx.tickets.create(barrier.session, { subject: 'Recovery barrier', description: '' }))
  expect(ctx.sessions.get(session.id)).toBeUndefined()
  expect(session.snapshotEvents()).toEqual(before)
})

it('keeps a resumed root authoritative when it becomes live during a stored reservation scan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ticket-live-during-scan-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const source = await harness()
  const { agent: storedRoot } = await live(source.ctx, 'stored-scan-root')
  const { agent: storedWorker } = await live(source.ctx, 'stored-scan-worker')
  const storedTicket = await assigned(source.ctx, storedRoot, storedWorker)
  await source.ctx.agents.withInitiator(storedWorker, () => source.ctx.tickets.beginAttempt(storedRoot.session, {
    ...request(storedRoot, storedTicket, 'stored-scan'), actorId: storedWorker.id,
  }))
  const { ctx } = await harness(async (context) => { await context.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' }) })
  const writer = await ctx.sessionPersistence.create(storedRoot.session.header)
  await writer.append(storedRoot.session.snapshotEvents())
  await writer.flush()
  await writer.close()
  const { agent: root } = await live(ctx, 'scan-contender-root')
  const { agent: worker } = await live(ctx, 'scan-contender-worker')
  const ticket = await assigned(ctx, root, worker)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  const spy = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (id, mode) => {
    const stored = await open(id, mode)
    if (id === storedRoot.id) { entered.resolve(undefined); await release.promise }
    return stored
  })
  const preparation = ctx.ticketExecution.prepare(worker, request(root, ticket, 'scan-contender')).catch((error: unknown) => error)
  await entered.promise
  const { agent: resumed } = await live(ctx, storedRoot.id, storedRoot.session)
  release.resolve(undefined)
  expect(await preparation).toMatchObject({ code: 'TICKET_ATTEMPT_STATE' })
  spy.mockRestore()
  expect(ctx.tickets.get(resumed.session, storedTicket.id).attempts[0]!.status).toBe('preparing')
})
