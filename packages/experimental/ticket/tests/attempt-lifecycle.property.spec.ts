/** Model-based test: generated event sequences over the real Ticket and TicketExecution services. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import TicketService, {
  TicketAttemptId, TicketExecutionService, TicketOperationId, ticketProjectionDefinition,
  type PrepareTicketExecutionRequest, type TicketExecutionHandle, type TicketId,
} from '../src/index.ts'

const SLOTS = 2
const TIMEOUT_MS = 20
const DIRECTORY = '/property/shared'
const SCOPE = [{ path: 'src/shared.ts', access: 'write', exclusive: true }] as const

type ProducerKind = 'completes' | 'fails' | 'stubborn' | 'throws-once'
type Action =
  | { readonly kind: 'prepare'; readonly slot: number; readonly dedicated: boolean; readonly signal: boolean }
  | { readonly kind: 'retry' | 'abort' | 'finish' | 'settle' | 'dispose' | 'fail-ticket' | 'worker-down' | 'worker-up'; readonly slot: number }
  | { readonly kind: 'activation'; readonly slot: number; readonly establish: boolean }
  | { readonly kind: 'job'; readonly slot: number; readonly producer: ProducerKind }
  | { readonly kind: 'hold-flush'; readonly slot: number; readonly nth: number }
  | { readonly kind: 'fail-flush' | 'pass-flush' | 'root-down' | 'root-up' | 'drop-root'; readonly slot: number }
  | { readonly kind: 'replace' | 'restart' }

interface Live { agent?: Agent; session?: Session; close?: () => void }
interface Producer {
  readonly attempt: Attempt
  readonly done: PromiseWithResolvers<JobOutcome>
  readonly kind: ProducerKind
  finished: boolean
  cancels: number
}
interface Attempt {
  readonly slot: number
  readonly generation: number
  readonly request: PrepareTicketExecutionRequest
  readonly caller: Agent
  readonly abort: AbortController
  readonly preparation: Promise<TicketExecutionHandle>
  status: 'pending' | 'published' | 'rejected'
  handle?: TicketExecutionHandle
  error?: unknown
  abortedWhilePending: boolean
  activation?: { result: PromiseWithResolvers<SubagentResult>; finished: boolean }
  start?: { resolve(): void; reject(error: Error): void }
}

interface World {
  readonly dir: string
  ctx: Context
  generation: number
  tickets?: Fiber
  execution?: Fiber
  readonly roots: (Live & { deleted: boolean; path?: string })[]
  readonly workers: Live[]
  readonly ticketIds: TicketId[]
  readonly flush: Map<string, { mode: 'pass' | 'fail' | 'hold'; nth: number; gate?: PromiseWithResolvers<undefined> }>
  readonly attempts: Attempt[]
  readonly producers: Producer[]
  readonly violations: string[]
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

/** Dedicated-process provider whose start waits for the model; an abort rejects it without a child. */
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
      const started = Promise.withResolvers<undefined>()
      attempt.start = { resolve: () => { started.resolve(undefined) }, reject: (error) => { started.reject(error) } }
      spec.signal?.addEventListener('abort', () => { started.reject(new Error('activation cancelled before a child started')) }, { once: true })
      await started.promise
      const result = Promise.withResolvers<SubagentResult>()
      const activation = { result, finished: false }
      void result.promise.then(() => { activation.finished = true })
      attempt.activation = activation
      return {
        childId: SessionId(`child-${String(world.serial++)}`), result: result.promise,
        dispose: async () => { result.resolve({ output: [], stopReason: 'aborted' }) },
      }
    }
  }
}

function enter(world: World, id: string, seed?: Session): Live & { agent: Agent; session: Session } {
  const { ctx } = world
  const session = ctx.sessions.prepare(SessionId(id), seed === undefined ? undefined : { seed: seed.snapshotEvents() })
  const detachSession = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const agent: Agent = { id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox: unsupportedInbox(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle: async () => {},
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal) }
  const detachAgent = ctx.agents.enter(agent, undefined)
  void ctx.agents.announce(agent, 'startup')
  return { agent, session, close: () => { detachAgent(); detachSession() } }
}

function down(live: Live): void {
  live.close?.()
  delete live.agent
  delete live.close
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
  await mount(world)
}

async function mount(world: World): Promise<void> {
  world.tickets = await world.ctx.plugin(TicketService, {})
  world.execution = await world.ctx.plugin(TicketExecutionService, { settlementTimeoutMs: TIMEOUT_MS })
  world.generation++
}

