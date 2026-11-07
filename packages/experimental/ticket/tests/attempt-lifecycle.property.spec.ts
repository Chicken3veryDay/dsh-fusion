/** Model-based test: generated event sequences over the real Ticket and TicketExecution services. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import fc from 'fast-check'
import { expect, it, vi } from 'vitest'
import { Context, type Fiber, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { type SubagentActivation, SubagentError, type SubagentResult } from '@deepseek-ai/dsh-subagent'
import TicketService, {
  TicketAttemptId, TicketExecutionService, TicketOperationId, ticketProjectionDefinition,
  type PrepareTicketExecutionRequest, type TicketExecutionHandle, type TicketId,
} from '../src/index.ts'

const SLOTS = 2
const TIMEOUT_MS = 20
/** Multi-second bounds: they only elapse when a product call is stuck, so they cost nothing on a passing run. */
const LIVENESS_MS = 10_000
const STOP_BOUND_MS = 5_000
const DIRECTORY = '/property/shared'
const SCOPE = [{ path: 'src/shared.ts', access: 'write', exclusive: true }] as const

type ProducerKind = 'completes' | 'fails' | 'stubborn' | 'throws-once' | 'cancel-fails' | 'disposes-at-start'
type StartOutcome = 'establish' | 'refuse' | 'rollback-fails'
type Action =
  | { readonly kind: 'prepare'; readonly slot: number; readonly dedicated: boolean; readonly signal: boolean; readonly holdAt: number }
  | { readonly kind: 'retry' | 'abort' | 'finish' | 'settle' | 'dispose' | 'fail-ticket' | 'worker-down' | 'worker-up' | 'busy'; readonly slot: number }
  | { readonly kind: 'activation'; readonly slot: number; readonly start: StartOutcome; readonly cleanup: 'clean' | 'fails'; readonly stubborn: boolean }
  | { readonly kind: 'job'; readonly slot: number; readonly producer: ProducerKind }
  | { readonly kind: 'hold-flush'; readonly slot: number; readonly nth: number }
  | { readonly kind: 'fail-flush' | 'pass-flush' | 'root-down' | 'root-up' | 'drop-root'; readonly slot: number }
  | { readonly kind: 'replace' | 'restart' }

interface Live { agent?: Agent; session?: Session; close?: () => void }
/** A worker lives in its own owner scope, so its disposal runs the Jobs owner cleanup that force-fails and drops records. */
interface Worker extends Live { scope?: Fiber; busy?: PromiseWithResolvers<undefined>; busyFor?: Attempt }
interface Producer {
  readonly attempt: Attempt
  readonly done: PromiseWithResolvers<JobOutcome>
  readonly kind: ProducerKind
  /** Ticket invoked the producer's start; a producer it never started is not live. */
  started: boolean
  finished: boolean
  cancels: number
}
/** External child: its own end is `exit`; `cleanup: 'fails'` makes every release report failure, as the real manager memoizes it. */
interface External { readonly exit: PromiseWithResolvers<SubagentResult>; readonly cleanup: 'clean' | 'fails'; exited: boolean }
interface Attempt {
  readonly slot: number
  readonly generation: number
  readonly epoch: number
  readonly request: PrepareTicketExecutionRequest
  readonly caller: Agent
  readonly abort: AbortController
  readonly preparation: Promise<TicketExecutionHandle>
  status: 'pending' | 'published' | 'rejected'
  handle?: TicketExecutionHandle
  error?: unknown
  abortedWhilePending: boolean
  activation?: External
  /** A child whose rollback failed: it runs until the drain or a restart ends it, and Ticket holds no handle to it. */
  orphan?: { finished: boolean }
  start?: PromiseWithResolvers<{ start: StartOutcome; cleanup: 'clean' | 'fails'; stubborn: boolean }>
  /** The provider is waiting for the model's start decision. */
  deciding: boolean
  pendingJobs: number
  stops: number
}
interface Stop { readonly attempt: Attempt; readonly promise: Promise<unknown>; done: boolean }

interface World {
  readonly dir: string
  ctx: Context
  generation: number
  /** Host lifetime; a restart ends every producer and every reservation the old host held. */
  epoch: number
  tickets?: Fiber
  execution?: Fiber
  readonly roots: (Live & { deleted: boolean; path?: string })[]
  readonly workers: Worker[]
  readonly ticketIds: TicketId[]
  readonly flush: Map<string, { mode: 'pass' | 'fail' | 'hold'; nth: number; gate?: PromiseWithResolvers<undefined> }>
  readonly attempts: Attempt[]
  readonly producers: Producer[]
  readonly stops: Stop[]
  readonly disposals: Promise<unknown>[]
  readonly violations: string[]
  readonly settled: Set<string>
  /** Attempt a host caller is settling; its settlement vouches for its producers. */
  hostSettling?: string
  serial: number
  /** Once set, the provider refuses new starts instead of waiting for the model. */
  draining: boolean
}

const FAULTS = new Set(['flush failed', 'provider refused', 'activation cancelled before a child started', 'caller cancelled preparation'])
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
const settleTicks = async (count = 4) => { for (let index = 0; index < count; index++) await tick() }
const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined

class Directories extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  get() { return DIRECTORY }
  async ensure() { return DIRECTORY }
}
class Worktrees extends Service {
  constructor(ctx: Context) { super(ctx, 'worktrees') }
  async create(): Promise<never> { throw new Error('unexpected worktree') }
}

