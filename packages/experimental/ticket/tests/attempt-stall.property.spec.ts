/** Model-based test: a storage stall at any attempt write, combined with each way a caller stops waiting for it. */
import { setTimeout as delay } from 'node:timers/promises'
import fc from 'fast-check'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TicketExecutionService, TicketOperationId, type TicketId } from '../src/index.ts'
import { assigned, code, competing, harness, live, request } from './review-r5-harness.ts'

const SETTLEMENT_TIMEOUT_MS = 100
/** Far above the configured bound: a wait that the stall holds never settles within it. */
const BOUND_MS = 3_000

/** The write the root's storage holds. */
type Point = 'admission' | 'workspace' | 'runtime' | 'settlement' | 'uncertainty'
/** How the caller stops waiting: an abort of the `prepare` signal, disposal of the owning worker, execution-service
 * teardown, or the deadline of `settle()` / `dispose()` on a published handle. */
type Trigger = 'abort' | 'owner' | 'teardown' | 'settle' | 'dispose' | 'none'
interface Case {
  readonly point: Point
  readonly trigger: Trigger
  /** For a held settlement write: the earlier write during which the trigger fires; that write is not held. */
  readonly triggerAt?: 'admission' | 'workspace' | 'runtime'
  /** Request the stop a second time while the first is still held. */
  readonly repeat: boolean
}

/** Outcome of an admission attempt: `admitted` after an immediate disposal, otherwise the refusal code. */
async function admit(ctx: Context, caller: Agent, root: Agent, ticketId: TicketId, suffix: string): Promise<string> {
  const current = ctx.tickets.get(root.session, ticketId)
  return ctx.ticketExecution.prepare(caller, request(root, current, suffix)).then(async (handle) => {
    await handle.dispose()
    return 'admitted'
  }, code)
}

/** Whether another attempt can start against the reservation the stalled attempt holds. An isolated worktree reserves no
 * shared-workspace scope, so an uncertain attempt is probed through its assignment's execution reservation instead. The
 * probe's caller is the live root: the owning worker may already be disposed, and a disposed caller is refused with
 * `TICKET_AUTHORITY` before any reservation is read. */
async function reserved(ctx: Context, scenario: Case, root: Agent, ticketId: TicketId, suffix: string): Promise<string> {
  if (scenario.point !== 'uncertainty') return competing(ctx, suffix)
  return admit(ctx, root, root, ticketId, suffix)
}

/** The reservation-specific refusal that an unsettled uncertain attempt produces for a live caller. */
const RESERVED = 'TICKET_ATTEMPT_STATE'

const settles = async (promise: Promise<unknown>): Promise<boolean> =>
  Promise.race([promise.then(() => true, () => true), delay(BOUND_MS).then(() => false)])

