/**
 * Default curator: a background subagent that holds the curator role while it works, so map
 * building, regrouping, and note verification never enter the working agent's context.
 *
 * Each live map owner has one lifecycle record whose state is one of `idle`, `announced`,
 * `claiming`, `running`, `yielding`, `settling`, or `disposed`; {@link DefaultContextCurator.transition}
 * is the only code that changes it, and the package README holds the state table. A run starts when
 * curation work waits (a changed index, a pending or stale note, or a note refused for lack of room)
 * and nothing else holds the role, at most `maxAttempts` times for the same work. It ends when its
 * work is done, its step bound is reached, the role moves to another holder, its owner is disposed,
 * or the service disposes, and always releases the role and settles its subagent before the next
 * run or disposal. Only the child's logged map edits reach the owner's Session; its transcript
 * stays in the child Session.
 */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import '@deepseek-ai/dsh-subagent'
import { CuratorConfigSchema, resolveCuratorConfig, type ResolvedCuratorConfig } from './config.ts'
import { ContextMapError } from './error.ts'
import { selectCuratorRoute } from './route.ts'
import type { CuratorConfig, MapChange } from './types.ts'
import type {} from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    contextCurator: DefaultContextCurator
  }
}

const PROMPT = [
  'You are the project map curator. You maintain the project map for the conversation that started you; that conversation never sees your transcript, only your map edits.',
  '',
  'Work through these in order, then stop with one short sentence:',
  '1. Call map_view. Note its revision; pass it as expected_revision, and use the new revision each edit returns.',
  '1b. If needsSpace is true, the map is full and a note was refused: merge groups and retire groups or notes that no longer earn their place until there is room, before anything else.',
  '2. If indexChanged is true or the map has no groups, call context_browse and read what you need with context_load. Group related sections under Instructions, Sources, or Tools with map_group (set). Titles are short; the summary is one line saying when to use the group. Merge or retire groups that no longer fit.',
  '3. Follow every nextPendingAfter with map_view pending_after, every nextGroupAfter with group_after, and each group nextNoteAfter with group_id and note_after, including after edits. For each pending note: read the cited sources, then map_note file it under the best group with citations to sections you read, or drop it when it is wrong, duplicated, or already in an instruction.',
  '4. For each stale note: read its sources again; map_note verify it if it still holds (correct the text if needed), otherwise retire it.',
  '5. With map_core choose the few sections every conversation needs up front (instructions that apply to all work). Keep it small.',
  '',
  'A note needs at least one citation and may never cite another note. If an edit is rejected for a stale revision, call map_view and retry once.',
].join('\n')

/** Why a run was asked to stop before its subagent ended on its own. */
type StopReason = 'role moved' | 'step bound' | 'owner disposed' | 'curator disposed'

/** One run, from route selection until it settles. */
interface Run {
  readonly childId: SessionId
  /** Signature of the work the run claims for. */
  readonly work: string
  readonly controller: AbortController
  activation: SubagentActivation | undefined
  indexDigest: string | undefined
}

/** Lifecycle state of the default curator for one map owner. */
type CuratorState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'announced' }
  | { readonly kind: 'claiming'; readonly run: Run }
  | { readonly kind: 'running'; readonly run: Run }
  | { readonly kind: 'yielding'; readonly run: Run; readonly reason: StopReason }
  | { readonly kind: 'settling'; readonly run: Run; readonly reason: string }
  | { readonly kind: 'disposed' }

/** Everything that moves a record between states. */
type CuratorEvent =
  /**
   * Work may wait. `news` is a filed or refused note or a foreign holder gone; an owner step's
   * announcement is not news, because every later owner step announces waiting work again.
   */
  | { readonly kind: 'trigger'; readonly news: boolean }
  /** Evaluation found work this curator may start. */
  | { readonly kind: 'eligible'; readonly work: string }
  /** Evaluation ended the announcement: no work, a live holder, attempts used up, no cheap route, or a failed read. */
  | { readonly kind: 'ineligible' }
  /** The run committed its claim and started its subagent. */
  | { readonly kind: 'started' }
  | { readonly kind: 'stop'; readonly reason: StopReason }
  /** The run's start failed or was canceled, or its subagent finished. */
  | { readonly kind: 'ended'; readonly reason: string }
  /** The run released the role and its subagent settled. */
  | { readonly kind: 'settled' }