/** Dedicated-process provider whose start waits for the model. An abort rejects it without a child; `rollback-fails` rejects
 * as the real manager does when releasing an unpublished child failed, leaving that child running. The activation follows the
 * published contract: `result` settles after the release attempt, and `dispose()` reports that release, memoized. */
function subagents(world: World) {
  return class Subagents extends Service {
    constructor(ctx: Context) { super(ctx, 'subagents') }
    getProvider() {
      return { name: 'property', execution: { kind: 'dedicated-process' as const }, inheritsParentContext: false,
        capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false } }
    }
    async startActivation(spec: { readonly signal?: AbortSignal; readonly request: { readonly parent: Agent } })
      : Promise<SubagentActivation> {
      const attempt = world.attempts.findLast(item => item.request.rootSessionId === spec.request.parent.id && item.request.executor.kind !== 'in-process')
      if (attempt === undefined) throw new Error('activation without a preparing attempt')
      if (world.draining) throw new Error('provider refused')
      const decision = Promise.withResolvers<{ start: StartOutcome; cleanup: 'clean' | 'fails'; stubborn: boolean }>()
      attempt.start = decision
      attempt.deciding = true
      void decision.promise.then(() => { attempt.deciding = false }, () => { attempt.deciding = false })
      spec.signal?.addEventListener('abort', () => { decision.reject(new Error('activation cancelled before a child started')) }, { once: true })
      const chosen = await decision.promise
      if (chosen.start === 'refuse') throw new Error('provider refused')
      if (chosen.start === 'rollback-fails') {
        attempt.orphan = { finished: false }
        throw new SubagentError('subagent was not admitted and releasing its execution failed', 'ACTIVATION_TEARDOWN_FAILED')
      }
      const external: External = { exit: Promise.withResolvers(), cleanup: chosen.cleanup, exited: false }
      void external.exit.promise.then(() => { external.exited = true })
      attempt.activation = external
      let closing: Promise<void> | undefined
      const close = () => closing ??= external.exit.promise.then(() => {
        if (external.cleanup === 'fails') throw new Error('releasing the external child failed')
      })
      void external.exit.promise.then(() => close()).catch(() => {})
      return {
        childId: SessionId(`child-${String(world.serial++)}`),
        result: external.exit.promise.then(async (result) => { await close().catch(() => {}); return result }),
        dispose: () => {
          if (!chosen.stubborn) external.exit.resolve({ output: [], stopReason: 'aborted' })
          return close()
        },
      }
    }
  }
}

function enter(world: World, ctx: Context, id: string, seed?: Session): Live & { agent: Agent; session: Session } {
  const session = ctx.sessions.prepare(SessionId(id), seed === undefined ? undefined : { seed: seed.snapshotEvents() })
  const detachSession = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const worker = world.workers.find(item => `worker-${String(world.workers.indexOf(item))}` === id)
  const agent: Agent = { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    whenIdle: async () => { await worker?.busy?.promise },
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
  const detachAgent = ctx.agents.enter(agent, undefined)
  void ctx.agents.announce(agent, 'startup')
  return { agent, session, close: () => { detachAgent(); detachSession() } }
}

/** Enter a worker inside its own owner scope. */
async function enterWorker(world: World, slot: number): Promise<void> {
  const worker = world.workers[slot]
  const id = `worker-${String(slot)}`
  if (worker === undefined || worker.agent !== undefined || world.ctx.agents.get(SessionId(id)) !== undefined) return
  const ready = Promise.withResolvers<Context>()
  const scope = world.ctx.plugin({ name: `worker-scope-${String(world.serial++)}`, inject: ['sessions', 'agents'],
    apply(child: Context) { ready.resolve(child) } })
  await scope
  const live = enter(world, await ready.promise, id)
  Object.assign(worker, { agent: live.agent, session: live.session, scope })
  delete worker.close
}

function down(live: Live): void {
  live.close?.()
  delete live.agent
  delete live.close
}

function workerDown(world: World, worker: Worker): void {
  const scope = worker.scope
  delete worker.agent
  delete worker.scope
  if (scope !== undefined) world.disposals.push(scope.dispose().catch(() => {}))
}

async function boot(world: World): Promise<void> {
  const ctx = new Context()
  world.ctx = ctx
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: world.dir, compression: 'none' })
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('ticket-property')
  await ctx.plugin(Directories)
  await ctx.plugin(Worktrees)
  await ctx.plugin(subagents(world))
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
    const control = world.flush.get(session.id)
    if (control?.mode === 'fail') { control.mode = 'pass'; throw new Error('flush failed') }
    if (control?.mode === 'hold' && --control.nth <= 0) {
      control.gate ??= Promise.withResolvers()
      await control.gate.promise
    }
    return await flush(session)
  })
  // No execution-owned settlement may claim producers ended while one still runs or cannot confirm its release.
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'ticket/state' || event.data.version !== 2) return
    for (const snapshot of event.data.ticket.attempts) {
      if (snapshot.status !== 'settled' || world.settled.has(snapshot.id)) continue
      world.settled.add(snapshot.id)
      const attempt = world.attempts.find(item => item.request.attemptId === snapshot.id)
      if (attempt !== undefined && world.hostSettling !== snapshot.id && (liveProducer(world, attempt) || unreleasable(attempt))) {
        world.violations.push(`${snapshot.id} settled while its producer still runs or cannot confirm its release`)
      }
    }
  })
  await mount(world)
}

