/**
 * Default curator: a background subagent that holds the curator role while it works, so map
 * building, regrouping, and note verification never enter the working agent's context.
 *
 * One run exists per map owner at a time. A run starts when the index changes or a note is filed
 * and nothing else holds the role, ends when its work is done, its step bound is reached, the
 * role moves to another holder, or the service disposes, and always releases the role and
 * settles its subagent before the next run or disposal. Only the child's logged map edits reach
 * the owner's Session; its transcript stays in the child Session.
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
  '2. If indexChanged is true or the map has no groups, call context_browse and read what you need with context_load. Group related sections under Instructions, Sources, or Tools with map_group (set). Titles are short; the summary is one line saying when to use the group. Merge or retire groups that no longer fit.',
  '3. Follow every nextPendingAfter with map_view pending_after, every nextGroupAfter with group_after, and each group nextNoteAfter with group_id and note_after, including after edits. For each pending note: read the cited sources, then map_note file it under the best group with citations to sections you read, or drop it when it is wrong, duplicated, or already in an instruction.',
  '4. For each stale note: read its sources again; map_note verify it if it still holds (correct the text if needed), otherwise retire it.',
  '5. With map_core choose the few sections every conversation needs up front (instructions that apply to all work). Keep it small.',
  '',
  'A note needs at least one citation and may never cite another note. If an edit is rejected for a stale revision, call map_view and retry once.',
].join('\n')

/** One live curator run. */
interface Run {
  readonly childId: SessionId
  readonly controller: AbortController
  activation: SubagentActivation | undefined
  indexDigest: string | undefined
  /** Why the run was asked to stop; undefined while it works. */
  stopping: string | undefined
  readonly settled: Promise<void>
}

/** Background default curator; mount `DefaultContextCurator` beside `ContextMapService`. */
export class DefaultContextCurator extends Service {
  static inject = ['agents', 'contextMap', 'subagents', 'llm']
  static Config: z<CuratorConfig> = CuratorConfigSchema

  private readonly config: ResolvedCuratorConfig
  private readonly runs = new Map<SessionId, Run>()
  /** Owners whose index or notes changed during a run; a finished run starts again for them. */
  private readonly dirty = new Set<SessionId>()
  private readonly failures = new Map<SessionId, ContextMapError>()
  private stopping = false

