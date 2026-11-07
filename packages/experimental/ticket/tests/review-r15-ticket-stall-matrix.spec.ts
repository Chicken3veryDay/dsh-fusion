/** Review round 15: every held attempt write × every stop trigger × repeat, enumerated rather than sampled, for an in-process
 * attempt and an activation-bearing attempt. Only setTimeout/clearTimeout are faked; the clock moves 5000 ms against the
 * configured 1000 ms settlementTimeoutMs, so no assertion depends on wall-clock time. */
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { type SubagentResult } from '@deepseek-ai/dsh-subagent'
import { expect, it, onTestFinished, vi } from 'vitest'
import TicketService, { TicketExecutionService, type TicketView } from '../src/index.ts'
import { assigned, code, competing, live, request } from './review-r5-harness.ts'

const SETTLEMENT_TIMEOUT_MS = 1000

class Directories extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  get() { return '/review/shared' }
  async ensure() { return '/review/shared' }
}
class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create(): Promise<never> { throw new Error('unexpected worktree') }
}

type Executor = 'in-process' | 'activation'
type Point = 'admission' | 'workspace' | 'runtime' | 'settlement' | 'uncertainty'
type Trigger = 'abort' | 'owner' | 'teardown' | 'settle' | 'dispose' | 'none'
interface Case {
  readonly executor: Executor
  readonly point: Point
  readonly trigger: Trigger
  readonly triggerAt?: 'admission' | 'workspace' | 'runtime'
  readonly repeat: boolean
}

async function host(withExecution: boolean) {
  const ctx = new Context()
  onTestFinished(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService, {})
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('review-r15')
  await ctx.plugin(Directories)
  await ctx.plugin(Worktrees)
  await ctx.plugin(SubagentRuntime)
  const execution = withExecution ? await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: SETTLEMENT_TIMEOUT_MS }) : undefined
  return { ctx, execution }
}

/** Fold `events` in a fresh host under the same root id. */
async function replay(rootId: string, events: ReturnType<Session['snapshotEvents']>, ticketId: TicketView['id']) {
  const { ctx } = await host(false)
  const { agent } = await live(ctx, rootId, { snapshotEvents: () => events } as unknown as Session)
  return { ctx, root: agent, view: () => ctx.tickets.get(agent.session, ticketId) }
}

/** The attempt as the last `ticket/state` event of `events` records it, before any recovery write. */
function lastAttempt(events: ReturnType<Session['snapshotEvents']>, ticketId: TicketView['id']) {
  let attempt: TicketView['attempts'][number] | undefined
  for (const event of events) {
    if (event.type !== 'ticket/state') continue
    const data = event.data as { ticket: { id: string; attempts?: TicketView['attempts'] } }
    if (data.ticket.id === ticketId && data.ticket.attempts !== undefined) attempt = data.ticket.attempts[0]
  }
  return attempt
}

/** Resolve once the root's first attempt is settled, or after 20 s of real time. */
async function settledOrCap(ctx: Context, root: Agent, ticketId: TicketView['id']): Promise<void> {
  const done = () => ctx.tickets.get(root.session, ticketId).attempts[0]?.status === 'settled'
  if (done()) return
  const reached = Promise.withResolvers<undefined>()
  const dispose = ctx.on('session/event', () => { if (done()) reached.resolve(undefined) })
  const cap = setTimeout(() => { reached.resolve(undefined) }, 20_000)
  try { await reached.promise } finally { dispose(); clearTimeout(cap) }
  await ctx.tickets.whenIdle(root.session)
}

const cases: Case[] = []
for (const executor of ['in-process', 'activation'] as const) {
  for (const repeat of [false, true]) {
    for (const point of ['admission', 'workspace', 'runtime'] as const) {
      for (const trigger of ['abort', 'owner', 'teardown'] as const) cases.push({ executor, point, trigger, repeat })
    }
    for (const trigger of ['settle', 'dispose'] as const) cases.push({ executor, point: 'settlement', trigger, repeat })
    for (const triggerAt of ['admission', 'workspace', 'runtime'] as const) {
      for (const trigger of ['abort', 'owner', 'teardown'] as const) cases.push({ executor, point: 'settlement', trigger, triggerAt, repeat })
    }
    if (executor === 'in-process') {
      for (const trigger of ['none', 'abort', 'owner', 'teardown'] as const) cases.push({ executor, point: 'uncertainty', trigger, repeat })
    }
  }
}