async function mount(world: World): Promise<void> {
  world.tickets = await world.ctx.plugin(TicketService, {})
  world.execution = await world.ctx.plugin(TicketExecutionService, { settlementTimeoutMs: TIMEOUT_MS })
  world.generation++
}

async function setup(dir: string): Promise<World> {
  const world: World = { dir, ctx: new Context(), generation: 0, epoch: 0, roots: [], workers: [], ticketIds: [], flush: new Map(),
    attempts: [], producers: [], stops: [], disposals: [], violations: [], settled: new Set(), serial: 0, draining: false }
  await boot(world)
  for (let slot = 0; slot < SLOTS; slot++) {
    const root = enter(world, world.ctx, `root-${String(slot)}`)
    world.workers.push({})
    await enterWorker(world, slot)
    const worker = world.workers[slot]!.agent!
    // A stored log makes the root visible to the stored-reservation scan, so deleting it is observable.
    await using writer = await world.ctx.sessionPersistence.create(root.session.header)
    await writer.append(root.session.snapshotEvents())
    const ticket = await world.ctx.agents.withInitiator(root.agent, () => world.ctx.tickets.create(root.session, { subject: 'Property', description: '' }))
    const assigned = await world.ctx.agents.withInitiator(root.agent, () => world.ctx.tickets.assign(root.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.agent.id, ownerId: worker.id, subject: 'Write', workScopes: [...SCOPE],
    }))
    const stat = await world.ctx.sessionPersistence.stat(root.agent.id)
    world.roots.push({ ...root, deleted: false, ...stat?.location?.kind === 'jsonl' ? { path: stat.location.path } : {} })
    world.ticketIds.push(assigned.id)
    world.flush.set(root.session.id, { mode: 'pass', nth: 0 })
  }
  return world
}

/** The attempt an action on `slot` addresses: the newest one the action can act on, else the newest one. */
function target(world: World, action: Action): Attempt | undefined {
  if (!('slot' in action)) return undefined
  const mine = world.attempts.filter(attempt => attempt.slot === action.slot)
  const fit = (attempt: Attempt): boolean => {
    switch (action.kind) {
      case 'job': case 'settle': case 'dispose': return attempt.handle !== undefined && attempt.generation === world.generation
      case 'abort': return attempt.status === 'pending' && attempt.request.signal !== undefined
      case 'activation': return attempt.deciding
      case 'busy': return attempt.handle !== undefined && attempt.request.executor.kind === 'in-process' && attempt.stops === 0
      default: return true
    }
  }
  return action.kind === 'busy' ? mine.findLast(fit) : mine.findLast(fit) ?? mine.at(-1)
}

/** Some root's flush is held by the model. */
function held(world: World): boolean {
  return [...world.flush.values()].some(control => control.gate !== undefined)
}

/** Wait until an operation an action started has settled or blocks on a gate the model holds, so that the next action meets
 * the same state on every run. A wait that exhausts its bound is left to the liveness checks. */
async function until(world: World, settled: () => boolean): Promise<void> {
  for (let waited = 0; waited < LIVENESS_MS && !settled() && !held(world); waited++) await delay(1)
}

/** A producer of `attempt` that has not ended. */
function liveProducer(world: World, attempt: Attempt): boolean {
  return world.producers.some(producer => producer.attempt === attempt && producer.started && !producer.finished)
    || (attempt.activation !== undefined && !attempt.activation.exited)
    || (attempt.orphan !== undefined && !attempt.orphan.finished)
    || world.workers.some(worker => worker.busyFor === attempt && worker.busy !== undefined)
}

/** Ticket cannot confirm this attempt's producers released their resources. */
function unreleasable(attempt: Attempt): boolean {
  return attempt.activation?.cleanup === 'fails' || attempt.orphan !== undefined
}

/** Another attempt still runs a producer, or its producers never confirmed their release and no host settled it yet. */
function liveProducerElsewhere(world: World, attempt: Attempt): boolean {
  return world.attempts.some(other => other !== attempt && (liveProducer(world, other)
    || (unreleasable(other) && other.epoch === world.epoch && !world.settled.has(other.request.attemptId))))
}

