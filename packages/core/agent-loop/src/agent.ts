/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import { createHash } from 'node:crypto'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  ModelSelection,
  ModelSelectionProjectionState,
  InboxTarget,
  InboxState,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { AgentModel, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  LlmError,
  createAssistantMessage,
  createDeveloperMessage,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionId, SessionSeq, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals, ToolCallRecovery } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { ToolActivationError, ToolAdmissionError, ToolBatchExecutionError } from '@deepseek-ai/dsh-tools'
import type { ResolvedToolSet, ToolDefinition, ToolExecutor } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { ReactLoopInbox } from './inbox.ts'
import { RuntimeContextProjection } from './runtime-context.ts'
import { AssistantStreamAttempt } from './assistant-stream.ts'
import { SystemPromptProjection } from './runtime-context.ts'

/** Projected facts consumed by this driver; registration stays with the factory. */
interface LoopProjections {
  /** Current model selection, including pending changes. */
  readonly modelSelection: () => ModelSelectionProjectionState
  /** Current queued and claimed input. */
  readonly inbox: () => InboxState
}

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

/** Immutable inputs that produced one accepted prompt and declaration sequence. */
interface RequestInputs {
  readonly definitions: readonly ToolDefinition[]
  readonly executor: ToolExecutor
  readonly ordered: boolean
  readonly contexts: readonly string[]
  /** Section revisions read in the same synchronous step that started the assembly. */
  readonly sections: readonly string[]
  /** Runtime-context revisions read in the same synchronous step that rendered the accepted contexts. */
  readonly contextRevisions: readonly string[]
}

/** Revisions that registered sections and runtime contexts declared for one assembly context. */
interface RenderRevisions {
  readonly sections: readonly (readonly [name: string, revision: string])[]
  readonly contexts: readonly (readonly [name: string, revision: string])[]
}

/** Loop-owned nodes committed in this attempt but not yet sent to a model. */
type UnsentRequestMessages = { readonly system?: SessionSeq; readonly context?: SessionSeq }

/**
 * What a restarted attempt needs from an attempt abandoned before freezing: the header the model last saw,
 * the request-series generation before the attempt, and the header and notice it logged but never sent.
 */
type AbandonedRequest = {
  readonly baseline: EpochHeader | undefined
  readonly generation: number
  readonly headerSeq?: SessionSeq
  readonly noticeSeq?: SessionSeq
}

/** One step's live admission and the immutable evidence for its accepted assembly. */
type PreparedTools = { readonly toolSet: ResolvedToolSet; readonly assembly: PromptAssembly; readonly inputs: RequestInputs }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