async function run(scenario: Case, serial: number): Promise<string[]> {
  const violations: string[] = []
  const { ctx, execution } = await harness(undefined, SETTLEMENT_TIMEOUT_MS)
  const suffix = `stall-${String(serial)}`
  const { agent: root } = await live(ctx, `${suffix}-root`)
  const worker = await live(ctx, `${suffix}-worker`)
  const ticket = await assigned(ctx, root, worker.agent)
  const abort = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  const written = Promise.withResolvers<undefined>()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let teardown: Promise<unknown> | undefined
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    if (scenario.trigger === 'abort') abort.abort(new Error('caller cancelled preparation'))
    else if (scenario.trigger === 'owner') worker.close()
    else if (scenario.trigger === 'teardown') teardown = execution.dispose()
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
    written.resolve(undefined)
    return flushed
  })
  const published = scenario.trigger === 'settle' || scenario.trigger === 'dispose'
  const preparation = ctx.ticketExecution.prepare(worker.agent, {
    ...request(root, ticket, suffix),
    ...published ? {} : { signal: abort.signal },
    ...scenario.point === 'uncertainty' ? { workspace: { kind: 'isolated-worktree', directory: '/review/shared' } as const } : {},
  })
  const outcome = preparation.then(() => 'published', code)
  const stops: Promise<unknown>[] = []
  try {
    if (published) {
      const handle = await preparation
      const stop = () => scenario.trigger === 'settle' ? handle.settle() : handle.dispose()
      stops.push(stop())
      await entered.promise
      if (scenario.repeat) stops.push(stop())
    } else {
      await entered.promise
      fire()
      if (scenario.repeat && scenario.trigger === 'abort') abort.abort(new Error('aborted again'))
      if (!await settles(preparation)) violations.push(`prepare did not settle while the ${scenario.point} write was held`)
      else {
        const result = await outcome
        if (result === 'published') violations.push('a stopped preparation published a handle')
        else if (!result.includes('TICKET_SETTLEMENT_PENDING')) violations.push(`prepare did not report the held write: ${result}`)
      }
    }
    for (const [index, stop] of stops.entries()) {
      if (!await settles(stop)) violations.push(`stop ${String(index)} did not settle while the settlement write was held`)
      else if (await stop.then(() => 'settled', code) !== 'TICKET_SETTLEMENT_PENDING') violations.push(`stop ${String(index)} claimed a held write`)
    }
    if (teardown !== undefined && !await settles(teardown)) violations.push(`teardown did not settle while the ${scenario.point} write was held`)
    if (teardown !== undefined) await ctx.plugin(TicketExecutionService, { settlementTimeoutMs: SETTLEMENT_TIMEOUT_MS })
    const whileHeld = await reserved(ctx, scenario, root, ticket.id, `${suffix}-held`)
    if (whileHeld === 'admitted') violations.push(`a conflicting attempt was admitted while the ${scenario.point} write was held`)
    else if (scenario.point === 'uncertainty' && whileHeld !== RESERVED) violations.push(`the held uncertainty write was not refused by its reservation: ${whileHeld}`)
    const held = stageOf()
    if (scenario.point !== 'settlement' && held === 'settlement') violations.push('the attempt settled before its held write completed')
  } finally {
    gate.resolve(undefined)
  }
  await written.promise
  await outcome
  await ctx.tickets.whenIdle(root.session)
  const attempt = ctx.tickets.get(root.session, ticket.id).attempts[0]
  const expected = scenario.point === 'uncertainty' ? 'unknown' : scenario.trigger === 'settle' ? 'succeeded' : 'cancelled'
  const actual = attempt?.status === 'settled' ? attempt.outcome : attempt?.status
  if (actual !== expected) violations.push(`the attempt ended ${String(actual)}, not ${expected}`)
  const afterRelease = await reserved(ctx, scenario, root, ticket.id, `${suffix}-after`)
  // An unknown attempt keeps its reservation until a host settles it.
  if ((afterRelease === 'admitted') !== (expected !== 'unknown')) violations.push(`after the write completed, a conflicting attempt got ${afterRelease}`)
  else if (expected === 'unknown') {
    if (afterRelease !== RESERVED) violations.push(`the unknown attempt was not refused by its reservation after the write completed: ${afterRelease}`)
    const current = ctx.tickets.get(root.session, ticket.id)
    await ctx.agents.withInitiator(root, () => ctx.tickets.settleAttempt(root.session, {
      ticketId: ticket.id, assignmentId: current.assignments[0]!.id, attemptId: current.attempts[0]!.id,
      expectedRevision: current.revision, actorId: root.id, operationId: TicketOperationId(`${suffix}-host-settled`), outcome: 'cancelled',
    }))
    // A disposed owner is replaced by a live worker with the same identity before admission is retried.
    const owner = scenario.trigger === 'owner' ? (await live(ctx, worker.agent.id)).agent : worker.agent
    const afterSettlement = await admit(ctx, owner, root, ticket.id, `${suffix}-settled`)
    if (afterSettlement !== 'admitted') violations.push(`after host settlement, admission got ${afterSettlement}`)
  }
  await ctx.fiber.dispose()
  return violations
}

const point = fc.constantFrom<Point>('admission', 'workspace', 'runtime', 'settlement', 'uncertainty')
const scenario: fc.Arbitrary<Case> = point.chain((held): fc.Arbitrary<Case> => {
  const repeat = fc.boolean()
  if (held === 'settlement') {
    return fc.oneof(
      fc.record({ point: fc.constant(held), trigger: fc.constantFrom<Trigger>('settle', 'dispose'), repeat }),
      fc.record({ point: fc.constant(held), trigger: fc.constantFrom<Trigger>('abort', 'owner', 'teardown'),
        triggerAt: fc.constantFrom('admission', 'workspace', 'runtime'), repeat }),
    )
  }
  const triggers: Trigger[] = held === 'uncertainty' ? ['none', 'abort', 'owner', 'teardown'] : ['abort', 'owner', 'teardown']
  return fc.record({ point: fc.constant(held), trigger: fc.constantFrom(...triggers), repeat })
})

/** The interleavings of review rounds 10, 12 and 13. */
const examples: [Case][] = [
  [{ point: 'settlement', trigger: 'dispose', repeat: false }],
  [{ point: 'settlement', trigger: 'settle', repeat: true }],
  [{ point: 'settlement', trigger: 'abort', triggerAt: 'runtime', repeat: false }],
  [{ point: 'uncertainty', trigger: 'none', repeat: false }],
  [{ point: 'admission', trigger: 'abort', repeat: false }],
  [{ point: 'workspace', trigger: 'abort', repeat: false }],
  [{ point: 'runtime', trigger: 'abort', repeat: false }],
  [{ point: 'admission', trigger: 'owner', repeat: false }],
  [{ point: 'runtime', trigger: 'teardown', repeat: false }],
]

it('every caller-facing wait settles within its bound while a write is held, and the held write completes the attempt', async () => {
  let serial = 0
  await fc.assert(fc.asyncProperty(scenario, async (generated) => {
    const violations = await run(generated, serial++)
    expect(violations).toEqual([])
  }), { examples, numRuns: 20, endOnFailure: true })
}, 600_000)