const label = (scenario: Case) => `${scenario.executor} ${scenario.point}${scenario.triggerAt === undefined ? '' : `@${scenario.triggerAt}`} ${scenario.trigger}${scenario.repeat ? ' repeated' : ''}`

it.each(cases.map(scenario => [label(scenario), scenario] as const))('%s', async (name, scenario) => {
  const violations: string[] = []
  const { ctx, execution } = await host(true)
  const suffix = `r15-${name.replaceAll(/[^a-z0-9]+/gi, '-')}`
  const { agent: root } = await live(ctx, `${suffix}-root`)
  const worker = await live(ctx, `${suffix}-worker`)
  const ticket = await assigned(ctx, root, worker.agent)
  const result = Promise.withResolvers<SubagentResult>()
  ctx.subagents.registerProvider({
    name: 'r15', execution: { kind: 'dedicated-process' }, inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    async start() {
      return { id: SessionId(`${suffix}-child`), result: result.promise,
        async dispose() { result.resolve({ output: [], stopReason: 'aborted' }) } }
    },
  })
  const abort = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  const written = Promise.withResolvers<undefined>()
  let crashPrefix: ReturnType<Session['snapshotEvents']> | undefined
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let teardown: Promise<unknown> | undefined
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    if (scenario.trigger === 'abort') abort.abort(new Error('caller cancelled preparation'))
    else if (scenario.trigger === 'owner') worker.close()
    else if (scenario.trigger === 'teardown') teardown = execution?.dispose()
  }
  const stageOf = (): Point | undefined => {
    const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
    if (attempt === undefined) return undefined
    if (attempt.status === 'settled') return 'settlement'
    if (attempt.status === 'unknown') return 'uncertainty'
    if (attempt.runtimeReceipt !== undefined) return 'runtime'
    if (attempt.workspaceReceipt !== undefined) return 'workspace'
    return 'admission'
  }
  let holding = true
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (session !== root.session) return flush(session)
    const stage = stageOf()
    if (stage === scenario.triggerAt) fire()
    if (stage !== scenario.point || !holding) return flush(session)
    holding = false
    entered.resolve(undefined)
    await gate.promise
    const flushed = await flush(session)
    // Everything appended so far is durable; the queued settlement has not appended yet. A crash here keeps exactly this.
    crashPrefix = root.session.snapshotEvents()
    written.resolve(undefined)
    return flushed
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const published = scenario.trigger === 'settle' || scenario.trigger === 'dispose'
  const settled = new Set<Promise<unknown>>()
  const track = <T>(promise: Promise<T>) => { void promise.then(() => settled.add(promise), () => settled.add(promise)); return promise }
  const preparation = track(ctx.ticketExecution.prepare(worker.agent, {
    ...request(root, ticket, suffix),
    ...published ? {} : { signal: abort.signal },
    ...scenario.executor === 'activation' ? { executor: { kind: 'dedicated-process', provider: 'r15' } as const } : {},
    ...scenario.point === 'uncertainty' ? { workspace: { kind: 'isolated-worktree', directory: '/review/shared' } as const } : {},
  }))
  const outcome = preparation.then(() => 'published', code)
  const stops: Promise<unknown>[] = []
  try {
    if (published) {
      const handle = await preparation
      if (scenario.trigger === 'settle') result.resolve({ output: [], stopReason: 'completed' })
      const stop = () => track(scenario.trigger === 'settle' ? handle.settle() : handle.dispose())
      stops.push(stop())
      await entered.promise
      if (scenario.repeat) stops.push(stop())
    } else {
      await entered.promise
      fire()
      if (scenario.repeat && scenario.trigger === 'abort') abort.abort(new Error('aborted again'))
      if (scenario.repeat && scenario.trigger === 'owner') worker.close()
    }
    if (teardown !== undefined) void track(teardown)
    await vi.advanceTimersByTimeAsync(5 * SETTLEMENT_TIMEOUT_MS)
    if (!published) {
      if (!settled.has(preparation)) violations.push(`prepare did not settle while the ${scenario.point} write was held`)
      else {
        const value = await outcome
        if (value === 'published') violations.push('a stopped preparation published a handle')
        else if (!value.includes('TICKET_SETTLEMENT_PENDING')) violations.push(`prepare did not report the held write: ${value}`)
      }
    }
    for (const [index, stop] of stops.entries()) {
      if (!settled.has(stop)) violations.push(`stop ${String(index)} did not settle while the settlement write was held`)
      else if (await stop.then(() => 'settled', code) !== 'TICKET_SETTLEMENT_PENDING') violations.push(`stop ${String(index)} claimed a held write`)
    }
    if (teardown !== undefined && !settled.has(teardown)) violations.push(`teardown did not settle while the ${scenario.point} write was held`)
    vi.useRealTimers()
    if (teardown !== undefined) await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: SETTLEMENT_TIMEOUT_MS })
    // The reservation-specific refusal, not any refusal: a live coordinator for an isolated worktree, a competing root otherwise.
    const probe = async (tag: string) => {
      if (scenario.point !== 'uncertainty') return competing(ctx, `${suffix}-${tag}`)
      const current = ctx.tickets.get(root.session, ticket.id)
      return ctx.ticketExecution.prepare(root, request(root, current, `${suffix}-${tag}`)).then(async (handle) => {
        await handle.dispose()
        return 'admitted'
      }, code)
    }
    const whileHeld = await probe('held')
    if (whileHeld !== 'TICKET_ATTEMPT_STATE') violations.push(`a probe while the ${scenario.point} write was held got ${whileHeld}`)
    if (scenario.point !== 'settlement' && stageOf() === 'settlement') violations.push('the attempt settled before its held write completed')
    gate.resolve(undefined)
    await written.promise
    await outcome
    await Promise.allSettled(stops)
    await ctx.tickets.whenIdle(root.session)
    // A stop that runs after the release (an activation stopping after its runtime receipt) enqueues the settlement later
    // than whenIdle can see; wait for the durable status itself, with a generous cap so a stuck attempt still fails.
    if (scenario.point !== 'uncertainty') await settledOrCap(ctx, root, ticket.id)
    const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
    const expected = scenario.point === 'uncertainty' ? 'unknown' : scenario.trigger === 'settle' ? 'succeeded' : 'cancelled'
    const actual = attempt?.status === 'settled' ? attempt.outcome : attempt?.status
    if (actual !== expected) violations.push(`the attempt ended ${String(actual)}, not ${expected}`)
    const afterRelease = await probe('after')
    const wantAfter = expected === 'unknown' ? 'TICKET_ATTEMPT_STATE' : 'admitted'
    if (afterRelease !== wantAfter) violations.push(`after the write completed, a probe got ${afterRelease}, not ${wantAfter}`)
    // Replay equality: a fresh host folding the full log sees the live Ticket.
    const full = await replay(root.id, root.session.snapshotEvents(), ticket.id)
    if (JSON.stringify(full.view()) !== JSON.stringify(ctx.tickets.get(root.session, ticket.id))) violations.push('full replay differs from the live Ticket')
    // A crash right after the held write became durable, before the queued settlement appended.
    if (scenario.point !== 'settlement' && scenario.point !== 'uncertainty' && crashPrefix !== undefined) {
      const crashed = await replay(root.id, crashPrefix, ticket.id)
      const recovered = lastAttempt(crashPrefix, ticket.id)
      if (recovered === undefined) violations.push('the crash prefix lost the admitted attempt')
      else if (recovered.status === 'settled') violations.push('the crash prefix already holds a settlement')
      await new Promise(resolve => setImmediate(resolve))
      await crashed.ctx.tickets.whenIdle(crashed.root.session)
      const after = crashed.view().attempts[0]
      // In-process producers end with their host; an activation-bearing attempt past its workspace stage needs host settlement.
      const recoverable = scenario.executor === 'in-process' || scenario.point === 'admission'
      if (recoverable && !(after?.status === 'settled' && after.outcome === 'cancelled')) violations.push(`crash recovery left ${String(after?.status)}`)
      if (!recoverable && after?.status === 'settled') violations.push('crash recovery settled an attempt whose child may still run')
    }
  } finally {
    gate.resolve(undefined)
    vi.useRealTimers()
  }
  expect(violations).toEqual([])
}, 60_000)