async function setup(dir: string): Promise<World> {
  const world: World = { dir, ctx: new Context(), generation: 0, roots: [], workers: [], ticketIds: [], flush: new Map(),
    attempts: [], producers: [], violations: [], serial: 0, draining: false }
  await boot(world)
  for (let slot = 0; slot < SLOTS; slot++) {
    const root = enter(world, `root-${String(slot)}`)
    const worker = enter(world, `worker-${String(slot)}`)
    // A stored log makes the root visible to the stored-reservation scan, so deleting it is observable.
    await using writer = await world.ctx.sessionPersistence.create(root.session.header)
    await writer.append(root.session.snapshotEvents())
    const ticket = await world.ctx.agents.withInitiator(root.agent, () => world.ctx.tickets.create(root.session, { subject: 'Property', description: '' }))
    const assigned = await world.ctx.agents.withInitiator(root.agent, () => world.ctx.tickets.assign(root.session, {
      ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.agent.id, ownerId: worker.agent.id, subject: 'Write', workScopes: [...SCOPE],
    }))
    const stat = await world.ctx.sessionPersistence.stat(root.agent.id)
    world.roots.push({ ...root, deleted: false, ...stat?.location?.kind === 'jsonl' ? { path: stat.location.path } : {} })
    world.workers.push(worker)
    world.ticketIds.push(assigned.id)
    world.flush.set(root.session.id, { mode: 'pass', nth: 0 })
  }
  return world
}

function latest(world: World, slot: number): Attempt | undefined {
  return world.attempts.findLast(attempt => attempt.slot === slot)
}

function liveProducerElsewhere(world: World, attempt: Attempt): boolean {
  return world.producers.some(producer => producer.attempt !== attempt && !producer.finished)
    || world.attempts.some(other => other !== attempt && other.activation !== undefined && !other.activation.finished)
}

function prepare(world: World, slot: number, dedicated: boolean, signal: boolean): void {
  const root = world.roots[slot]
  const worker = world.workers[slot]
  const caller = dedicated ? root?.agent : worker?.agent
  const ticketId = world.ticketIds[slot]
  if (root?.session === undefined || root.agent === undefined || caller === undefined || ticketId === undefined) return
  let ticket
  try { ticket = world.ctx.tickets.get(root.session, ticketId) } catch { return }
  const assignment = ticket.assignments[0]
  if (assignment === undefined) return
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
  const attempt: Attempt = { slot, generation: world.generation, request, caller, abort, preparation, status: 'pending', abortedWhilePending: false }
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
}

function startJob(world: World, attempt: Attempt, kind: ProducerKind): void {
  const handle = attempt.handle
  if (handle === undefined) return
  const done = Promise.withResolvers<JobOutcome>()
  const producer: Producer = { attempt, done, kind, finished: false, cancels: 0 }
  void done.promise.then(() => { producer.finished = true })
  world.producers.push(producer)
  handle.startJob('property', () => ({
    cancel() {
      producer.cancels++
      if (kind === 'stubborn') return
      if (kind === 'throws-once' && producer.cancels === 1) throw new Error('transient cancellation failure')
      done.resolve({ status: 'killed' })
    },
    done: done.promise,
  })).catch(() => { done.resolve({ status: 'failed' }) })
}

function finish(world: World, attempt: Attempt | undefined): void {
  for (const producer of world.producers) {
    if (attempt === undefined || producer.attempt === attempt) producer.done.resolve({ status: producer.kind === 'fails' ? 'failed' : 'completed' })
  }
  for (const candidate of world.attempts) {
    if (attempt === undefined || candidate === attempt) candidate.activation?.result.resolve({ output: [], stopReason: 'completed' })
  }
}

function setFlush(world: World, slot: number, mode: 'pass' | 'fail' | 'hold', nth = 0): void {
  const id = world.roots[slot]?.session?.id
  const control = id === undefined ? undefined : world.flush.get(id)
  if (control === undefined) return
  if (mode !== 'hold') control.gate?.resolve(undefined)
  control.mode = mode
  control.nth = nth
  if (mode !== 'hold') delete control.gate
}

function rootUp(world: World, slot: number): void {
  const root = world.roots[slot]
  if (root === undefined || root.agent !== undefined || root.deleted || root.session === undefined) return
  Object.assign(root, enter(world, `root-${String(slot)}`, root.session))
}