/** The lifecycle record of one live owner; removed when it reaches `disposed`. */
interface OwnerRecord {
  readonly owner: Agent
  state: CuratorState
  /** News arrived while a run or evaluation was in progress. */
  retrigger: boolean
  /** Work the last settled run served; a trigger during that run does not restart it for the same work. */
  skipWork: string | undefined
  /** The owner or the service is going away; the record ends in `disposed` once its run settles. */
  closing: boolean
  failure: ContextMapError | undefined
  /** Last start failure reported to the log, so a repeated failure is reported once. */
  reported: string | undefined
  /** Work and owner route for which no cheap route exists; nothing new starts until either changes. */
  noRoute: string | undefined
  /** Resolved and replaced on every transition. */
  changed: PromiseWithResolvers<void>
}

function assertNever(value: never): never {
  throw new Error(`unexpected curator state ${JSON.stringify(value)}`)
}

/** Background default curator; mount `DefaultContextCurator` beside `ContextMapService`. */
export class DefaultContextCurator extends Service {
  static inject = ['agents', 'contextMap', 'subagents', 'llm']
  static Config: z<CuratorConfig> = CuratorConfigSchema

  private readonly config: ResolvedCuratorConfig
  private readonly records = new Map<SessionId, OwnerRecord>()
  /** Evaluations and runs in flight, so disposal waits for every one of them. */
  private readonly tasks = new Set<Promise<void>>()
  private stopping = false