type PreparedStep =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
    selection: Readonly<ModelSelection>
    /**
     * Admission shared by the step's declarations and dispatch, with its prompt. The step replaces the
     * pair, disposing the old selection, when its captured inputs differ before an attempt; the turn
     * disposes the current one after the step.
     */
    tools: PreparedTools
  }

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/**
 * Read the cause `cancel()` passed when aborting a loop-owned signal, copying
 * only the fields `turn/end` records. The live reason stays the caller's
 * object, and Node's fetch assigns a `stack` onto it that `Session.append`
 * would either log or reject as data JSON cannot hold.
 * @param signal - a turn or maintenance signal this loop owns.
 * @returns the copied cause, or undefined while the signal is still live.
 */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of the signals this loop owns.
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    /* v8 ignore next -- cancel accepts the closed AgentCancelCause union */
    default:
      return assertNever(cause)
  }
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly model: AgentModel
  readonly inbox: ReactLoopInbox
  private phase: Phase
  private testAdmission = false
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  /**
   * Surface generation at attachment or the preceding built request, advanced past replacements of
   * nodes no request has carried.
   */
  private requestSurfaceGeneration: number
  private readonly runtimeContext: RuntimeContextProjection
  /** Process-local revision of assistant frames for this attached Session. */
  private assistantStreamRevision = 0
  private assistantAttemptCounter = 0
  private readonly systemPrompt: SystemPromptProjection
  /** Identities fully frozen by this loop; weak references do not retain replaced history. */
  private readonly frozenMessages = new WeakSet<Message>()

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
    projections: LoopProjections,
    lastTurn: number,
    private readonly parked = false,
  ) {
    this.requestSurfaceGeneration = session.surface.contentGeneration
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this, { observeCleanup: parked })
    this.ctx = this.scope.ctx
    this.model = new AgentModel(projections.modelSelection, session, options)
    this.inbox = new ReactLoopInbox(projections.inbox, session, this.dispatch)
    this.phase = { kind: 'idle', lastTurn }
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
    this.systemPrompt = new SystemPromptProjection(session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = abortedCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.parked && !this.testAdmission) return
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const { lastTurn } = this.phase
    try {
      // The running phase commits only inside an admitted boundary, so every
      // running phase has a driver whose finally returns it to idle.
      void this.loopCtx.agents.withInitiator(this, () => {
        const driver = Promise.withResolvers<void>()
        this.activityDone = driver.promise
        this.setPhase({
          kind: 'running',
          abort: new AbortController(),
          turn: lastTurn,
          step: 0,
          wakeRequested: false,
        })
        this.kick().then(driver.resolve, driver.reject)
        return driver.promise
      })
    } catch (error: unknown) {
      // Admission is the only synchronous throw: the operation's status
      // dispatch contains listener failures and kick() is async. A closing
      // initiator scope (host unload) refuses the wake; the input stays queued
      // under the disposal inbox policy and the Agent stays idle.
      this.loopCtx.logger.warn(`agent "${this.id}": wake refused, queued input stays pending: ${String(error)}`)
    }
  }

  /**
   * Wake the driver for queued `next-turn` input after a resume. The wake runs one macrotask later, so the caller
   * that awaited the resume reads the restored queue first; {@link whenIdle} already waits for the resulting turn.
   * Queued `next-step` input alone waits for the next wake: an `inject()` never opens a turn.
   */
  driveQueuedInput(): void {
    if (this.phase.kind !== 'idle' || this.inbox.nextTurn.length === 0) return
    const pending = Promise.withResolvers<void>()
    this.activityDone = pending.promise
    setImmediate(() => {
      // A send, cancellation, or disposal in the meantime owns the queue.
      if (this.activityDone === pending.promise && this.phase.kind === 'idle' && this.inbox.nextTurn.length > 0) {
        this.wakeDriver()
      }
      pending.resolve()
    })
  }

  /**
   * Drive a tool-less fake turn in tests; unavailable outside the test runtime.
   * @param input - test-owned follow-up; existing queued input remains ordered.
   */
  async testOnlyTurn(input: UserMessage): Promise<void> {
    if (process.env.NODE_ENV !== 'test' || !this.parked || this.testAdmission) throw new Error('test activation is unavailable')
    const release = this.ctx.tools.restrict({ allow: [] })
    this.testAdmission = true
    try {
      this.followup(input)
      await this.whenIdle()
    } finally {
      this.testAdmission = false
      release()
    }
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /**
   * Propose one step for a batch the caller already claimed.
   * @param claimed - the claimed batch; {@link turn} returns it to the log when preparation fails.
   * @param position - turn and step the batch would enter.
   */
  private async preStep(claimed: UserMessage[], position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const selection = this.model.current()
    if (selection === undefined) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or record a model selection`)
    }
    // Tools resolve and the prompt assembles inside the pre-step chain's final handler, so its runtime
    // context reflects the listeners that ran before delegating. Work after a listener's `next()`, and
    // request preparation, can still replace history; `step()` reselects before each request attempt.
    let prepared: PreparedTools | undefined
    const prepareTools = async (): Promise<PreparedTools> => {
      prepared?.toolSet.dispose()
      prepared = undefined
      return prepared = await this.selectTools(selection, signal)
    }
    try {
      const decision = await this.dispatch.waterfall(
        'agent/pre-step', { messages: claimed, ...position, signal, modelSelection: selection },
        async (): Promise<PreStepDecision> => {
          const { assembly } = await prepareTools()
          const sections = renderContextSections(assembly)
          const context = this.runtimeContext.project(joinContextSections(sections), sections)
          return {
            kind: 'enter',
            messages: context === undefined ? claimed : [...claimed, context],
          }
        },
      )
      signal.throwIfAborted()
      if (decision.kind === 'reject') {
        prepared?.toolSet.dispose()
        return decision
      }
      // A listener that answered without delegating skipped the final handler; select tools now.
      const tools = prepared ?? await prepareTools()
      return { ...decision, selection, tools }
    } catch (error: unknown) {
      prepared?.toolSet.dispose()
      throw error
    }
  }

  /** Resolve and assemble one step's initial tool selection. */
  private async selectTools(selection: Readonly<ModelSelection>, signal: AbortSignal): Promise<PreparedTools> {
    const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })
    return this.assembleFor(toolSet, selection, signal)
  }

  /** Assemble from one selection, disposing it on failure and capturing immutable request inputs. */
  private async assembleFor(
    toolSet: ResolvedToolSet, selection: Readonly<ModelSelection>, signal: AbortSignal,
  ): Promise<PreparedTools> {
    try {
      const definitions = Object.freeze(this.loopCtx.tools.definitions(this, toolSet))
      const executor = this.loopCtx.tools.selectExecutor(this)
      const context = { ...assembleContextFor(this, signal), modelSelection: selection, toolSet }
      // Section and context text resolve before assembly's first await, so these revisions describe the rendered text.
      const revisions = this.readRevisions(context)
      const assembly = await this.loopCtx.systemPrompt.assemble(context)
      signal.throwIfAborted()
      return { toolSet, assembly, inputs: this.requestInputs(toolSet, assembly, revisions, definitions, executor) }
    } catch (error: unknown) {
      toolSet.dispose()
      throw error
    }
  }

  /** Read the declared section and runtime-context revisions without rendering any text. */
  private readRevisions(context: AssembleContext): RenderRevisions {
    return {
      sections: this.loopCtx.systemPrompt.sectionRevisions(context),
      contexts: this.loopCtx.systemPrompt.contextRevisions(context),
    }
  }

  /** Capture identities, rendered context hashes, and declared revisions without retaining a mutable registry view. */
  private requestInputs(
    toolSet: ResolvedToolSet, assembly: PromptAssembly, revisions: RenderRevisions,
    definitions = Object.freeze(this.loopCtx.tools.definitions(this, toolSet)),
    executor = this.loopCtx.tools.selectExecutor(this),
  ): RequestInputs {
    return Object.freeze({
      ...this.toolInputs(toolSet, definitions, executor),
      contexts: Object.freeze(renderContextSections(assembly).map(section =>
        createHash('sha256').update(JSON.stringify([section.name, section.text])).digest('hex'))),
      sections: Object.freeze(revisions.sections.map(entry => JSON.stringify(entry))),
      contextRevisions: Object.freeze(revisions.contexts.map(entry => JSON.stringify(entry))),
    })
  }

  /**
   * Whether every revision that sections and runtime contexts declare still reads as it did when the accepted
   * assembly was rendered. Runs synchronously in the step that freezes the request, so no service can change
   * a declared fact between this check and the frozen messages.
   */
  private revisionsCurrent(
    inputs: RequestInputs, toolSet: ResolvedToolSet, selection: Readonly<ModelSelection>, signal: AbortSignal,
  ): boolean {
    const current = this.readRevisions({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet })
    const same = (accepted: readonly string[], read: RenderRevisions['sections']): boolean =>
      accepted.length === read.length && accepted.every((revision, index) => JSON.stringify(read[index]) === revision)
    return same(inputs.sections, current.sections) && same(inputs.contextRevisions, current.contexts)
  }

  /** Read the live admitted definitions, executor, and ordering without rendering context. */
  private toolInputs(
    toolSet: ResolvedToolSet,
    definitions = Object.freeze(this.loopCtx.tools.definitions(this, toolSet)),
    executor = this.loopCtx.tools.selectExecutor(this),
  ): Omit<RequestInputs, 'contexts' | 'sections' | 'contextRevisions'> {
    return { definitions, executor, ordered: toolSet.ordered === true }
  }

  /** Record the surface nodes and content generation that admission or validation reads. */
  private historyCheckpoint(): { readonly nodes: readonly SessionSeq[]; readonly generation: number } {
    return { nodes: [...this.session.surface.nodes], generation: this.session.surface.contentGeneration }
  }

  /** Whether no surface node was appended, removed, or replaced since the checkpoint. */
  private historyUnchanged(checkpoint: { readonly nodes: readonly SessionSeq[]; readonly generation: number }): boolean {
    const { nodes, contentGeneration } = this.session.surface
    return checkpoint.generation === contentGeneration && checkpoint.nodes.length === nodes.length
      && checkpoint.nodes.every((seq, index) => nodes[index] === seq)
  }

  /**
   * Resolve once after preparation and all pending message commits, including retries. An unchanged tuple
   * keeps the accepted prompt and cache prefix; changed definitions, executor, context, or section revisions reassemble.
   * Claiming listeners never rerun; a final validation bounds reconciliation without reselection.
   */
  private async reselectForRequest(decision: Extract<PreparedStep, { kind: 'enter' }>, signal: AbortSignal): Promise<void> {
    const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: decision.selection, signal })
    const previous = decision.tools
    try {
      const context = { ...assembleContextFor(this, signal), modelSelection: decision.selection, toolSet }
      const assembly = this.loopCtx.systemPrompt.refreshContext(previous.assembly, context)
      const inputs = this.requestInputs(toolSet, assembly, this.readRevisions(context))
      signal.throwIfAborted()
      if (this.sameRequestInputs(previous.inputs, inputs)) {
        // The kept assembly renders the same text; the revisions read with that text are the ones to recheck.
        decision.tools = { ...previous, toolSet, inputs }
        previous.toolSet.dispose()
        return
      }
    } catch (error: unknown) {
      toolSet.dispose()
      throw error
    }
    decision.tools = await this.assembleFor(toolSet, decision.selection, signal)
    previous.toolSet.dispose()
  }

  /** Compare new inputs with the captured sequence, never with the previous selection's live view. */
  private sameRequestInputs(before: RequestInputs, after: RequestInputs): boolean {
    return this.sameToolInputs(before, after)
      && before.contexts.length === after.contexts.length
      && before.contexts.every((hash, index) => after.contexts[index] === hash)
      && before.sections.length === after.sections.length
      && before.sections.every((revision, index) => after.sections[index] === revision)
  }

  /** Compare admission identities and ordering without rereading ordinary runtime facts. */
  private sameToolInputs(
    before: Omit<RequestInputs, 'contexts' | 'sections' | 'contextRevisions'>,
    after: Omit<RequestInputs, 'contexts' | 'sections' | 'contextRevisions'>,
  ): boolean {
    return before.executor === after.executor && before.ordered === after.ordered
      && before.definitions.length === after.definitions.length
      && before.definitions.every((definition, index) => after.definitions[index] === definition)
  }

  /** Whether the assembled tool schemas differ from the logged request header's. */
  private toolsChanged(tools: PromptAssembly['tools'], baseline: EpochHeader | undefined): boolean {
    if (baseline === undefined) return false
    return !headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }))
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    // Claimed input that no `user/message` has committed yet: a non-cancellation failure commits it inside the
    // failed step, or inside the proposed step when preparation failed, so a claim is always delivered once.
    // Commits are observed by identity, so a failure after step 4 of the commit-point order commits nothing twice.
    const uncommitted = new Map<string, UserMessage>()
    let proposed = phase.step + 1
    const stopCommitWatch = this.ctx.on('session/event', (session, event) => {
      if (session === this.session && event.type === 'user/message') uncommitted.delete(event.data.id)
    })
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        proposed = step
        const claimed = this.inbox.claim(target, turn)
        for (const message of claimed) uncommitted.set(message.id, message)
        const decision = await this.preStep(claimed, { turn, step })
        if (decision.kind === 'reject') {
          // An authoritative reject consumes the batch without delivering it.
          uncommitted.clear()
          turnEnds = { kind: 'blocked' }
          return false
        }
        // The listeners' decision replaces the claimed batch as the input this step owes the log.
        uncommitted.clear()
        for (const message of decision.messages) {
          if (message.source.kind !== 'runtime-context') uncommitted.set(message.id, message)
        }
        try {
          if (turnEnds && decision.messages.length === 0) break
          // A removed waking message or an enter decision rewritten to empty
          // still owns the initial turn boundary, but it spends no model call.
          if (phase.step === 0 && decision.messages.length === 0) {
            turnEnds = { kind: 'completed' }
            return false
          }
          signal.throwIfAborted()
          try {
            await this.dispatch.serial('agent/step-accepted', {
              messages: decision.messages, turn, step, signal, modelSelection: decision.selection,
            })
          } finally {
            for (const message of decision.messages) {
              if (message.source.kind !== 'runtime-context') uncommitted.set(message.id, message)
            }
          }
          signal.throwIfAborted()
          this.session.append('step/start', { turn, step })
          phase.step = step
          const toolRecovery = new ToolCallRecovery()
          const stopRecovery = this.ctx.on('session/event', (session, event) => {
            if (session === this.session) toolRecovery.observe(event)
          })
          try {
            // max-tokens is sticky: once any step hits the ceiling, later steps
            // that complete normally must not downgrade the turn outcome.
            const stepEnd = await this.step(decision)
            // max-tokens stays sticky: a later completed step must not
            // downgrade the turn outcome.
            if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
          } catch (error: unknown) {
            let failure = error
            try {
              if (abortedCancelCause(signal) === undefined) this.commitUndelivered(uncommitted, { turn, step })
            } catch (commitError: unknown) {
              failure = new AggregateError([error, commitError], 'Step failed and its claimed input could not be recorded', { cause: error })
            } finally {
              uncommitted.clear()
            }
            try {
              for (const event of toolRecovery.results()) {
                this.session.append('tool/result', event.data, {
                  surfaceOp: 'append',
                  ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs },
                })
              }
            } catch (recoveryError: unknown) {
              throw new AggregateError([failure, recoveryError], 'Step failed and its pending tool results could not be recorded', { cause: failure })
            }
            throw failure
          } finally {
            stopRecovery()
            this.session.append('step/end', { turn, step })
          }
        } finally {
          // Admission closes once the step's tool batch settles or no step opens.
          decision.tools.toolSet.dispose()
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      // A cause is present exactly while the signal is aborted.
      const cause = abortedCancelCause(signal)
      if (cause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, a tool
      // activation failure keeps its code, and anything else flattens to
      // `errorChain` text under the `UNKNOWN` code.
      let failure = error
      // Preparation failed before the proposed step opened: the step opens only to commit the claimed input.
      if (uncommitted.size > 0 && phase.step < proposed) {
        try {
          this.session.append('step/start', { turn, step: proposed })
          try {
            this.commitUndelivered(uncommitted, { turn, step: proposed })
          } finally {
            this.session.append('step/end', { turn, step: proposed })
          }
        } catch (commitError: unknown) {
          failure = new AggregateError([error, commitError], 'Step preparation failed and its claimed input could not be recorded', { cause: error })
        }
      }
      turnEnds = {
        kind: 'error',
        error: failure instanceof LlmError
          ? failure.failure
          : { message: errorChain(failure), code: failure instanceof ToolActivationError || failure instanceof ToolAdmissionError ? failure.code : 'UNKNOWN' },
      }
      this.throwError(failure)
    } finally {
      stopCommitWatch()
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  /**
   * Commit claimed input that a failed step never admitted, inside that open step. A Session without a system
   * node first receives the empty head that reserves surface node 0 for the prompt.
   * @param uncommitted - the claimed messages no `user/message` has committed, in claim order.
   * @param position - the open turn and step.
   */
  private commitUndelivered(uncommitted: ReadonlyMap<string, UserMessage>, position: { turn: number; step: number }): void {
    if (uncommitted.size === 0) return
    const reservation = this.systemPrompt.reservation()
    if (reservation !== undefined) this.session.append('system/message', { ...position, message: reservation }, { surfaceOp: 'append' })
    for (const message of [...uncommitted.values()]) this.session.append('user/message', message, { surfaceOp: 'append' })
  }

  /** Commit prompt, accepted input, and runtime context before final-history admission. */
  private commitRequestMessages(
    assembly: PromptAssembly,
    decision: Extract<PreparedStep, { kind: 'enter' }>,
    preparedCall: PreparedLlmCall | undefined,
    requestContext: readonly UserMessage[],
    firstAttempt: boolean,
    startsRequestSeries: boolean,
    position: { turn: number; step: number },
    signal: AbortSignal,
    unsent?: UnsentRequestMessages,
    carried?: AbandonedRequest,
  ): UnsentRequestMessages {
    const { turn, step } = position
    let system: SessionSeq | undefined
    let runtime: SessionSeq | undefined
    const assembledPrompt = renderPrompt(assembly)
    const renderedPrompt = preparedCall?.systemPromptPrefix === undefined
      ? assembledPrompt
      : preparedCall.systemPromptPrefix + (assembledPrompt.length === 0 ? '' : `\n\n${assembledPrompt}`)
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    signal.throwIfAborted()
    const commits = this.systemPrompt.project(renderedPrompt, {
      inHistory: preparedCall?.systemPromptUpdate === 'in-history',
      ...unsent?.system === undefined ? {} : { unsent: unsent.system },
      startsSeries: startsRequestSeries
        || this.requestSurfaceGeneration !== this.session.surface.contentGeneration
        || (preparedCall?.toolUpdate === undefined
          && this.toolsChanged(assembly.tools, carried === undefined ? this.session.requestHeader() : carried.baseline)),
    })
    // Replacing a node this attempt committed changes nothing a request carried, so when no other
    // surface change preceded it, the replacement keeps the request series.
    const replaceUnsent = (append: () => SessionSeq): SessionSeq => {
      const continuing = this.requestSurfaceGeneration === this.session.surface.contentGeneration
      const seq = append()
      if (continuing) this.requestSurfaceGeneration = this.session.surface.contentGeneration
      return seq
    }
    for (const { message, intent } of commits) {
      const append = () => this.session.append('system/message', { turn, step, message }, intent).seq
      system = typeof intent.surfaceOp === 'object' && intent.surfaceOp.startSeq === unsent?.system
        ? replaceUnsent(append) : append()
    }
    const commitContext = (message: UserMessage): void => {
      const seq = unsent?.context
      runtime = seq !== undefined && this.session.surface.nodes.includes(seq)
        ? replaceUnsent(() => this.session.append('user/message', message,
          { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }).seq)
        : this.session.append('user/message', message, { surfaceOp: 'append' }).seq
    }
    let contextAdmitted = false
    if (firstAttempt) {
      for (const message of decision.messages) {
        if (message.source.kind === 'runtime-context') {
          if (requestContext.length === 0 && context !== undefined && !contextAdmitted) {
            commitContext(context)
            contextAdmitted = true
          }
        } else {
          this.session.append('user/message', message, { surfaceOp: 'append' })
        }
      }
    }
    for (const message of requestContext) {
      this.session.append('user/message', message, { surfaceOp: 'append' })
    }
    if (context !== undefined && !contextAdmitted) commitContext(context)
    // A pass that commits nothing leaves the earlier unsent node unsent.
    const unsentSystem = system ?? unsent?.system
    const unsentContext = runtime ?? unsent?.context
    return {
      ...unsentSystem === undefined ? {} : { system: unsentSystem },
      ...unsentContext === undefined ? {} : { context: unsentContext },
    }
  }

  private async step(decision: Extract<PreparedStep, { kind: 'enter' }>): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()

    let firstAttempt = true
    let restarted = false
    // Nodes an abandoned attempt committed that no request carried; the restarted attempt replaces them.
    let abandoned: { unsent: UnsentRequestMessages; request: AbandonedRequest } | undefined
    while (true) {
      const { config, preparedCall } = await this.prepareRequest(turn, step, decision.selection, signal)
      const requestContext = await this.loopCtx.systemPrompt.requestContext({
        ...assembleContextFor(this, signal), modelSelection: decision.selection,
      }, firstAttempt ? decision.messages : [])
      const startsRequestSeries = (firstAttempt || abandoned !== undefined) && decision.startsRequestSeries === true
      const before = this.loopCtx.systemPrompt.refreshContext(decision.tools.assembly, {
        ...assembleContextFor(this, signal), modelSelection: decision.selection, toolSet: decision.tools.toolSet,
      })
      const unsent = this.commitRequestMessages(
        before, decision, preparedCall, requestContext, firstAttempt, startsRequestSeries, { turn, step }, signal,
        abandoned?.unsent, abandoned?.request,
      )
      firstAttempt = false
      // Admission reads this history; the checkpoint precedes resolution and assembly because both await.
      const admitted = this.historyCheckpoint()
      await this.reselectForRequest(decision, signal)
      const { assembly, toolSet, inputs } = decision.tools
      const reassembled = this.commitRequestMessages(
        assembly, decision, preparedCall, [], false, startsRequestSeries, { turn, step }, signal, unsent, abandoned?.request,
      )
      // Validation reads this history; an append after it, including one during the final await, is a change.
      let checked = admitted
      const built = await this.buildRequest(config, preparedCall, assembly.tools, { turn, step }, startsRequestSeries, signal, {
        settle: async () => {
          if (this.historyUnchanged(checked)) return
          // History committed after the checkpoint (reconciliation, tool notices, or a concurrent append
          // during assembly) may change admission. Verify its fixed point once, without another resolution
          // or assembly.
          checked = this.historyCheckpoint()
          await toolSet.validate()
        },
        verify: () => {
          // Registrations can be withdrawn or replaced during any await since resolution; the frozen
          // declarations must still be exactly the live admitted definitions.
          if (!this.sameToolInputs(inputs, this.toolInputs(toolSet))) {
            throw new ToolAdmissionError(new Error('Tool registrations changed after admission; retry the turn'))
          }
          // Facts such as goal state change without touching the surface, so history alone cannot show it.
          return this.historyUnchanged(checked) && this.revisionsCurrent(inputs, toolSet, decision.selection, signal)
        },
      }, abandoned?.request)
      if ('baseline' in built) {
        // History moved after the last admission check. Validation can only confirm a selection, so a
        // fresh attempt resolves against the final history; a second movement fails before dispatch.
        if (restarted) throw new ToolAdmissionError(new Error('Request context did not settle after admission; retry the turn'))
        restarted = true
        // No request carried what this attempt logged, so the restart replaces its prompt, runtime snapshot
        // and tool notice, and judges the request series as it stood before the attempt.
        this.requestSurfaceGeneration = built.generation
        abandoned = { unsent: reassembled, request: built }
        continue
      }
      const request = built
      // The frozen request carries this attempt's nodes, so a transient retry must treat them as sent.
      abandoned = undefined
      const live = new AssistantStreamAttempt(
        this.session.id,
        ++this.assistantAttemptCounter,
        () => ++this.assistantStreamRevision,
        turn,
        step,
        (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
      )
      let started = false
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        live.start()
        started = true
        for await (const chunk of stream) {
          signal.throwIfAborted()
          live.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        if (!started) throw error
        try {
          if (signal.aborted) {
            const content = live.interruptedBlocks()
            if (content.length > 0) {
              live.settle('assistant/message', () => this.session.append('assistant/message', {
                turn,
                step,
                message: createAssistantMessage({
                  content,
                  source: {
                    provider: request.provider,
                    model: request.model,
                    ...live.replayState === undefined ? {} : { replayState: live.replayState },
                  },
                }),
                interrupted: true,
                ...live.usage === undefined ? {} : { usage: live.usage },
                stream: live.stream,
              }, { surfaceOp: 'append' }).seq)
            } else {
              live.settle(
                'assistant/attempt',
                () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
              )
            }
          } else {
            live.settle(
              'assistant/attempt',
              () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
            )
          }
        } catch (settlementError: unknown) {
          throw new AggregateError(
            [error, settlementError],
            'Assistant stream failed and its durable settlement was rejected',
            { cause: error },
          )
        }
        throw error
      }
      try {
        const finish = live.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          live.settle(
            'assistant/attempt',
            () => this.session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
          )
          const action = await this.dispatch.waterfall(
            'agent/request-error', {
              turn,
              step,
              provider: request.provider,
              failure: finish.failure,
              retryPolicy: preparedCall?.retryPolicy,
              signal,
            },
            () => Promise.resolve<RequestErrorAction>(undefined),
          )
          signal.throwIfAborted()
          if (action?.kind !== 'retry') {
            throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
          }
          continue
        }

        const message = createAssistantMessage({
          content: live.blocks(),
          source: {
            provider: request.provider,
            model: request.model,
            ...live.replayState !== undefined ? { replayState: live.replayState } : {},
          },
        })
        live.settle(
          'assistant/message',
          () => this.session.append('assistant/message', {
            turn,
            step,
            message,
            ...live.usage === undefined ? {} : { usage: live.usage },
            stream: live.stream,
          }, { surfaceOp: 'append' }).seq,
        )
        if (finish.kind === 'max-tokens') return { kind: 'max-tokens' }

        const toolCalls = message.content.filter(block => block.type === 'tool-call')
        if (toolCalls.length === 0) return { kind: 'completed' }
        const maxParallelToolCalls = this.loopCtx.agentLoop.config.maxParallelToolCalls.get()
        try {
          const result = await decision.tools.inputs.executor.execute({
            calls: toolCalls, signal, agent: this, log: { turn, step },
            maxParallelToolCalls, toolSet: decision.tools.toolSet,
          })
          for (const context of result.additionalContexts) {
            this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])
          }
          return result.concluded ? { kind: 'completed' } : null
        } catch (error: unknown) {
          if (!(error instanceof ToolBatchExecutionError)) throw error
          for (const context of error.partial.additionalContexts) {
            this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])
          }
          throw error.cause
        }
      } catch (error: unknown) {
        if (!live.ended) live.abandon()
        throw error
      }
    }
  }

  /** Resolve request config for the step's selection and bind its adapter before admitting model-visible input. */
  private async prepareRequest(
    turn: number,
    step: number,
    selection: Readonly<ModelSelection>,
    signal: AbortSignal,
  ): Promise<{ config: LlmCallConfig; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance seeds output controls from its options until it logs its
    // own header; later steps re-resolve marked defaults.
    const maxTokens = this.options.maxTokens
    const persisted: Partial<LlmCallConfig> = this.requestHeaderLogged
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
      ? requestProposal(session.requestHeader()!)
      : maxTokens === undefined ? {} : { maxTokens }
    const { provider: _provider, model: _model, reasoningEffort: _effort, ...controls } = persisted
    const seedConfig = deepFreeze(structuredClone({ ...controls, ...selection }))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model) {
      throw new Error(`agent "${this.id}": agent/request proposed "${proposedConfig.provider}/${proposedConfig.model}" after step preparation fixed "${selection.provider}/${selection.model}"; use agent.model.select() before step preparation`)
    }
    if (proposedConfig.reasoningEffort !== selection.reasoningEffort) {
      throw new Error(`agent "${this.id}": agent/request proposed reasoning effort "${proposedConfig.reasoningEffort ?? 'adapter default'}" after step preparation fixed "${selection.reasoningEffort ?? 'adapter default'}"; use agent.model.select() before step preparation`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()
    return { config, ...preparedCall === undefined ? {} : { preparedCall } }
  }

  /**
   * Log the resolved envelope and derive a frozen request from the admitted surface. `settle` holds the
   * attempt's last await; `verify` runs synchronously before derivation, so nothing commits between it
   * and freezing. When `verify` reports that history moved after its last check, the attempt is abandoned:
   * the result carries what the restarted attempt needs to treat this attempt's request-series effects as
   * never sent. `carried` is that record from the abandoned attempt, if any.
   */
  private async buildRequest(
    config: LlmCallConfig,
    preparedCall: PreparedLlmCall | undefined,
    tools: GenerateOptions['tools'] & object,
    position: { turn: number; step: number },
    startsRequestSeries: boolean,
    signal: AbortSignal,
    admission: { readonly settle: () => Promise<void>; readonly verify: () => boolean },
    carried?: AbandonedRequest,
  ): Promise<GenerateOptions | AbandonedRequest> {
    const { session } = this
    const surfaceGeneration = session.surface.contentGeneration
    const header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...tools.length > 0 ? { tools } : {},
    })
    // Header, notice and series state before this attempt: no request has carried what an abandoned attempt logged.
    const latest = this.session.requestHeader()
    const baseline = carried === undefined ? latest : carried.baseline
    const startsSeries = startsRequestSeries
      || this.requestSurfaceGeneration !== surfaceGeneration
    const seriesBefore = this.requestSurfaceGeneration
    let headerSeq: SessionSeq | undefined
    if (!this.requestHeaderLogged) {
      // Compaction during the first resumed pre-step must still mark a new series.
      headerSeq = this.session.append('request/header', {
        header,
        reason: latest === undefined ? 'initial' : 'resume',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
      this.requestHeaderLogged = true
    } else if (latest === undefined || !headerEquals(latest, header)) {
      headerSeq = this.session.append('request/header', {
        header,
        reason: 'change',
        ...startsSeries ? { startsSeries: true } : {},
      }).seq
    } else if (startsSeries) {
      this.session.append('request/header', { header, reason: 'series' })
    }
    let noticeSeq: SessionSeq | undefined = carried?.noticeSeq
    let replacedNotice = false
    if (headerSeq !== undefined) {
      const previousNames = new Set(baseline?.tools?.map(tool => tool.name))
      const currentNames = new Set(tools.map(tool => tool.name))
      const additions = baseline === undefined ? [] : tools.filter(tool => !previousNames.has(tool.name))
        .map(tool => ({ type: 'tool-addition' as const, toolName: tool.name }))
      const removals = (baseline?.tools ?? []).filter(tool => !currentNames.has(tool.name))
        .map(tool => ({ type: 'tool-removal' as const, toolName: tool.name }))
      const content = [...additions, ...removals]
      const message = createDeveloperMessage({ source: { kind: 'tool-registry' }, content })
      const data = { ...position, message, ...additions.length > 0 ? { headerSeq } : {} }
      if (carried?.noticeSeq !== undefined) {
        // The abandoned attempt's notice describes a header no request carried: replace it so the
        // restarted request carries only the change from the header the model last saw.
        noticeSeq = session.append('developer/message', data, {
          surfaceOp: { op: 'replace', startSeq: carried.noticeSeq, endSeq: carried.noticeSeq },
          sourceEventSeqs: [carried.noticeSeq],
        }).seq
        replacedNotice = true
      } else if (content.length > 0) {
        noticeSeq = session.append('developer/message', data, { surfaceOp: 'append' }).seq
      }
    }
    // Replacing the abandoned notice is this attempt's own change, not a surface change since a request.
    this.requestSurfaceGeneration = replacedNotice ? session.surface.contentGeneration : surfaceGeneration

    const contextWindow = preparedCall?.context?.contextWindow
    const systemPromptUpdate = preparedCall?.systemPromptUpdate
    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow
      || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    await admission.settle()
    signal.throwIfAborted()
    if (!admission.verify()) {
      return {
        baseline,
        generation: seriesBefore,
        ...headerSeq === undefined ? {} : { headerSeq },
        ...noticeSeq === undefined ? {} : { noticeSeq },
      }
    }

    // canonicalHeader is shallow; append logs a detached snapshot, not these local values.
    deepFreeze(header)
    const boundaryMessages = session.deriveMessages()
    for (const message of boundaryMessages) {
      if (this.frozenMessages.has(message)) continue
      deepFreeze(message)
      this.frozenMessages.add(message)
    }
    Object.freeze(boundaryMessages)
    const request = markAgentLoopRequest(Object.freeze({
      ...header.config,
      messages: boundaryMessages,
      toolHistory: session.toolHistory(),
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    return request
  }
}