async function act(world: World, action: Action): Promise<void> {
  const attempt = 'slot' in action ? latest(world, action.slot) : undefined
  switch (action.kind) {
    case 'prepare': prepare(world, action.slot, action.dedicated, action.signal); break
    case 'retry':
      if (attempt !== undefined && attempt.caller === world.ctx.agents.get(attempt.caller.id)) {
        const before = attempt.status
        void world.ctx.ticketExecution.prepare(attempt.caller, attempt.request).then((handle) => {
          if (before === 'published' && handle !== attempt.handle) world.violations.push(`${attempt.request.attemptId} retry published a second handle`)
        }, (error: unknown) => {
          if (codeOf(error) === undefined && error !== attempt.error && !(error instanceof AggregateError)
            && !(error instanceof Error && FAULTS.has(error.message))) {
            world.violations.push(`${attempt.request.attemptId} retry rejected with an untyped error: ${String(error)}`)
          }
        })
      }
      break
    case 'abort':
      if (attempt !== undefined && !attempt.abort.signal.aborted) {
        if (attempt.status === 'pending' && attempt.request.signal !== undefined) attempt.abortedWhilePending = true
        attempt.abort.abort(new Error('caller cancelled preparation'))
      }
      break
    case 'activation':
      if (attempt?.start !== undefined) {
        if (action.establish) attempt.start.resolve()
        else attempt.start.reject(new Error('provider refused'))
      }
      break
    case 'job': if (attempt !== undefined && attempt.generation === world.generation) startJob(world, attempt, action.producer); break
    case 'finish': finish(world, attempt); break
    case 'settle': void attempt?.handle?.settle().catch(() => {}); break
    case 'dispose': void attempt?.handle?.dispose().catch(() => {}); break
    case 'fail-ticket': {
      const root = world.roots[action.slot]
      const ticketId = world.ticketIds[action.slot]
      if (root?.agent === undefined || root.session === undefined || ticketId === undefined) break
      const session = root.session
      const agent = root.agent
      try {
        const ticket = world.ctx.tickets.get(session, ticketId)
        void world.ctx.agents.withInitiator(agent, () => world.ctx.tickets.fail(session, {
          ticketId, expectedRevision: ticket.revision, actorId: agent.id, summary: 'Stopped by the model' })).catch(() => {})
      } catch { /* A Ticket that cannot be read cannot be failed. */ }
      break
    }
    case 'worker-down': { const worker = world.workers[action.slot]; if (worker !== undefined) down(worker); break }
    case 'worker-up': {
      const worker = world.workers[action.slot]
      if (worker !== undefined && worker.agent === undefined) Object.assign(worker, enter(world, `worker-${String(action.slot)}`))
      break
    }
    case 'hold-flush': setFlush(world, action.slot, 'hold', action.nth); break
    case 'fail-flush': setFlush(world, action.slot, 'fail'); break
    case 'pass-flush': setFlush(world, action.slot, 'pass'); break
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
      for (const control of world.flush.values()) { control.gate?.resolve(undefined); control.mode = 'pass' }
      // A teardown whose stop timed out rejects; Cordis contains it and replacement continues.
      await world.execution?.dispose().catch(() => {})
      await world.tickets?.dispose().catch(() => {})
      await mount(world)
      break
    case 'restart': {
      for (const control of world.flush.values()) { control.gate?.resolve(undefined); control.mode = 'pass' }
      await world.ctx.fiber.dispose()
      // The host exit ends every producer it ran.
      for (const producer of world.producers) producer.done.resolve({ status: 'killed' })
      for (const candidate of world.attempts) candidate.activation?.result.resolve({ output: [], stopReason: 'aborted' })
      for (const live of [...world.roots, ...world.workers]) { delete live.agent; delete live.close }
      await boot(world)
      for (let slot = 0; slot < SLOTS; slot++) Object.assign(world.workers[slot] ?? {}, enter(world, `worker-${String(slot)}`))
      break
    }
    default: action satisfies never
  }
  await settleTicks()
}

/** Release every gate, finish every producer and resume every root, then retry each owner's stop through product paths. */
/** Await one product call; a call that never settles is a liveness violation. */
async function within(world: World, label: string, operation: Promise<unknown> | undefined): Promise<void> {
  if (operation === undefined) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'expired'>((resolve) => { timer = setTimeout(() => { resolve('expired') }, 1000) })
  const outcome = await Promise.race([operation.then(() => 'done', () => 'done'), expired])
  clearTimeout(timer)
  if (outcome === 'expired') world.violations.push(`${label} never settled`)
}

async function quiesce(world: World): Promise<void> {
  for (let waited = 0; waited < 1000 && world.attempts.some(attempt => attempt.status === 'pending'); waited += 5) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
  await settleTicks()
  const pending = world.attempts.filter(attempt => attempt.status === 'pending').map(attempt => attempt.request.attemptId)
  if (pending.length > 0) world.violations.push(`preparations never settled: ${pending.join(', ')}`)
}

