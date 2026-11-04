import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { CreatedWorktree, CreateWorktreeRequest } from '@deepseek-ai/dsh-experimental-worktree'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import TicketService, { TicketAttemptId, TicketExecutionService, TicketId, TicketOperationId } from '../src/index.ts'

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

class StubWorkingDirectory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }

  async ensure(_agent: Agent, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return StubWorkingDirectory.directory
  }

  static directory = '/tmp/ticket-workspace'
}

class StubSubagents extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  getProvider(): undefined {
    return undefined
  }

  async startActivation(): Promise<never> {
    throw new Error('unexpected activation')
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
  await ctx.plugin(StubWorkingDirectory)
  await ctx.plugin(StubSubagents)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  const rootAgent = agent(ctx, 'ticket-root')
  await ctx.agents.register(rootAgent)
  return { ctx, root: rootAgent.session, worker: agent(ctx, 'ticket-worker') }
}

afterEach(() => {
  StubWorktreeService.calls.length = 0
  StubWorktreeService.failure = undefined
  StubWorkingDirectory.directory = '/tmp/ticket-workspace'
})

describe('Ticket execution adapter', () => {
  it('claims a direct worker attempt, owns Jobs, and settles then releases on cleanup', async () => {
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
      attemptId: TicketAttemptId('attempt-1'),
      operationId: TicketOperationId('operation-1'),
      workspace: { kind: 'shared-workspace', directory: '/tmp/ticket-workspace', baseCommit: 'a'.repeat(40) },
      executor: { kind: 'in-process' },
    })
    expect(handle.workspace).toMatchObject({ directory: '/tmp/ticket-workspace', baseCommit: 'a'.repeat(40) })
    expect(handle.assignment.status).toBe('running')
    expect(handle.attempt).toMatchObject({ status: 'running', specRevision: 1 })
    expect(handle.jobs).toEqual([])

    let settle!: (outcome: JobOutcome) => void
    let cancelReason: string | undefined
    const jobId = await handle.startJob('worker subprocess', () => ({
      cancel(reason) {
        cancelReason = reason
        settle({ status: 'killed' })
      },
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    }))
    expect(handle.jobs).toEqual([jobId])

    await handle.dispose()
    expect(cancelReason).toBe('Ticket execution released')
    const current = ctx.tickets.get(root, ticket.id)
    expect(current.assignments[0]).toMatchObject({ status: 'released', ownerId: worker.id })
    expect(current.attempts[0]).toMatchObject({ status: 'settled', outcome: 'cancelled' })
    await handle.dispose()
  })

  it('retains an unknown attempt when isolated Worktree preparation fails', async () => {
    const { ctx, root, worker } = await harness()
    await ctx.agents.register(worker)
    const ticket = await ctx.tickets.create(root, {
      id: TicketId('rollback-ticket'), subject: 'Prepare worktree', description: 'retain unknown attempt',
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

    const request = {
      rootSessionId: root.id,
      ticketId: ticket.id,
      assignmentId,
      expectedRevision: assigned.revision,
      attemptId: TicketAttemptId('attempt-rollback'),
      operationId: TicketOperationId('operation-rollback'),
      workspace: { kind: 'isolated-worktree' as const, directory: '/tmp/ticket-workspace', baseCommit: 'b'.repeat(40) },
      executor: { kind: 'in-process' as const },
      worktreeName: 'ticket-branch',
    }
    await expect(ctx.ticketExecution.prepare(worker, request)).rejects.toThrow(AggregateError)
    expect(StubWorktreeService.calls).toEqual([{ name: 'ticket-branch', from: 'b'.repeat(40) }])

    const current = ctx.tickets.get(root, ticket.id)
    expect(current.attempts[0]).toMatchObject({ status: 'unknown', assignmentId })
    expect(current.assignments[0]).toMatchObject({ status: 'running', activeAttemptId: 'attempt-rollback' })

    await expect(ctx.ticketExecution.prepare(worker, { ...request, operationId: TicketOperationId('operation-retry') }))
      .rejects.toThrow()
  })
})