function prepare(world: World, slot: number, dedicated: boolean, signal: boolean): Attempt | undefined {
  const root = world.roots[slot]
  const worker = world.workers[slot]
  const caller = dedicated ? root?.agent : worker?.agent
  const ticketId = world.ticketIds[slot]
  if (root?.session === undefined || root.agent === undefined || caller === undefined || ticketId === undefined) return undefined
  let ticket
  try { ticket = world.ctx.tickets.get(root.session, ticketId) } catch { return undefined }
  const assignment = ticket.assignments[0]
  if (assignment === undefined) return undefined
  const id = `${String(world.generation)}-${String(world.serial++)}`
  const abort = new AbortController()
  const request: PrepareTicketExecutionRequest = {
    rootSessionId: root.session.id, ticketId, assignmentId: assignment.id, expectedRevision: ticket.revision,
    attemptId: TicketAttemptId(`attempt-${id}`), operationId: TicketOperationId(`prepare-${id}`),
    workspace: { kind: 'shared-workspace', directory: DIRECTORY, baseCommit: 'a'.repeat(40) },
    executor: dedicated ? { kind: 'dedicated-process', provider: 'property' } : { kind: 'in-process' },
    ...signal ? { signal: abort.signal } : {},
  }
  const preparation = world.ctx.ticketExecution.prepare(caller, request)
  const attempt: Attempt = { slot, generation: world.generation, epoch: world.epoch, request, caller, abort, preparation,
    status: 'pending', abortedWhilePending: false, deciding: false, pendingJobs: 0, stops: 0 }
  world.attempts.push(attempt)
  void preparation.then((handle) => {
    attempt.status = 'published'
    attempt.handle = handle
    if (attempt.abortedWhilePending) world.violations.push(`${request.attemptId} published after its prepare signal aborted`)
    if (liveProducerElsewhere(world, attempt)) world.violations.push(`${request.attemptId} was admitted while a conflicting producer still runs`)
  }, (error: unknown) => {
    attempt.status = 'rejected'
    attempt.error = error
  })
  return attempt
}

function startJob(world: World, attempt: Attempt, kind: ProducerKind): void {
  const handle = attempt.handle
  if (handle === undefined) return
  const done = Promise.withResolvers<JobOutcome>()
  const producer: Producer = { attempt, done, kind, started: false, finished: false, cancels: 0 }
  void done.promise.then(() => { producer.finished = true })
  world.producers.push(producer)
  attempt.pendingJobs++
  handle.startJob('property', () => {
    producer.started = true
    // Startup asks to stop the attempt before it returns the hooks that could deliver that request.
    if (kind === 'disposes-at-start') recordStop(world, attempt, handle.dispose())
    return {
      cancel() {
        producer.cancels++
        if (kind === 'stubborn') return
        if (kind === 'cancel-fails') throw new Error('cancellation failed while the producer kept running')
        if ((kind === 'throws-once' || kind === 'disposes-at-start') && producer.cancels === 1) throw new Error('transient cancellation failure')
        done.resolve({ status: 'killed' })
      },
      done: done.promise,
    }
  }).catch(() => {
    if (!producer.started) done.resolve({ status: 'failed' })
  }).finally(() => {
    attempt.pendingJobs--
    // Ticket never starts a producer whose stop began while its receipt was being written.
    if (!producer.started) done.resolve({ status: 'killed' })
  })
}

function recordStop(world: World, attempt: Attempt, operation: Promise<unknown> | undefined): void {
  if (operation === undefined) return
  attempt.stops++
  const stop: Stop = { attempt, promise: operation.then(() => {}, () => {}), done: false }
  void stop.promise.then(() => { stop.done = true })
  world.stops.push(stop)
}

function finish(world: World, attempt: Attempt | undefined): void {
  for (const producer of world.producers) {
    if (attempt === undefined || producer.attempt === attempt) producer.done.resolve({ status: producer.kind === 'fails' ? 'failed' : 'completed' })
  }
  for (const candidate of world.attempts) {
    if (attempt !== undefined && candidate !== attempt) continue
    candidate.activation?.exit.resolve({ output: [], stopReason: 'completed' })
    if (candidate.orphan !== undefined) candidate.orphan.finished = true
  }
  for (const worker of world.workers) {
    if (attempt !== undefined && worker.busyFor !== attempt) continue
    worker.busy?.resolve(undefined)
    delete worker.busy
    delete worker.busyFor
  }
}

/** A stop must return within its deadline while a flush is held whenever its attempt still has a producer or a pending Job
 * admission; only a stop that handed its outcome to the ledger may wait for that ledger's write. */
async function boundedStops(world: World): Promise<void> {
  if (![...world.flush.values()].some(control => control.gate !== undefined)) return
  for (const stop of world.stops) {
    if (stop.done || (!liveProducer(world, stop.attempt) && stop.attempt.pendingJobs === 0)) continue
    await Promise.race([stop.promise, delay(STOP_BOUND_MS)])
    if (!stop.done) world.violations.push(`${stop.attempt.request.attemptId} stop did not return within its deadline while a flush was held`)
  }
}

async function setFlush(world: World, slot: number, mode: 'pass' | 'fail' | 'hold', nth = 0): Promise<void> {
  const id = world.roots[slot]?.session?.id
  const control = id === undefined ? undefined : world.flush.get(id)
  if (control === undefined) return
  if (mode !== 'hold') {
    await boundedStops(world)
    control.gate?.resolve(undefined)
    delete control.gate
  }
  control.mode = mode
  control.nth = nth
}

async function releaseFlushes(world: World): Promise<void> {
  await boundedStops(world)
  for (const control of world.flush.values()) { control.gate?.resolve(undefined); delete control.gate; control.mode = 'pass' }
}

function rootUp(world: World, slot: number): void {
  const root = world.roots[slot]
  if (root === undefined || root.agent !== undefined || root.deleted || root.session === undefined) return
  Object.assign(root, enter(world, world.ctx, `root-${String(slot)}`, root.session))
}

/** The host exits: every producer it ran ends. */
function exitHost(world: World): void {
  for (const producer of world.producers) producer.done.resolve({ status: 'killed' })
  for (const attempt of world.attempts) {
    attempt.activation?.exit.resolve({ output: [], stopReason: 'aborted' })
    if (attempt.orphan !== undefined) attempt.orphan.finished = true
  }
  for (const worker of world.workers) { worker.busy?.resolve(undefined); delete worker.busy; delete worker.busyFor }
}

