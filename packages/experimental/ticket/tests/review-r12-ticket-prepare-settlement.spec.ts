/** A cancelled preparation waits for the ledger's write of its handed outcome, and reports that write truthfully. */
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { type SubagentResult } from '@deepseek-ai/dsh-subagent'
import { expect, it, onTestFinished, vi } from 'vitest'
import TicketService, { TicketExecutionService } from '../src/index.ts'
import { assigned, live, request } from './review-r5-harness.ts'

class Directories extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  async ensure() { return '/review/shared' }
}
class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create(): Promise<never> { throw new Error('unexpected Worktree creation') }
}

async function externalHarness() {
  const ctx = new Context()
  onTestFinished(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('r12-prepare')
  await ctx.plugin(Directories)
  await ctx.plugin(Worktrees)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: 1000 })
  return ctx
}

const describeFailure = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The caller aborts while the runtime receipt is flushing. An in-process attempt then goes `preparing(aborted)` → `handed`
 * without a stop; an activation goes `launched(aborted)` → `stopping(cancel)`, whose stop reaches `handed` and then waits
 * for the ledger under its deadline. The final `settled` flush is held in both cases.
 */
it.each([
  { executor: 'in-process', holdFlush: false },
  { executor: 'in-process', holdFlush: true },
  { executor: 'activation', holdFlush: false },
  { executor: 'activation', holdFlush: true },
] as const)('a cancelled $executor preparation with held final flush ($holdFlush) rejects within the stop deadline and truthfully', async ({ executor, holdFlush }) => {
  const ctx = await externalHarness()
  const suffix = `r12-prepare-${executor}-${holdFlush}`
  const { agent: root } = await live(ctx, `${suffix}-root`)
  const { agent: worker } = await live(ctx, `${suffix}-worker`)
  const ticket = await assigned(ctx, root, worker)
  const result = Promise.withResolvers<SubagentResult>()
  ctx.subagents.registerProvider({
    name: 'r12-prepare', execution: { kind: 'dedicated-process' }, inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start() {
      return { id: SessionId(`${suffix}-child`), result: result.promise,
        async dispose() { result.resolve({ output: [], stopReason: 'aborted' }) } }
    },
  })
  const abort = new AbortController()
  const settledFlushEntered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let settledFlushCompleted = false
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    const attempt = session === root.session ? ctx.tickets.get(root.session, ticket.id).attempts[0] : undefined
    if (attempt?.status === 'running' && attempt.runtimeReceipt !== undefined && !abort.signal.aborted) {
      // Fake only the deadline clock from here, before any stop creates its deadline.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      abort.abort(new Error('caller cancelled preparation'))
    }
    if (attempt?.status === 'settled') {
      settledFlushEntered.resolve(undefined)
      if (holdFlush) await release.promise
      const flushed = await flush(session)
      settledFlushCompleted = true
      return flushed
    }
    return flush(session)
  })
  let finished = false
  const preparation = ctx.ticketExecution.prepare(root, {
    ...request(root, ticket, suffix),
    ...executor === 'activation' ? { executor: { kind: 'dedicated-process', provider: 'r12-prepare' } as const } : {},
    signal: abort.signal,
  }).then(() => 'published', describeFailure).then((value) => { finished = true; return value })
  let beforeRelease: boolean
  let outcome: string
  try {
    await settledFlushEntered.promise
    // The fixture's deadline is 1000 ms. Advancing its clock cannot release the independently held flush.
    await vi.advanceTimersByTimeAsync(5000)
    beforeRelease = finished
  } finally {
    release.resolve(undefined)
    outcome = await preparation
    vi.useRealTimers()
  }
  const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
  expect({ status: attempt?.status, outcome: attempt?.status === 'settled' ? attempt.outcome : undefined, settledFlushCompleted })
    .toEqual({ status: 'settled', outcome: 'cancelled', settledFlushCompleted: true })
  expect(outcome).not.toBe('published')
  // prepare() must reject once the stop deadline passes even while its settlement cannot flush, and once that flush
  // completed, its rejection must not claim the settlement is not durable.
  expect({ rejectedBeforeRelease: beforeRelease, claimsNotDurable: /not durable yet/.test(outcome), outcome })
    .toEqual({ rejectedBeforeRelease: true, claimsNotDurable: false, outcome })
})

it('a pending settlement rejection names the ledger write, not a producer timeout, as its cause', async () => {
  const { harness } = await import('./review-r5-harness.ts')
  const { ctx } = await harness()
  const { agent: root } = await live(ctx, 'r12-cause-root')
  const { agent: worker } = await live(ctx, 'r12-cause-worker')
  const ticket = await assigned(ctx, root, worker)
  const handle = await ctx.ticketExecution.prepare(worker, request(root, ticket, 'r12-cause'))
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    entered.resolve(undefined)
    await release.promise
    return flush(session)
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let failure: unknown
  const stopping = handle.settle().catch((error: unknown) => { failure = error })
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
  } finally {
    release.resolve(undefined)
    await stopping
    vi.useRealTimers()
  }
  const cause = failure instanceof Error ? failure.cause : undefined
  expect({ code: (failure as { code?: string } | undefined)?.code, cause: cause instanceof Error ? cause.message : String(cause) })
    .toEqual({ code: 'TICKET_SETTLEMENT_PENDING', cause: expect.not.stringMatching(/producer settlement timed out/) as object })
})
