/** Round-5 review fixtures for real Ticket, Session and Agent lifecycles. */
import { onTestFinished, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import TicketService, { TicketAttemptId, TicketOperationId, TicketExecutionService } from '../src/index.ts'
import type { TicketAttemptSnapshot, TicketView, WorkScope } from '../src/types.ts'

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
  async startActivation(): Promise<never> { throw new Error('unexpected activation') }
}

export const shared = { kind: 'shared-workspace', directory: '/review/shared', baseCommit: 'a'.repeat(40) } as const
export const exclusive: WorkScope[] = [{ path: 'src/file.ts', access: 'write', exclusive: true }]

export async function harness(before?: (ctx: Context) => Promise<void>, settlementTimeoutMs = 1000) {
  const ctx = new Context()
  onTestFinished(async () => { vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await before?.(ctx)
  const tickets = await ctx.plugin(TicketService, {})
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('review-r5')
  await ctx.plugin(Worktrees)
  await ctx.plugin(Directories)
  await ctx.plugin(Subagents)
  const execution = await ctx.plugin(TicketExecutionService, { settlementTimeoutMs })
  return { ctx, tickets, execution }
}

export async function live(ctx: Context, id: string, seed?: Session) {
  const session = ctx.sessions.prepare(SessionId(id), seed === undefined ? undefined : { seed: seed.snapshotEvents() })
  const detachSession = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const agent: Agent = { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
  const detachAgent = ctx.agents.enter(agent, undefined)
  await ctx.agents.announce(agent, 'startup')
  const close = () => { detachAgent(); detachSession() }
  onTestFinished(close)
  return { agent, close, detachSession, detachAgent }
}

export async function assigned(ctx: Context, root: Agent, worker: Agent, workScopes: WorkScope[] = exclusive): Promise<TicketView> {
  const ticket = await ctx.agents.withInitiator(root, () => ctx.tickets.create(root.session, { subject: 'Round-5 review', description: '' }))
  return ctx.agents.withInitiator(root, () => ctx.tickets.assign(root.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.id, ownerId: worker.id, subject: 'Contribute', workScopes,
  }))
}

export function request(root: Agent, ticket: TicketView, suffix: string) {
  return { rootSessionId: root.id, ticketId: ticket.id, assignmentId: ticket.assignments[0]!.id,
    expectedRevision: ticket.revision, attemptId: TicketAttemptId(`attempt-${suffix}`), operationId: TicketOperationId(`prepare-${suffix}`),
    workspace: shared, executor: { kind: 'in-process' } as const }
}

export async function competing(ctx: Context, suffix: string) {
  const { agent: root } = await live(ctx, `${suffix}-root`)
  const { agent: worker } = await live(ctx, `${suffix}-worker`)
  const ticket = await assigned(ctx, root, worker)
  return ctx.ticketExecution.prepare(worker, request(root, ticket, suffix)).then(async (handle) => {
    await handle.dispose()
    return 'admitted'
  }, code)
}

export function code(error: unknown): string {
  if (error instanceof AggregateError) return `AggregateError(${error.errors.map(code).join(',')})`
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error)
}

export function outcomeOf(attempt: TicketAttemptSnapshot | undefined) {
  return attempt?.status === 'settled' ? attempt.outcome : undefined
}