async function act(world: World, action: Action): Promise<void> {
  const attempt = target(world, action)
  switch (action.kind) {
    case 'prepare':
      // Holding the nth flush of this preparation's root reaches the admission, workspace or runtime write.
      if (action.holdAt > 0) await setFlush(world, action.slot, 'hold', action.holdAt)
      await awaitPreparation(world, prepare(world, action.slot, action.dedicated, action.signal))
      break
    case 'retry':
      if (attempt !== undefined && attempt.caller === world.ctx.agents.get(attempt.caller.id)) {
        const before = attempt.status
        let retried = false
        void world.ctx.ticketExecution.prepare(attempt.caller, attempt.request).finally(() => { retried = true }).then((handle) => {
          if (before === 'published' && handle !== attempt.handle) world.violations.push(`${attempt.request.attemptId} retry published a second handle`)
        }, (error: unknown) => {
          if (codeOf(error) === undefined && error !== attempt.error && !(error instanceof AggregateError)
            && !(error instanceof Error && FAULTS.has(error.message))) {
            world.violations.push(`${attempt.request.attemptId} retry rejected with an untyped error: ${String(error)}`)
          }
        })
        await until(world, () => retried || attempt.deciding)
      }
      break
    case 'abort':
      if (attempt !== undefined && !attempt.abort.signal.aborted) {
        if (attempt.status === 'pending' && attempt.request.signal !== undefined) attempt.abortedWhilePending = true
        attempt.abort.abort(new Error('caller cancelled preparation'))
      }
      break
    case 'activation':
      attempt?.start?.resolve({ start: action.start, cleanup: action.cleanup, stubborn: action.stubborn })
      await awaitPreparation(world, attempt)
      break
    case 'job':
      if (attempt !== undefined && attempt.generation === world.generation) {
        startJob(world, attempt, action.producer)
        await until(world, () => attempt.pendingJobs === 0)
      }
      break
    case 'busy': {
      const worker = world.workers[action.slot]
      if (attempt !== undefined && worker !== undefined && worker.busy === undefined && attempt.status === 'published') {
        worker.busy = Promise.withResolvers()
        worker.busyFor = attempt
      }
      break
    }
    case 'finish': finish(world, attempt); break
    case 'settle': if (attempt !== undefined) recordStop(world, attempt, attempt.handle?.settle()); break
    case 'dispose': if (attempt !== undefined) recordStop(world, attempt, attempt.handle?.dispose()); break
    case 'fail-ticket': {
      const root = world.roots[action.slot]
      const ticketId = world.ticketIds[action.slot]
      if (root?.agent === undefined || root.session === undefined || ticketId === undefined) break
      const session = root.session
      const agent = root.agent
      try {
        const ticket = world.ctx.tickets.get(session, ticketId)
        let failed = false
        void world.ctx.agents.withInitiator(agent, () => world.ctx.tickets.fail(session, {
          ticketId, expectedRevision: ticket.revision, actorId: agent.id, summary: 'Stopped by the model' })).catch(() => {})
          .finally(() => { failed = true })
        await until(world, () => failed)
      } catch { /* A Ticket that cannot be read cannot be failed. */ }
      break
    }
    case 'worker-down': { const worker = world.workers[action.slot]; if (worker !== undefined) workerDown(world, worker); break }
    case 'worker-up': await enterWorker(world, action.slot); break
    case 'hold-flush': await setFlush(world, action.slot, 'hold', action.nth); break
    case 'fail-flush': await setFlush(world, action.slot, 'fail'); break
    case 'pass-flush': await setFlush(world, action.slot, 'pass'); break
    case 'root-down': { const root = world.roots[action.slot]; if (root !== undefined) down(root); break }
    case 'root-up': rootUp(world, action.slot); break
    case 'drop-root': {
      const root = world.roots[action.slot]
      if (root === undefined || root.deleted || root.path === undefined) break
      down(root)
      root.deleted = true
      await rm(root.path, { force: true })
      break
    }
    case 'replace':
      // Teardown awaits in-flight writes, so a delayed flush completes first.
      await releaseFlushes(world)
      // A teardown whose stop timed out rejects; Cordis contains it and replacement continues.
      await world.execution?.dispose().catch(() => {})
      await world.tickets?.dispose().catch(() => {})
      await mount(world)
      break
    case 'restart': {
      await releaseFlushes(world)
      const disposal = world.ctx.fiber.dispose()
      exitHost(world)
      await disposal
      await Promise.allSettled(world.disposals.splice(0))
      for (const live of [...world.roots, ...world.workers]) { delete live.agent; delete live.close }
      for (const worker of world.workers) delete worker.scope
      world.epoch++
      await boot(world)
      for (let slot = 0; slot < SLOTS; slot++) await enterWorker(world, slot)
      break
    }
    default: action satisfies never
  }
  await settleTicks()
}

/** Wait for a preparation to publish, reject, or wait for the model's activation decision or a held flush. */
async function awaitPreparation(world: World, attempt: Attempt | undefined): Promise<void> {
  if (attempt !== undefined) await until(world, () => attempt.status !== 'pending' || attempt.deciding)
}