  constructor(ctx: Context, config: CuratorConfig = {}) {
    super(ctx, 'contextCurator')
    this.config = resolveCuratorConfig(config)
  }

  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.contextMap.watch((change) => { this.onChange(change) }), 'contextCurator.watch()')
    this.ctx.on('agent/pre-step', ({ agent, step }, next) => {
      for (const record of this.records.values()) {
        const run = this.runOf(record)
        if (run?.childId !== agent.id || step <= this.config.maxSteps) continue
        // Reject the step that would exceed the bound; stopping alone races the loop's next step.
        this.transition(record, { kind: 'stop', reason: 'step bound' })
        return Promise.resolve({ kind: 'reject' as const })
      }
      return next()
    })
    this.ctx.on('agent/disposed', ({ agent }) => {
      const record = this.records.get(agent.id)
      if (record?.owner !== agent) return
      record.closing = true
      this.transition(record, { kind: 'stop', reason: 'owner disposed' })
    })
    this.ctx.effect(() => async () => {
      this.stopping = true
      for (const record of [...this.records.values()]) {
        record.closing = true
        this.transition(record, { kind: 'stop', reason: 'curator disposed' })
      }
      while (this.tasks.size > 0) await Promise.all(this.tasks)
    }, 'contextCurator.runs()')
  }

  /**
   * Whether a run is active for a map owner.
   * @param ownerId - the map owner's Session id.
   * @returns true from route selection until the run released the role and settled.
   */
  isRunning(ownerId: SessionId): boolean {
    return this.runOf(this.records.get(ownerId)) !== undefined
  }

  /**
   * The failure that kept the last start from running, such as no cheap route.
   * @param ownerId - the map owner's Session id.
   * @returns the failure, or undefined after a successful route selection, before any trigger, or once the owner is gone.
   */
  failureOf(ownerId: SessionId): ContextMapError | undefined {
    return this.records.get(ownerId)?.failure
  }

  /**
   * Wait until an owner has no evaluation or run in progress.
   * @param ownerId - the map owner's Session id.
   */
  async idle(ownerId: SessionId): Promise<void> {
    for (;;) {
      const record = this.records.get(ownerId)
      if (record === undefined || record.state.kind === 'idle') return
      await record.changed.promise
    }
  }

  private runOf(record: OwnerRecord | undefined): Run | undefined {
    const state = record?.state
    return state !== undefined && 'run' in state ? state.run : undefined
  }

  private onChange(change: MapChange): void {
    if (this.stopping) return
    const owner = this.ctx.agents.get(change.ownerSessionId)
    if (owner === undefined) return
    const record = this.records.get(owner.id)
    const run = this.runOf(record?.owner === owner ? record : undefined)
    switch (change.kind) {
      case 'committed': {
        if (record === undefined || run === undefined) return
        const holder = this.ctx.contextMap.snapshotOf(owner).curatorId
        // While claiming, the map is unclaimed or already this run's; afterwards it must stay this run's.
        // A role released because this run's own child is gone is the run ending, not a move.
        const moved = holder === null
          ? record.state.kind === 'running' && this.ctx.agents.get(run.childId) !== undefined
          : holder !== run.childId
        if (moved && (record.state.kind === 'claiming' || record.state.kind === 'running')) {
          this.transition(record, { kind: 'stop', reason: 'role moved' })
        }
        return
      }
      case 'holder-gone':
        // This run's own child ending is the run finishing, not new work.
        if (run !== undefined && change.holderId === run.childId) return
        this.trigger(owner, true)
        return
      case 'work-waiting':
        this.trigger(owner, false)
        return
      case 'note-filed':
        this.trigger(owner, true)
        return
      default:
        return assertNever(change.kind)
    }
  }

  private trigger(owner: Agent, news: boolean): void {
    if (this.stopping) return
    let record = this.records.get(owner.id)
    if (record !== undefined && record.owner !== owner) {
      // A replacement agent for the same Session waits for the old record to settle; it then gets its own.
      record.retrigger = true
      return
    }
    if (record === undefined) {
      record = {
        owner, state: { kind: 'idle' }, retrigger: false, skipWork: undefined, closing: false,
        failure: undefined, reported: undefined, noRoute: undefined, changed: Promise.withResolvers<void>(),
      }
      this.records.set(owner.id, record)
    }
    this.transition(record, { kind: 'trigger', news })
  }

  /** The only place a record changes state; side effects start here and report back through events. */
  private transition(record: OwnerRecord, event: CuratorEvent): void {
    const state = record.state
    const enter = (next: CuratorState): void => {
      record.state = next
      const changed = record.changed
      record.changed = Promise.withResolvers<void>()
      changed.resolve()
    }
    switch (state.kind) {
      case 'idle':
        if (event.kind === 'trigger' && !record.closing) {
          record.retrigger = false
          enter({ kind: 'announced' })
          this.track(this.evaluate(record))
        } else if (event.kind === 'stop' && record.closing) {
          this.dispose(record, enter)
        }
        return
      case 'announced':
        if (event.kind === 'trigger') record.retrigger ||= event.news
        else if (event.kind === 'stop' && record.closing) this.dispose(record, enter)
        else if (event.kind === 'eligible') {
          const run: Run = {
            childId: SessionId(randomUUID()), work: event.work, controller: new AbortController(),
            activation: undefined, indexDigest: undefined,
          }
          // The run reads the map itself, so news that arrived during evaluation is its work too.
          record.skipWork = undefined
          record.retrigger = false
          enter({ kind: 'claiming', run })
          this.track(this.start(record, run))
        } else if (event.kind === 'ineligible') {
          record.skipWork = undefined
          enter({ kind: 'idle' })
          if (record.retrigger) this.transition(record, { kind: 'trigger', news: true })
        }
        return
      case 'claiming':
      case 'running':
        if (event.kind === 'trigger') record.retrigger ||= event.news
        else if (event.kind === 'started' && state.kind === 'claiming') enter({ kind: 'running', run: state.run })
        else if (event.kind === 'stop') {
          enter({ kind: 'yielding', run: state.run, reason: event.reason })
          this.abort(state.run, event.reason)
        } else if (event.kind === 'ended') {
          enter({ kind: 'settling', run: state.run, reason: event.reason })
          this.track(this.settle(record, state.run, event.reason))
        }
        return
      case 'yielding':
        if (event.kind === 'trigger') record.retrigger ||= event.news
        // A subagent that started after the abort is disposed at once.
        else if (event.kind === 'started') this.abort(state.run, state.reason)
        else if (event.kind === 'ended') {
          enter({ kind: 'settling', run: state.run, reason: state.reason })
          this.track(this.settle(record, state.run, state.reason))
        }
        return
      case 'settling':
        if (event.kind === 'trigger') record.retrigger ||= event.news
        else if (event.kind === 'settled') this.afterRun(record, state.run, state.reason, enter)
        return
      case 'disposed':
        return
      default:
        return assertNever(state)
    }
  }

  /** Remove a record that reached its terminal state; a replacement agent for the Session starts fresh. */
  private dispose(record: OwnerRecord, enter: (next: CuratorState) => void): void {
    enter({ kind: 'disposed' })
    if (this.records.get(record.owner.id) === record) this.records.delete(record.owner.id)
    const successor = this.ctx.agents.get(record.owner.id)
    if (record.retrigger && successor !== undefined && successor !== record.owner) this.trigger(successor, true)
  }

  private afterRun(record: OwnerRecord, run: Run, reason: string, enter: (next: CuratorState) => void): void {
    if (record.closing || this.stopping || this.ctx.agents.get(record.owner.id) !== record.owner) {
      record.closing = true
      this.dispose(record, enter)
      return
    }
    enter({ kind: 'idle' })
    // A holder that made this run yield may since have gone; its work is picked up again.
    if (reason === 'role moved' && this.ctx.contextMap.snapshotOf(record.owner).curatorId === null) {
      this.transition(record, { kind: 'trigger', news: true })
    } else if (record.retrigger) {
      // A trigger during the run starts another one only for different work; an interrupted run
      // is retried by a later owner step, within maxAttempts.
      record.skipWork = run.work
      this.transition(record, { kind: 'trigger', news: true })
    }
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch((error: unknown) => {
      this.ctx.logger.warn(`context curator: ${String(error)}`)
    }).finally(() => { this.tasks.delete(tracked) })
    this.tasks.add(tracked)
  }

  /** Decide whether announced work starts a run; every outcome ends the announcement explicitly. */
  private async evaluate(record: OwnerRecord): Promise<void> {
    const { owner } = record
    const still = (): boolean => record.state.kind === 'announced' && !record.closing
    try {
      const holder = this.ctx.contextMap.snapshotOf(owner).curatorId
      if (holder !== null) {
        if (this.ctx.agents.get(holder) !== undefined) {
          this.transition(record, { kind: 'ineligible' })
          return
        }
        // The recorded holder did not survive a restart; its claim no longer excludes anyone.
        await this.ctx.contextMap.release(owner, { rootSessionId: owner.id })
      }
      const view = await this.ctx.contextMap.view(owner, { rootSessionId: owner.id })
      if (!still()) return
      if (view.pending.length === 0 && !view.indexChanged && view.staleNotes === 0 && view.needsSpace !== true) {
        this.transition(record, { kind: 'ineligible' })
        return
      }
      const work = await this.ctx.contextMap.curationWork(owner)
      if (!still()) return
      const route = owner.model.current()
      const routeKey = `${work?.signature ?? ''}|${route?.provider ?? ''}/${route?.model ?? ''}`
      const eligible = work !== null && work.attempts < this.config.maxAttempts
        && work.signature !== record.skipWork && routeKey !== record.noRoute
        && this.ctx.contextMap.snapshotOf(owner).curatorId === null
      this.transition(record, eligible ? { kind: 'eligible', work: work.signature } : { kind: 'ineligible' })
    } catch (error: unknown) {
      if (!still()) return
      this.ctx.logger.warn(`context curator: could not start for ${owner.id}: ${String(error)}`)
      this.transition(record, { kind: 'ineligible' })
    }
  }

  private async start(record: OwnerRecord, run: Run): Promise<void> {
    const { owner } = record
    const { signal } = run.controller
    try {
      const route = owner.model.current()
      const routeKey = `${run.work}|${route?.provider ?? ''}/${route?.model ?? ''}`
      let choice: Awaited<ReturnType<typeof selectCuratorRoute>>
      try {
        choice = await selectCuratorRoute(this.ctx.llm, owner, this.config, signal)
      } catch (error: unknown) {
        if (error instanceof ContextMapError && error.code === 'CONTEXT_MAP_NO_CHEAP_ROUTE') {
          record.failure = error
          record.noRoute = routeKey
        }
        throw error
      }
      record.failure = undefined
      record.noRoute = undefined
      record.reported = undefined
      signal.throwIfAborted()
      const claimed = await this.ctx.contextMap.claim(owner, {
        rootSessionId: owner.id, holderId: run.childId, route: choice.route, work: run.work, expectedHolder: null,
      }, signal)
      run.indexDigest = claimed.observedIndexDigest
      signal.throwIfAborted()
      const effort = choice.route.reasoningEffort
      run.activation = await this.ctx.subagents.startActivation({
        provider: this.config.provider,
        label: 'Project map curator',
        delivery: 'caller',
        signal,
        childId: run.childId,
        request: {
          parent: owner,
          prompt: [{ type: 'text', text: PROMPT }],
          agentOptions: {
            provider: choice.route.provider,
            model: choice.route.model,
            ...effort === undefined ? {} : { reasoningEffort: brandString<ReasoningEffortId>(effort) },
            maxTokens: this.config.maxTokens,
          },
        },
      })
    } catch (error: unknown) {
      const conflict = error instanceof ContextMapError && error.code === 'CONTEXT_MAP_CONFLICT'
      if (!signal.aborted && !conflict) this.report(record, error)
      this.transition(record, { kind: 'ended', reason: signal.aborted || conflict ? 'canceled' : 'start failed' })
      return
    }
    this.transition(record, { kind: 'started' })
    const reason = await run.activation.result.then(result => result.stopReason as string, (error: unknown) => {
      if (!signal.aborted) this.ctx.logger.warn(`context curator: run for ${owner.id} failed: ${String(error)}`)
      return 'error'
    })
    this.transition(record, { kind: 'ended', reason })
  }

  private report(record: OwnerRecord, error: unknown): void {
    const text = String(error)
    if (record.reported === text) return
    record.reported = text
    if (error instanceof ContextMapError && error.code === 'CONTEXT_MAP_NO_CHEAP_ROUTE') this.ctx.logger.error(`context curator: ${error.message}`)
    else this.ctx.logger.warn(`context curator: start failed for ${record.owner.id}: ${text}`)
  }

  private abort(run: Run, reason: string): void {
    run.controller.abort(new Error(reason))
    if (run.activation !== undefined) {
      void run.activation.dispose().catch((error: unknown) => {
        this.ctx.logger.warn(`context curator: could not dispose the run (${reason}): ${String(error)}`)
      })
    }
  }

  /** Release the role if the run still holds it, acknowledge a completed index, and settle the subagent. */
  private async settle(record: OwnerRecord, run: Run, reason: string): Promise<void> {
    const { owner } = record
    try {
      await run.activation?.dispose()
    } catch (error: unknown) {
      this.ctx.logger.warn(`context curator: disposing the run failed: ${String(error)}`)
    }
    try {
      if (this.ctx.agents.get(owner.id) === owner && this.ctx.contextMap.snapshotOf(owner).curatorId === run.childId) {
        await this.ctx.contextMap.release(owner, { rootSessionId: owner.id })
      }
      if (this.ctx.agents.get(owner.id) === owner && reason === 'completed' && run.indexDigest !== undefined) {
        await this.ctx.contextMap.acknowledgeIndex(owner, { rootSessionId: owner.id, indexDigest: run.indexDigest })
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`context curator: finalizing the map failed: ${String(error)}`)
    }
    this.transition(record, { kind: 'settled' })
  }
}

export default DefaultContextCurator
