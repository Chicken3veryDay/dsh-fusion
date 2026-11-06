/** Round-4 regressions: restart recovery, stored reservation scans, authority diagnostics, and deleted roots. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import TicketService, { TicketAttemptId, TicketError, TicketOperationId, TicketExecutionService } from '../src/index.ts'
import type { TicketView, WorkScope } from '../src/types.ts'

class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create(): Promise<never> { throw new Error('unexpected worktree') }
}
class Directories extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  get() { return '/review/shared' }
  async ensure() { return '/review/shared' }
}
class Subagents extends Service {
  constructor(ctx: Context) { super(ctx, 'subagents') }
  getProvider() { return undefined }
}

const shared = { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) } as const
const exclusive: WorkScope[] = [{ path: 'src/file.ts', access: 'write', exclusive: true }]

async function harness(options: { dir?: string; before?: (ctx: Context) => Promise<void> } = {}) {
  const ctx = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  if (options.dir !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: options.dir, compression: 'none' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await options.before?.(ctx)
  await ctx.plugin(TicketService, {})
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('review-r4-regressions')
  await ctx.plugin(Worktrees)
  await ctx.plugin(Directories)
  await ctx.plugin(Subagents)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 200 })
  return ctx
}

async function live(ctx: Context, id: string, seed?: Session): Promise<Agent> {
  const session = ctx.sessions.create(SessionId(id), seed === undefined ? undefined : { seed: seed.snapshotEvents() })
  const created: Agent = { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
  await ctx.agents.register(created)
  return created
}

async function assigned(ctx: Context, root: Agent, worker: Agent, workScopes: WorkScope[]): Promise<TicketView> {
  const ticket = await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, { subject: 'Regression', description: '' }))
  return ctx.agents.withInitiator(root, () => ctx.tickets.assign(root.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id, ownerId: worker.id, subject: 'Contribute', workScopes,
  }))
}

function prepare(ctx: Context, caller: Agent, root: Agent, ticket: TicketView, suffix: string) {
  return ctx.ticketExecution.prepare(caller, { rootSessionId: root.id, ticketId: ticket.id,
    assignmentId: ticket.assignments[0]!.id, expectedRevision: ticket.revision,
    attemptId: TicketAttemptId(`attempt-${suffix}`), operationId: TicketOperationId(`prepare-${suffix}`),
    workspace: shared, executor: { kind: 'in-process' } })
}

function code(error: unknown): string {
  if (error instanceof AggregateError) return `AggregateError(${error.errors.map(code).join(',')})`
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error)
}

async function competing(ctx: Context, prefix: string): Promise<{ outcome: string; error?: unknown }> {
  const root = await live(ctx, `${prefix}-competing-root`)
  const worker = await live(ctx, `${prefix}-competing-worker`)
  const ticket = await assigned(ctx, root, worker, exclusive)
  return prepare(ctx, worker, root, ticket, `${prefix}-competing`)
    .then(async (handle) => { await handle.dispose(); return { outcome: 'admitted' } }, (error: unknown) => ({ outcome: code(error), error }))
}

/** Store one root holding an unsettled exclusive shared attempt in `dir`, as an earlier host process left it. */
async function storeUnsettledRoot(dir: string, id: string): Promise<void> {
  const source = await harness()
  const worker = await live(source, `${id}-worker`)
  const root = await live(source, id)
  const held = await assigned(source, root, worker, exclusive)
  await source.agents.withInitiator(worker, () => source.tickets.beginAttempt(root.session, {
    ticketId: held.id, expectedRevision: held.revision, actorId: worker.id, assignmentId: held.assignments[0]!.id,
    attemptId: TicketAttemptId('stored'), operationId: TicketOperationId('stored-begin'), workspace: shared, executor: { kind: 'in-process' },
  }))
  const writer = new Context()
  await writer.plugin(SessionStore)
  await writer.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await using handle = await writer.sessionPersistence.create(root.session.header)
  await handle.append(root.session.snapshotEvents())
  await handle.flush()
  await writer.fiber.dispose()
}