/** Await one product call; a call that never settles is a liveness violation. */
async function within(world: World, label: string, operation: Promise<unknown> | undefined): Promise<void> {
  if (operation === undefined) return
  const outcome = await Promise.race([operation.then(() => 'done', () => 'done'), delay(LIVENESS_MS).then(() => 'expired')])
  if (outcome === 'expired') world.violations.push(`${label} never settled`)
}

async function quiesce(world: World): Promise<void> {
  for (let waited = 0; waited < LIVENESS_MS && world.attempts.some(attempt => attempt.status === 'pending'); waited += 5) await delay(5)
  await settleTicks()
  const pending = world.attempts.filter(attempt => attempt.status === 'pending').map(attempt => attempt.request.attemptId)
  if (pending.length > 0) world.violations.push(`preparations never settled: ${pending.join(', ')}`)
}

/** Release every gate, finish every producer and resume every root, then retry each owner's stop through product paths. */
async function drain(world: World): Promise<void> {
  world.draining = true
  await releaseFlushes(world)
  for (const attempt of world.attempts) attempt.start?.reject(new Error('provider refused'))
  finish(world, undefined)
  await within(world, 'worker scope disposal', Promise.allSettled(world.disposals.splice(0)))
  for (let slot = 0; slot < SLOTS; slot++) {
    rootUp(world, slot)
    await enterWorker(world, slot)
  }
  await quiesce(world)
  // A caller retries a preparation that failed; an admission whose flush failed continues from the log.
  for (const attempt of world.attempts) {
    if (attempt.generation !== world.generation || attempt.status !== 'rejected' || world.ctx.agents.get(attempt.caller.id) !== attempt.caller) continue
    const { signal: _signal, ...request } = attempt.request
    await within(world, `${attempt.request.attemptId} retry`, world.ctx.ticketExecution.prepare(attempt.caller, request).then((handle) => {
      attempt.handle = handle
      attempt.status = 'published'
    }))
  }
  await quiesce(world)
  for (let round = 0; round < 2; round++) {
    for (const attempt of world.attempts) {
      if (attempt.generation === world.generation) await within(world, `${attempt.request.attemptId} dispose`, attempt.handle?.dispose())
    }
  }
  // A write to each root repeats any settlement flush that failed.
  for (const root of world.roots) {
    const { agent, session } = root
    if (agent === undefined || session === undefined) continue
    await within(world, `${session.id} barrier`, world.ctx.agents.withInitiator(agent, () => world.ctx.tickets.create(session, { subject: 'Barrier', description: '' })))
  }
  // Host reconciliation owns attempts without a live owner in this generation that stopped as unknown or outlived theirs, and
  // attempts whose producers can never confirm their release.
  for (const [slot, root] of world.roots.entries()) {
    const { agent, session } = root
    const ticketId = world.ticketIds[slot]
    if (agent === undefined || session === undefined || ticketId === undefined) continue
    for (const attempt of world.ctx.tickets.get(session, ticketId).attempts) {
      if (attempt.status === 'settled') continue
      const record = world.attempts.find(item => item.request.attemptId === attempt.id)
      const owned = record !== undefined && record.generation === world.generation && record.handle !== undefined
      const abandoned = record !== undefined && unreleasable(record)
      if (!abandoned && (owned || (attempt.status !== 'unknown' && record?.generation === world.generation))) continue
      const current = world.ctx.tickets.get(session, ticketId)
      world.hostSettling = attempt.id
      await world.ctx.agents.withInitiator(agent, () => world.ctx.tickets.settleAttempt(session, {
        ticketId, attemptId: attempt.id, actorId: agent.id, expectedRevision: current.revision,
        operationId: TicketOperationId(`host-${attempt.id}`), outcome: 'cancelled',
      })).catch((error: unknown) => { world.violations.push(`host reconciliation of ${attempt.id} failed: ${String(error)}`) })
      delete world.hostSettling
    }
  }
  await settleTicks()
}