async function drain(world: World): Promise<void> {
  world.draining = true
  for (let slot = 0; slot < SLOTS; slot++) setFlush(world, slot, 'pass')
  for (const attempt of world.attempts) attempt.start?.reject(new Error('provider refused'))
  finish(world, undefined)
  for (let slot = 0; slot < SLOTS; slot++) {
    rootUp(world, slot)
    const worker = world.workers[slot]
    if (worker !== undefined && worker.agent === undefined) Object.assign(worker, enter(world, `worker-${String(slot)}`))
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
  // Host reconciliation owns attempts without a live owner in this generation that stopped as unknown or outlived theirs.
  for (const [slot, root] of world.roots.entries()) {
    const { agent, session } = root
    const ticketId = world.ticketIds[slot]
    if (agent === undefined || session === undefined || ticketId === undefined) continue
    for (const attempt of world.ctx.tickets.get(session, ticketId).attempts) {
      if (attempt.status === 'settled') continue
      const record = world.attempts.find(item => item.request.attemptId === attempt.id)
      const owned = record !== undefined && record.generation === world.generation && record.handle !== undefined
      if (owned || (attempt.status !== 'unknown' && record?.generation === world.generation)) continue
      const current = world.ctx.tickets.get(session, ticketId)
      await world.ctx.agents.withInitiator(agent, () => world.ctx.tickets.settleAttempt(session, {
        ticketId, attemptId: attempt.id, actorId: agent.id, expectedRevision: current.revision,
        operationId: TicketOperationId(`host-${attempt.id}`), outcome: 'cancelled',
      })).catch((error: unknown) => { world.violations.push(`host reconciliation of ${attempt.id} failed: ${String(error)}`) })
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
    // Retrying a finished owner's stop is idempotent.
    const events = session.snapshotEvents().length
    for (const attempt of world.attempts) {
      if (attempt.slot !== slot || attempt.generation !== world.generation || attempt.handle === undefined) continue
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
  // Reservations balance: the exclusive scope admits fresh work.
  const root = enter(world, `competing-root-${String(world.serial)}`)
  const worker = enter(world, `competing-worker-${String(world.serial++)}`)
  const ticket = await world.ctx.agents.withInitiator(root.agent, () => world.ctx.tickets.create(root.session, { subject: 'Competing', description: '' }))
  const assigned = await world.ctx.agents.withInitiator(root.agent, () => world.ctx.tickets.assign(root.session, {
    ticketId: ticket.id, expectedRevision: ticket.revision, actorId: root.agent.id, ownerId: worker.agent.id, subject: 'Write', workScopes: [...SCOPE] }))
  await world.ctx.ticketExecution.prepare(worker.agent, {
    rootSessionId: root.session.id, ticketId: ticket.id, assignmentId: assigned.assignments[0]?.id ?? ticket.assignments[0]!.id,
    expectedRevision: assigned.revision, attemptId: TicketAttemptId('attempt-competing'), operationId: TicketOperationId('prepare-competing'),
    workspace: { kind: 'shared-workspace', directory: DIRECTORY, baseCommit: 'a'.repeat(40) }, executor: { kind: 'in-process' },
  }).then(handle => handle.dispose(), (error: unknown) => { world.violations.push(`the exclusive scope stays reserved: ${String(codeOf(error) ?? error)}`) })
}

const slot = fc.integer({ min: 0, max: SLOTS - 1 })
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('prepare' as const), slot, dedicated: fc.boolean(), signal: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('job' as const), slot, producer: fc.constantFrom<ProducerKind>('completes', 'fails', 'stubborn', 'throws-once') }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('activation' as const), slot, establish: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('hold-flush' as const), slot, nth: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constantFrom('retry' as const, 'abort' as const, 'finish' as const, 'settle' as const,
    'dispose' as const, 'fail-ticket' as const, 'worker-down' as const, 'worker-up' as const), slot }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constantFrom('fail-flush' as const, 'pass-flush' as const, 'root-down' as const,
    'root-up' as const, 'drop-root' as const), slot }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constantFrom('replace' as const, 'restart' as const) }) },
)

it('every generated event sequence ends each attempt once, balances reservations, and replays to the live state', async () => {
  const seed = Number(process.env.TICKET_PROPERTY_SEED ?? 20261106)
  await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 14 }), async (actions) => {
    const dir = await mkdtemp(join(tmpdir(), 'ticket-property-'))
    let world: World | undefined
    try {
      const trace = process.env.TICKET_PROPERTY_TRACE === undefined ? undefined : (label: string, started: number) => {
        process.stderr.write(`${label} ${String(Date.now() - started)}ms\n`)
      }
      let started = Date.now()
      world = await setup(dir)
      trace?.('setup', started)
      for (const step of actions) { started = Date.now(); trace?.(`start ${JSON.stringify(step)}`, started); await act(world, step); trace?.(JSON.stringify(step), started) }
      trace?.('drain start', Date.now())
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
        finish(world, undefined)
        for (const control of world.flush.values()) control.gate?.resolve(undefined)
        await world.ctx.fiber.dispose()
      }
      await rm(dir, { recursive: true, force: true })
    }
  }), { seed, numRuns: Number(process.env.TICKET_PROPERTY_RUNS ?? 200), endOnFailure: true })
}, 60_000)
