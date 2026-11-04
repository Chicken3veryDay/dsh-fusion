import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { CreatedWorktree, CreateWorktreeRequest } from '@deepseek-ai/dsh-experimental-worktree'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import TicketService, { TicketExecutionService, TicketId } from '../src/index.ts'

class StubWorktreeService extends Service {
  static readonly calls: CreateWorktreeRequest[] = []
  static failure: Error | undefined

  constructor(ctx: Context) {
    super(ctx, 'worktrees')
  }

  async create(_agent: Agent, request: CreateWorktreeRequest = {}, signal?: AbortSignal): Promise<CreatedWorktree> {
    signal?.throwIfAborted()
    StubWorktreeService.calls.push({ ...request })
    if (StubWorktreeService.failure !== undefined) throw StubWorktreeService.failure
    return {
      path: `/tmp/ticket-worktrees/${request.name ?? 'generated'}`,
      branch: request.name ?? 'generated',
      baseCommit: 'a'.repeat(40),
      repositoryRoot: '/tmp/ticket-repository',
    }
  }
}

function agent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return {
    id: session.id,
    session,
    options: {},
    status: 'idle',
    ctx,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    send() {},
    followup() {},
    steer() {},
    inject() {},
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
  } satisfies Agent
}

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('ticket-test-controller')
  await ctx.plugin(StubWorktreeService)
  await ctx.plugin(TicketExecutionService)
  return { ctx, root: ctx.sessions.create(SessionId('ticket-root')), worker: agent(ctx, 'ticket-worker') }
}

afterEach(() => {
  StubWorktreeService.calls.length = 0
  StubWorktreeService.failure = undefined
})

describe('Ticket execution adapter', () => {
  it('claims a direct worker, owns Jobs, and releases the Assignment on cleanup', async () => {
    const { ctx, root, worker } = await harness()
    await ctx.agents.register(worker)
    const ticket = await ctx.tickets.create(root, {
      id: TicketId('execution-ticket'), subject: 'Run work', description: 'exercise execution',
    })
    const assigned = await ctx.tickets.assign(root, {
      ticketId: ticket.id,
      expectedRevision: ticket.revision,
      actorId: root.id,
      ownerId: worker.id,
      subject: 'Worker task',
      executionMode: 'shared-workspace',
    })
    const assignmentId = assigned.assignments[0]!.id
    const handle = await ctx.ticketExecution.prepare(worker, {
      rootSessionId: root.id,
      ticketId: ticket.id,
      assignmentId,
      expectedRevision: assigned.revision,
    })
    expect(handle.workspace).toEqual({ mode: 'shared-workspace' })
    expect(handle.assignment.status).toBe('running')

    let settle!: (outcome: { status: 'completed' | 'killed'; result?: string }) => void
    let cancelReason: string | undefined
    const jobId = handle.startJob('worker subprocess', () => ({
      cancel(reason) {
        cancelReason = reason
        settle({ status: 'killed' })
      },
      done: new Promise((resolve) => { settle = resolve }),
    }))

    await handle.dispose()
    await ctx.jobs.wait(jobId, 1000, worker.id)
    expect(cancelReason).toBe('Ticket execution released')
    expect(ctx.tickets.get(root, ticket.id).assignments[0]).toMatchObject({ status: 'released', ownerId: worker.id })
    await handle.dispose()
  })

  it('rolls back a claimed Assignment when isolated Worktree preparation fails', async () => {
    const { ctx, root, worker } = await harness()
    await ctx.agents.register(worker)
    const ticket = await ctx.tickets.create(root, {
      id: TicketId('rollback-ticket'), subject: 'Prepare worktree', description: 'rollback claim',
    })
    const assigned = await ctx.tickets.assign(root, {
      ticketId: ticket.id,
      expectedRevision: ticket.revision,
      actorId: root.id,
      ownerId: worker.id,
      subject: 'Isolated task',
      executionMode: 'isolated-worktree',
    })
    const assignmentId = assigned.assignments[0]!.id
    const failure = new Error('worktree unavailable')
    StubWorktreeService.failure = failure

    await expect(ctx.ticketExecution.prepare(worker, {
      rootSessionId: root.id,
      ticketId: ticket.id,
      assignmentId,
      expectedRevision: assigned.revision,
      worktreeName: 'ticket-branch',
      from: 'HEAD',
    })).rejects.toBe(failure)

    expect(StubWorktreeService.calls).toEqual([{ name: 'ticket-branch', from: 'HEAD' }])
    expect(ctx.tickets.get(root, ticket.id).assignments[0]).toMatchObject({ status: 'released', ownerId: worker.id })
    expect(ctx.tickets.get(root, ticket.id).executionSlots[0]).toMatchObject({ status: 'released' })
  })
})