describe('R4 regressions', () => {
  it('R4-1 restart: a resumed root settles an execution-owned in-process attempt the earlier host left running', async () => {
    const earlier = new Context()
    const never = Promise.withResolvers<JobOutcome>()
    // The earlier host never tears down during the test; release its producer afterwards so the fixture can close.
    onTestFinished(async () => { never.resolve({ status: 'killed' }); await Promise.resolve(earlier.fiber.dispose()).catch(() => {}) })
    await earlier.plugin(SessionStore)
    await earlier.plugin(SessionProjectionRegistry)
    await earlier.plugin(AgentRegistry)
    await earlier.plugin(TicketService, {})
    await earlier.plugin(LocalJobRegistry)
    earlier.jobs.attachController('earlier')
    await earlier.plugin(Worktrees)
    await earlier.plugin(Directories)
    await earlier.plugin(Subagents)
    await earlier.plugin(TicketExecutionService, { settlementTimeoutMs: 200 })
    const worker = await live(earlier, 'restart-worker')
    const root = await live(earlier, 'restart-root')
    const held = await assigned(earlier, root, worker, exclusive)
    const handle = await prepare(earlier, worker, root, held, 'restart')
    await handle.startJob('outlives nothing', () => ({ cancel() {}, done: never.promise }))
    // A manual attempt in the same log is host-owned and stays untouched by recovery.
    const manualWorker = await live(earlier, 'restart-manual-worker')
    const manualTicket = await assigned(earlier, root, manualWorker, [])
    await earlier.agents.withInitiator(manualWorker, () => earlier.tickets.beginAttempt(root.session, {
      ticketId: manualTicket.id, expectedRevision: manualTicket.revision, actorId: manualWorker.id,
      assignmentId: manualTicket.assignments[0]!.id, attemptId: TicketAttemptId('manual'), operationId: TicketOperationId('manual-begin'),
      workspace: shared, executor: { kind: 'in-process' },
    }))
    const log = root.session
    // The earlier host ends without teardown; a later host resumes the root from its log.
    const later = await harness()
    const resumed = await live(later, 'restart-root', log)
    await vi.waitFor(() => { expect(later.tickets.get(resumed.session, held.id).attempts[0]?.status).toBe('settled') })
    const attempt = later.tickets.get(resumed.session, held.id).attempts[0]
    expect(attempt).toMatchObject({ status: 'settled', outcome: 'cancelled' })
    expect(attempt?.diagnostics.join(' ')).toMatch(/host/u)
    expect(later.tickets.get(resumed.session, manualTicket.id).attempts[0]?.status).toBe('preparing')
    expect((await competing(later, 'restart')).outcome).toBe('admitted')
  })

  it('R4-1 resuming a root leaves a still-running attempt this host admitted to its execution owner', async () => {
    const ctx = await harness()
    const worker = await live(ctx, 'owned-worker')
    const session = ctx.sessions.prepare(SessionId('owned-root'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const root: Agent = { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
      send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
      runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
    await ctx.agents.register(root)
    const held = await assigned(ctx, root, worker, exclusive)
    const handle = await prepare(ctx, worker, root, held, 'owned')
    const done = Promise.withResolvers<JobOutcome>()
    await handle.startJob('still running', () => ({ cancel() { done.resolve({ status: 'killed' }) }, done: done.promise }))
    detach()
    const resumed = ctx.sessions.create(SessionId('owned-root'), { seed: session.snapshotEvents() })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ctx.tickets.get(resumed, held.id).attempts[0]?.status).toBe('running')
    await handle.dispose()
    expect(ctx.tickets.get(resumed, held.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled' })
  })

  it('R4-2 the owner of an admission whose flush failed ends it as cancelled when no retry comes', async () => {
    const ctx = await harness()
    const root = await live(ctx, 'abandoned-root')
    const worker = await live(ctx, 'abandoned-worker')
    const ticket = await assigned(ctx, root, worker, exclusive)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(prepare(ctx, worker, root, ticket, 'abandoned')).rejects.toThrow('disk unavailable')
    flush.mockRestore()
    ctx.emit('agent/disposed', { agent: worker })
    await vi.waitFor(() => {
      expect(ctx.tickets.get(root.session, ticket.id).attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled' })
    })
    expect((await competing(ctx, 'abandoned')).outcome).toBe('admitted')
  })

  it('R4-m3 activation reads no stored log, and a listing failure refuses shared admission with a retryable report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ticket-r4-scan-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    await storeUnsettledRoot(dir, 'scan-root')
    const calls: string[] = []
    const ctx = await harness({ dir, before: async (ctx) => {
      vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async () => { calls.push('list'); throw new Error('catalog unavailable') })
      vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async () => { calls.push('open'); throw new Error('unexpected open') })
    } })
    expect(calls).toEqual([])
    const refused = await competing(ctx, 'scan')
    expect(refused.outcome).toBe('TICKET_RECOVERY_FAILED')
    expect((refused.error as Error).message).toMatch(/stored Ticket reservations.*retry/iu)
    vi.restoreAllMocks()
    // Storage recovered: the next admission scans again and finds the stored exclusive reservation.
    const blocked = await competing(ctx, 'scan-again')
    expect(blocked.outcome).toBe('TICKET_ATTEMPT_STATE')
    expect((blocked.error as Error).message).toContain('scan-root')
  })

  it('R4-m2 an unreadable stored root refuses shared admission conservatively and names that root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ticket-r4-unreadable-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    await storeUnsettledRoot(dir, 'unreadable-root')
    const ctx = await harness({ dir })
    const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const spy = vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => {
      if (id === SessionId('unreadable-root')) throw new Error('log damaged')
      return open(id, access, options)
    })
    const refused = await competing(ctx, 'unreadable')
    expect(refused.outcome).toBe('TICKET_RECOVERY_FAILED')
    expect((refused.error as Error).message).toContain('unreadable-root')
    spy.mockRestore()
    expect((await competing(ctx, 'readable')).outcome).toBe('TICKET_ATTEMPT_STATE')
  })

  it('R4-m6 deleting a stored root releases its reservation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ticket-r4-deleted-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    await storeUnsettledRoot(dir, 'deleted-root')
    const ctx = await harness({ dir })
    expect((await competing(ctx, 'before-delete')).outcome).toBe('TICKET_ATTEMPT_STATE')
    const stat = await ctx.sessionPersistence.stat(SessionId('deleted-root'))
    if (stat?.location?.kind !== 'jsonl') throw new Error('expected a JSONL location')
    await rm(stat.location.path, { force: true })
    expect(await ctx.sessionPersistence.stat(SessionId('deleted-root'))).toBeUndefined()
    expect((await competing(ctx, 'after-delete')).outcome).toBe('admitted')
  })

  it('R4-m4 an authority that is not ready yet refuses with a retryable code and its own message', async () => {
    const ctx = await harness()
    const root = await live(ctx, 'loading-root')
    const cause = new Error('still loading')
    ctx.tickets.registerCoordinatorAuthority(() => {
      throw new TicketError('Coordinator authority is still loading; retry the Ticket creation', 'TICKET_COORDINATOR_UNAVAILABLE', { cause })
    })
    const failure = await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, { subject: 'Loading', description: '' }))
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'TICKET_COORDINATOR_UNAVAILABLE', cause })
    expect((failure as Error).message).toMatch(/retry/u)
    expect(ctx.tickets.list(root.session)).toEqual([])
  })

  it('R4-m5 a non-live coordinator selected by the authority is named with its remedy', async () => {
    const ctx = await harness()
    const root = await live(ctx, 'owner-root')
    ctx.tickets.registerCoordinatorAuthority(() => SessionId('departed-member'))
    const failure = await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, { subject: 'Departed', description: '' }))
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'TICKET_AUTHORITY' })
    const message = (failure as Error).message
    expect(message).toContain('departed-member')
    expect(message).toMatch(/coordinator authority/u)
    expect(message).toMatch(/resume/u)
    expect(message).toMatch(/hand.*owner/u)
  })
})