async function check(world: World): Promise<void> {
  for (const [slot, root] of world.roots.entries()) {
    const { agent, session } = root
    const ticketId = world.ticketIds[slot]
    if (agent === undefined || session === undefined || ticketId === undefined) continue
    const ticket = world.ctx.tickets.get(session, ticketId)
    for (const attempt of ticket.attempts) {
      if (attempt.status !== 'settled') world.violations.push(`${attempt.id} is ${attempt.status} after every owner finished`)
    }
    const settlements = new Map<string, number>()
    let state = ticketProjectionDefinition.init(session.header)
    let previous = new Map<string, string>()
    for (const event of session.snapshotEvents()) {
      state = ticketProjectionDefinition.apply(state, event)
      if (event.type !== 'ticket/state') continue
      const next = new Map((state.tickets.find(item => item.id === ticketId)?.attempts ?? []).map(item => [item.id, item.status] as const))
      for (const [id, status] of next) if (status === 'settled' && previous.get(id) !== 'settled') settlements.set(id, (settlements.get(id) ?? 0) + 1)
      previous = next
    }
    for (const attempt of ticket.attempts) {
      if (settlements.get(attempt.id) !== 1) world.violations.push(`${attempt.id} settled ${String(settlements.get(attempt.id) ?? 0)} times`)
    }
    expect(state.failure).toBeUndefined()
    expect(state.tickets).toEqual(world.ctx.tickets.list(session))
    // Retrying a finished owner's stop is idempotent; an attempt whose producers cannot confirm release stays with its host.
    const events = session.snapshotEvents().length
    for (const attempt of world.attempts) {
      if (attempt.slot !== slot || attempt.generation !== world.generation || attempt.handle === undefined) continue
      if (unreleasable(attempt)) continue
      for (const retry of [() => attempt.handle?.dispose(), () => attempt.handle?.settle()]) {
        await retry()?.catch((error: unknown) => { world.violations.push(`${attempt.request.attemptId} stop retry failed: ${String(error)}`) })
      }
      const { signal: _signal, ...request } = attempt.request
      await world.ctx.ticketExecution.prepare(attempt.caller, request).then(
        () => { world.violations.push(`${attempt.request.attemptId} settled preparation published again`) },
        (error: unknown) => { if (codeOf(error) !== 'TICKET_ATTEMPT_STATE') world.violations.push(`${attempt.request.attemptId} retry: ${String(error)}`) })
    }
    if (session.snapshotEvents().length !== events) world.violations.push(`root ${String(slot)} stop retries appended events`)
    // A coordinator ends any nonterminal Ticket once its attempts are settled.
    const current = world.ctx.tickets.get(session, ticketId)
    if (current.terminalOutcome === undefined) {
      await world.ctx.agents.withInitiator(agent, () => world.ctx.tickets.fail(session, {
        ticketId, expectedRevision: current.revision, actorId: agent.id, summary: 'Ended after the run' }))
        .catch((error: unknown) => { world.violations.push(`ticket ${String(slot)} cannot fail from ${current.status}: ${String(codeOf(error))}`) })
    }
  }
  // Reservations balance: the exclusive scope admits fresh work, unless a producer that cannot confirm its release belongs to a
  // deleted root in this host lifetime, which no host can settle until the host exits.
  const held = world.attempts.some(attempt =>
    unreleasable(attempt) && attempt.epoch === world.epoch && world.roots[attempt.slot]?.deleted === true)
  const root = enter(world, world.ctx, `competing-root-${String(world.serial)}`)
  const worker = enter(world, world.ctx, `competing-worker-${String(world.serial++)}`)
  const ticket = await world.ctx.agents.withInitiator(root.agent, () => world.ctx.tickets.create(root.session, { subject: 'Competing', description: '' }))
  const assigned = await world.ctx.agents.withInitiator(root.agent, () => world.ctx.tickets.assign(root.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.agent.id, ownerId: worker.agent.id, subject: 'Write', workScopes: [...SCOPE] }))
  const admission = await world.ctx.ticketExecution.prepare(worker.agent, {
    rootSessionId: root.session.id, ticketId: ticket.id, assignmentId: assigned.assignments[0]?.id ?? ticket.assignments[0]!.id,
    expectedRevision: assigned.revision, attemptId: TicketAttemptId('attempt-competing'), operationId: TicketOperationId('prepare-competing'),
    workspace: { kind: 'shared-workspace', directory: DIRECTORY, baseCommit: 'a'.repeat(40) }, executor: { kind: 'in-process' },
  }).then(async (handle) => { await handle.dispose(); return 'admitted' }, (error: unknown) => String(codeOf(error) ?? error))
  if (held && admission !== 'TICKET_ATTEMPT_STATE') world.violations.push(`an unreleasable producer of a deleted root lost its reservation: ${admission}`)
  if (!held && admission !== 'admitted') world.violations.push(`the exclusive scope stays reserved: ${admission}`)
}

const slot = fc.integer({ min: 0, max: SLOTS - 1 })
const on = <K extends Action['kind']>(kind: K, weight: number) =>
  ({ weight, arbitrary: fc.record({ kind: fc.constant(kind), slot }) })
/** Weights favour the actions that reach owner, flush and replacement interleavings within a short sequence. */
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 7, arbitrary: fc.record({ kind: fc.constant('prepare' as const), slot, dedicated: fc.boolean(), signal: fc.boolean(),
    holdAt: fc.integer({ min: 0, max: 3 }) }) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('job' as const), slot,
    producer: fc.constantFrom<ProducerKind>('completes', 'fails', 'stubborn', 'stubborn', 'throws-once', 'throws-once', 'cancel-fails',
      'disposes-at-start') }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('activation' as const), slot,
    start: fc.constantFrom<StartOutcome>('establish', 'establish', 'refuse', 'rollback-fails'),
    cleanup: fc.constantFrom<'clean' | 'fails'>('clean', 'clean', 'fails'), stubborn: fc.boolean() }) },
  on('abort', 4), on('dispose', 4), on('settle', 2), on('finish', 2), on('retry', 2), on('fail-ticket', 1), on('busy', 2),
  on('worker-down', 2), on('worker-up', 1), on('root-down', 3), on('root-up', 2), on('drop-root', 2),
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('hold-flush' as const), slot, nth: fc.integer({ min: 1, max: 3 }) }) },
  on('fail-flush', 2), on('pass-flush', 2),
  { weight: 3, arbitrary: fc.constant({ kind: 'replace' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'restart' as const }) },
)