  constructor(ctx: Context, config: CuratorConfig = {}) {
    super(ctx, 'contextCurator')
    this.config = resolveCuratorConfig(config)
  }

  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.contextMap.watch((change) => { this.onChange(change) }), 'contextCurator.watch()')
    this.ctx.on('agent/pre-step', ({ agent, step }, next) => {
      for (const run of this.runs.values()) {
        if (run.childId !== agent.id || step <= this.config.maxSteps) continue
        // Reject the step that would exceed the bound; stopping alone races the loop's next step.
        this.stop(run, 'step bound')
        return Promise.resolve({ kind: 'reject' as const })
      }
      return next()
    })
    this.ctx.effect(() => async () => {
      this.stopping = true
      const runs = [...this.runs.values()]
      for (const run of runs) this.stop(run, 'curator disposed')
      await Promise.all(runs.map(run => run.settled))
    }, 'contextCurator.runs()')
  }

  /**
   * Whether a run is active for a map owner.
   * @param ownerId - the map owner's Session id.
   * @returns true while a run holds or is acquiring the role.
   */
  isRunning(ownerId: SessionId): boolean {
    return this.runs.has(ownerId)
  }

  /**
   * The failure that kept the last start from running, such as no cheap route.
   * @param ownerId - the map owner's Session id.
   * @returns the failure, or undefined after a successful start or before any trigger.
   */
  failureOf(ownerId: SessionId): ContextMapError | undefined {
    return this.failures.get(ownerId)
  }

  /**
   * Wait for the active run of an owner, if any, to settle.
   * @param ownerId - the map owner's Session id.
   */
  async idle(ownerId: SessionId): Promise<void> {
    await this.runs.get(ownerId)?.settled
  }

  /** Read through a method so a check after an await is not narrowed by an earlier one. */
  private isStopping(): boolean {
    return this.stopping
  }

  private onChange(change: MapChange): void {
    if (this.stopping) return
    const owner = this.ctx.agents.get(change.ownerSessionId)
    if (owner === undefined) return
    const run = this.runs.get(owner.id)
    // A disappeared foreign holder frees the role: work it left undone is picked up again. This
    // run's own child ending is the run finishing, not new work.
    const ownEnd = change.kind === 'holder-gone' && run !== undefined && change.holderId === run.childId
    if (change.kind !== 'committed' && !ownEnd) this.dirty.add(owner.id)
    if (run !== undefined) {
      // Yield when another holder claimed the role while this run worked.
      if (run.stopping === undefined && this.ctx.contextMap.snapshotOf(owner).curatorId !== run.childId) this.stop(run, 'role moved')
      return
    }
    void this.consider(owner).catch((error: unknown) => {
      this.ctx.logger.warn(`context curator: could not start for ${owner.id}: ${String(error)}`)
    })
  }

  private async consider(owner: Agent): Promise<void> {
    if (this.stopping || this.runs.has(owner.id) || !this.dirty.has(owner.id)) return
    const holder = this.ctx.contextMap.snapshotOf(owner).curatorId
    if (holder !== null) {
      if (this.ctx.agents.get(holder) !== undefined) return
      // The recorded holder did not survive a restart; its claim no longer excludes anyone.
      await this.ctx.contextMap.release(owner, { rootSessionId: owner.id })
    }
    this.dirty.delete(owner.id)
    const view = await this.ctx.contextMap.view(owner, { rootSessionId: owner.id })
    if (this.isStopping() || this.runs.has(owner.id) || this.ctx.contextMap.snapshotOf(owner).curatorId !== null) return
    if (view.pending.length === 0 && !view.indexChanged && view.staleNotes === 0) return
    await this.start(owner)
  }

  private async start(owner: Agent): Promise<void> {
    const childId = SessionId(randomUUID())
    const controller = new AbortController()
    let finish!: () => void
    const run: Run = {
      childId, controller, activation: undefined, stopping: undefined, indexDigest: undefined,
      settled: new Promise<void>((resolve) => { finish = resolve }),
    }
    this.runs.set(owner.id, run)
    try {
      const choice = await selectCuratorRoute(this.ctx.llm, owner, this.config, controller.signal)
      this.failures.delete(owner.id)
      controller.signal.throwIfAborted()
      const claimed = await this.ctx.contextMap.claim(
        owner, { rootSessionId: owner.id, holderId: childId, route: choice.route }, controller.signal,
      )
      run.indexDigest = claimed.observedIndexDigest
      controller.signal.throwIfAborted()
      const effort = choice.route.reasoningEffort
      run.activation = await this.ctx.subagents.startActivation({
        provider: this.config.provider,
        label: 'Project map curator',
        delivery: 'caller',
        signal: controller.signal,
        childId,
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
      if (error instanceof ContextMapError && error.code === 'CONTEXT_MAP_NO_CHEAP_ROUTE') {
        this.failures.set(owner.id, error)
        this.ctx.logger.error(`context curator: ${error.message}`)
      } else if (!controller.signal.aborted) {
        this.ctx.logger.warn(`context curator: start failed for ${owner.id}: ${String(error)}`)
      }
      run.stopping ??= 'start failed'
      void this.finishRun(owner, run, finish)
      return
    }
    void run.activation.result.then((result) => {
      run.stopping ??= result.stopReason
    }, (error: unknown) => {
      if (run.stopping === undefined) this.ctx.logger.warn(`context curator: run for ${owner.id} failed: ${String(error)}`)
      run.stopping ??= 'error'
    }).then(() => this.finishRun(owner, run, finish))
    if (run.stopping !== undefined) this.stop(run, run.stopping)
  }

  private stop(run: Run, reason: string): void {
    run.stopping ??= reason
    run.controller.abort(new Error(reason))
    if (run.activation !== undefined) {
      void run.activation.dispose().catch((error: unknown) => {
        this.ctx.logger.warn(`context curator: could not dispose the run (${reason}): ${String(error)}`)
      })
    }
  }

  /** Release the role if the run still holds it, settle the subagent, then maybe start again. */
  private async finishRun(owner: Agent, run: Run, finish: () => void): Promise<void> {
    run.stopping ??= 'interrupted'
    try {
      await run.activation?.dispose()
    } catch (error: unknown) {
      run.stopping = 'cleanup failed'
      this.ctx.logger.warn(`context curator: disposing the run failed: ${String(error)}`)
    }
    try {
      if (this.ctx.agents.get(owner.id) === owner && this.ctx.contextMap.snapshotOf(owner).curatorId === run.childId) {
        await this.ctx.contextMap.release(owner, { rootSessionId: owner.id })
      }
      if (this.ctx.agents.get(owner.id) === owner && run.stopping === 'completed' && run.indexDigest !== undefined) {
        await this.ctx.contextMap.acknowledgeIndex(owner, { rootSessionId: owner.id, indexDigest: run.indexDigest })
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`context curator: finalizing the map failed: ${String(error)}`)
    }
    this.runs.delete(owner.id)
    finish()
    if (this.stopping || this.ctx.agents.get(owner.id) !== owner) return
    // Another holder that yielded this run may since have gone; a trigger during the run starts a new one.
    const holderGone = run.stopping === 'role moved' && this.ctx.contextMap.snapshotOf(owner).curatorId === null
    if (holderGone) this.dirty.add(owner.id)
    await this.consider(owner).catch((error: unknown) => {
      this.ctx.logger.warn(`context curator: could not restart for ${owner.id}: ${String(error)}`)
    })
  }
}

export default DefaultContextCurator
