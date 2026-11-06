/** Round-4 regression: a stored root whose messages need a later-registered projection keeps its exclusive reservation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { createUserMessage } from '../../../llm/llm/src/index.ts'
import { imageOffloadProjection } from '../../../compaction/compaction-image-offload/src/projection.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import TicketService, { TicketAttemptId, TicketOperationId, TicketExecutionService } from '../src/index.ts'
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

async function harness(before?: (ctx: Context) => Promise<void>, after?: (ctx: Context) => void) {
  const ctx = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await before?.(ctx)
  await ctx.plugin(TicketService, {})
  after?.(ctx)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('review-r4')
  await ctx.plugin(Worktrees)
  await ctx.plugin(Directories)
  await ctx.plugin(Subagents)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 200 })
  return ctx
}

async function live(ctx: Context, id: string): Promise<Agent> {
  const session = ctx.sessions.create(SessionId(id))
  const created: Agent = { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
  await ctx.agents.register(created)
  return created
}

async function assigned(ctx: Context, root: Agent, worker: Agent, workScopes: WorkScope[]): Promise<TicketView> {
  const ticket = await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, { subject: 'Review repro', description: '' }))
  return ctx.agents.withInitiator(root, () => ctx.tickets.assign(root.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id, ownerId: worker.id, subject: 'Contribute', workScopes,
  }))
}

const exclusive: WorkScope[] = [{ path: 'src/file.ts', access: 'write', exclusive: true }]

it('R4-m2 (minor) a stored root restorable only after a later-registered message projection keeps its reservation', async () => {
  const source = await harness(async (ctx) => { ctx.sessions.registerMessageProjection(imageOffloadProjection) })
  const worker = await live(source, 'probe-worker')
  const stored = await live(source, 'probe-unloaded-root')
  const image = stored.session.append('user/message', createUserMessage({
    content: [{ type: 'image', attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  stored.session.append('image/offload', { targets: [{ seq: image.seq, imageIndexes: [0] }] })
  const held = await assigned(source, stored, worker, exclusive)
  await source.agents.withInitiator(worker, () => source.tickets.beginAttempt(stored.session, {
    ticketId: held.id, expectedRevision: held.revision, actorId: worker.id, assignmentId: held.assignments[0]!.id,
    attemptId: TicketAttemptId('unloaded'), operationId: TicketOperationId('unloaded-begin'),
    workspace: { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) }, executor: { kind: 'in-process' },
  }))
  const dir = await mkdtemp(join(tmpdir(), 'ticket-r4-probe-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const recovered = await harness(async (ctx) => {
    await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
    await using writer = await ctx.sessionPersistence.create(stored.session.header)
    await writer.append(stored.session.snapshotEvents())
    await writer.flush()
  }, (ctx) => { ctx.sessions.registerMessageProjection(imageOffloadProjection) })
  const root = await live(recovered, 'probe-root')
  const competingWorker = await live(recovered, 'probe-competing-worker')
  const ticket = await assigned(recovered, root, competingWorker, exclusive)
  const admission = await recovered.ticketExecution.prepare(competingWorker, { rootSessionId: root.id, ticketId: ticket.id,
    assignmentId: ticket.assignments[0]!.id, expectedRevision: ticket.revision,
    attemptId: TicketAttemptId('competing'), operationId: TicketOperationId('competing'),
    workspace: { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) }, executor: { kind: 'in-process' },
  }).then(async (handle) => { await handle.dispose(); return 'admitted' }, (error: unknown) => String((error as { code?: string }).code ?? error))
  expect(admission).toBe('TICKET_ATTEMPT_STATE')
})