const inProcess = (slot: number, signal = false, holdAt = 0): Action => ({ kind: 'prepare', slot, dedicated: false, signal, holdAt })
const dedicated = (slot: number): Action => ({ kind: 'prepare', slot, dedicated: true, signal: false, holdAt: 0 })
const activation = (slot: number, start: StartOutcome, cleanup: 'clean' | 'fails' = 'clean', stubborn = false): Action =>
  ({ kind: 'activation', slot, start, cleanup, stubborn })
/** Round-6 and round-7 interleavings, replayed before the generated sequences. */
const regressions: Action[][] = [
  [inProcess(0, true, 3), { kind: 'abort', slot: 0 }],
  [inProcess(0), { kind: 'job', slot: 0, producer: 'throws-once' }, { kind: 'dispose', slot: 0 }],
  [inProcess(0), { kind: 'job', slot: 0, producer: 'fails' }, { kind: 'finish', slot: 0 }, { kind: 'settle', slot: 0 }],
  [dedicated(0), { kind: 'root-down', slot: 0 }],
  [inProcess(0), { kind: 'job', slot: 0, producer: 'stubborn' }, { kind: 'drop-root', slot: 0 }, { kind: 'replace' }, inProcess(1)],
  // R7-1: a Job admission whose receipt flush is held, then a stop.
  [inProcess(0), { kind: 'hold-flush', slot: 0, nth: 1 }, { kind: 'job', slot: 0, producer: 'completes' }, { kind: 'dispose', slot: 0 },
    { kind: 'pass-flush', slot: 0 }],
  // R7-1b: a stop whose deadline expires while its uncertainty write is held.
  [inProcess(0), { kind: 'busy', slot: 0 }, { kind: 'hold-flush', slot: 0, nth: 1 }, { kind: 'dispose', slot: 0 }, { kind: 'pass-flush', slot: 0 }],
  // R7-2: replacement while a producer without a visible Job still runs: a busy worker, then a stubborn activation.
  [inProcess(0), { kind: 'busy', slot: 0 }, { kind: 'drop-root', slot: 0 }, { kind: 'replace' }, inProcess(1)],
  [dedicated(0), activation(0, 'establish', 'clean', true), { kind: 'drop-root', slot: 0 }, { kind: 'replace' }, inProcess(1)],
  // R7-2: a Job whose record the owner's cleanup force-failed and removed while its producer runs, then a replacement.
  [inProcess(0), { kind: 'job', slot: 0, producer: 'cancel-fails' }, { kind: 'worker-down', slot: 0 }, { kind: 'drop-root', slot: 0 },
    inProcess(1)],
  [inProcess(0), { kind: 'job', slot: 0, producer: 'cancel-fails' }, { kind: 'worker-down', slot: 0 }, { kind: 'drop-root', slot: 0 },
    { kind: 'replace' }, inProcess(1)],
  // R7-3: Job startup requests a stop before returning its hooks, whose cancel then throws.
  [inProcess(0), { kind: 'job', slot: 0, producer: 'disposes-at-start' }],
  // R7-4: a Subagent start rejected after its rollback failed.
  [dedicated(0), activation(0, 'rollback-fails')],
  // R7-5: a captured result whose release then fails, then a competing admission.
  [dedicated(0), activation(0, 'establish', 'fails'), { kind: 'finish', slot: 0 }, { kind: 'settle', slot: 0 }, inProcess(1)],
  [dedicated(0), activation(0, 'establish', 'fails'), { kind: 'finish', slot: 0 }, { kind: 'settle', slot: 0 }, { kind: 'drop-root', slot: 0 },
    { kind: 'replace' }, inProcess(1)],
]

/* TICKET_PROPERTY_SEED, TICKET_PROPERTY_RUNS and TICKET_PROPERTY_NO_EXAMPLES vary the seed, the run count and the regression
 * replay when investigating; TICKET_PROPERTY_TRACE prints the duration of each step. fast-check prints the seed and the failing
 * sequence on failure. */
it('every generated event sequence ends each attempt once, balances reservations, and replays to the live state', async () => {
  const seed = Number(process.env.TICKET_PROPERTY_SEED ?? 20261106)
  await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 20 }), async (actions) => {
    const dir = await mkdtemp(join(tmpdir(), 'ticket-property-'))
    let world: World | undefined
    try {
      const trace = process.env.TICKET_PROPERTY_TRACE === undefined ? undefined : (label: string, started: number) => {
        process.stderr.write(`${label} ${String(Date.now() - started)}ms\n`)
      }
      let started = Date.now()
      world = await setup(dir)
      trace?.('setup', started)
      for (const step of actions) {
        started = Date.now()
        await act(world, step)
        trace?.(JSON.stringify(step), started)
      }
      started = Date.now()
      await drain(world)
      trace?.('drain', started)
      started = Date.now()
      await check(world)
      trace?.('check', started)
      expect(world.violations).toEqual([])
    } finally {
      vi.restoreAllMocks()
      if (world !== undefined) {
        exitHost(world)
        for (const control of world.flush.values()) control.gate?.resolve(undefined)
        await world.ctx.fiber.dispose()
      }
      await rm(dir, { recursive: true, force: true })
    }
  }), {
    seed, numRuns: Number(process.env.TICKET_PROPERTY_RUNS ?? 200), endOnFailure: true,
    ...process.env.TICKET_PROPERTY_NO_EXAMPLES === undefined ? { examples: regressions.map(actions => [actions]) } : {},
  })
}, 600_000)
