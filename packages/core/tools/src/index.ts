/** Tool definitions and scoped dispatch to plugin-owned executors. @module */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import { ToolExecutorUnavailableError } from './executor.ts'
import type { ToolExecutor, ToolBatchInput, ToolBatchResult, ToolInvocation } from './executor.ts'
import { executeToolBatch } from './batch.ts'
import { ToolExecutionPipeline } from './pipeline.ts'
import './events.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { projectToolSchema } from './schema.ts'
import { assertSupportedJsonSchema } from './json-schema.ts'
import { RUN_CODE_NAME, ToolActivationError, ToolAdmissionError } from './contracts.ts'
import type {
  ToolDefinition, ToolRestriction, ToolExecution, ToolGuard,
  ResolvedToolSet, ToolActivationContext, ToolAdmissionDecision, ToolAdmissionPolicy, ToolOrigin, ToolRegistrationOptions,
  RegisteredTool, ToolExecutionResult, ToolRegistrationHandle,
} from './contracts.ts'

declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Step-owned tool selection; absent when inspecting registered definitions. */
    toolSet?: ResolvedToolSet
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Tool availability changes supplied by the tool registry. */
    'tool-registry': { kind: 'tool-registry' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
  }
}

/** One restriction compiled at registration for repeated live-global lookup. */
interface CompiledToolRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/** One registered definition and its step-time activation condition; the object is its public {@link RegisteredTool} identity. */
interface ToolRegistration extends RegisteredTool {
  readonly when: ToolRegistrationOptions['when']
  readonly origin: ToolOrigin
}

/** One scope's complete registry view, derived in a single layer traversal. */
interface ToolView {
  /** Visible definitions after restrictions, scoped shadowing, and inherited restrictions. */
  readonly visible: ReadonlyMap<string, ToolDefinition>
  /** Registrations behind {@link visible}, keyed by the same names. */
  readonly registrations: ReadonlyMap<string, ToolRegistration>
  /** Pre-restriction capability names used by prompt-order validation. */
  readonly knownNames: ReadonlySet<string>
  /** Current global names that a scoped restriction may name. */
  readonly restrictableNames: ReadonlySet<string>
}

/** One scope's complete tool-registry contribution. */
class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolRegistration>
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()

  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    return this.tools.isEmpty() && this.restrictions.isEmpty()
  }

  /** Whether every compiled restriction in this layer admits a global tool name. */
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

}

interface Registration {
  executor: ToolExecutor | undefined
}

class GuardLayer {
  readonly guards = new AnonymousEntries<ToolGuard>()
  isEmpty(): boolean { return this.guards.isEmpty() }
}

/**
 * Read a policy decision as kept names plus an optional declaration sequence. A string is itself
 * iterable but names no tool list, so it fails like any other non-collection result.
 */
function readAdmissionDecision(decision: ToolAdmissionDecision): { kept: Set<string>; ordered: boolean } {
  if (Object(decision) !== decision) {
    throw new TypeError(`policy returned ${typeof decision}; return an array, a set, an iterator of tool names, or orderedAdmission(names)`)
  }
  if (Symbol.iterator in decision) return { kept: new Set(decision), ordered: false }
  return { kept: new Set(decision.ordered), ordered: true }
}

class AdmissionLayer {
  readonly policies = new AnonymousEntries<ToolAdmissionPolicy>()
  isEmpty(): boolean { return this.policies.isEmpty() }
}

/** Concrete tool registry and scoped executor dispatcher. */
export class ToolsService extends Service {
  static inject = ['systemPrompt']
  static Config = z.object({
    mode: z.never().description('Removed. Mount a native or PTC tool executor instead.'),
    maxParallelSubCalls: z.never().description('Moved to the PTC tool executor configuration.'),
  })

  private readonly layers = new ScopedLayers(scope => new ToolLayer(scope), () => { this.ctx.emit('tools/change') })
  private readonly scoped = new WeakMap<ScopeKey, Registration>()
  private root: Registration | undefined
  private readonly guards = new ScopedLayers(() => new GuardLayer(), () => {})
  private readonly admission = new ScopedLayers(() => new AdmissionLayer(), () => { this.ctx.emit('tools/change') })
  /** Pipeline for {@link invoke}, created on first use because it reads this service from the context. */

  constructor(ctx: Context) {
    super(ctx, 'tools')
    ctx.systemPrompt.tools(({ scope, toolSet }) => {
      const executor = this.selectExecutor(scope)
      const description = executor.describe(this.definitions(scope, toolSet))
      return {
        ...description,
        knownNames: description.knownNames ?? [...this.view(scope).knownNames],
        ...toolSet?.ordered === true ? { ordered: true } : {},
      }
    })
  }


  /**
   * Register globally or in the calling agent scope. Scoped tools shadow
   * globals; duplicates within one layer and the reserved `run_code` name fail.
   * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
   * @param options - optional step-time activation condition and the producer-recorded origin;
   * a registration without an origin reads back as `unknown`.
   * @returns the exact disposer that unregisters the tool, carrying the registration's identity.
   */
  register(definition: ToolDefinition, options: ToolRegistrationOptions = {}): ToolRegistrationHandle {
    const name = definition.name
    const output = (definition as Partial<ToolDefinition>).output
    if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    assertSupportedJsonSchema(output.schema)
    const timeoutMs = definition.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
    }
    // Reserved unconditionally: any agent may select a code mode for itself,
    // so a name free to take under the deployment default would become a
    // collision the moment a preset mounted.
    if (name === RUN_CODE_NAME) {
      throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`)
    }
    const registration: ToolRegistration = Object.freeze({ definition, when: options.when, origin: options.origin ?? 'unknown' })
    const dispose = this.layers.effect(
      this.ctx,
      layer => layer.tools.insert(name, registration),
      { label: 'tools.register()' },
    )
    return Object.assign(dispose, { registration })
  }

  /**
   * Restrict global tools for the calling agent scope. Empty filters, unknown
   * names, scope-local names, and reserved transport names fail. Restrictions
   * intersect; scoped registrations remain visible.
   * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the exact disposer that lifts this restriction.
   */
  restrict(filter: ToolRestriction): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
      throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`)
    }
    const known = this.view(scope).restrictableNames
    const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.restrictions.append(compiled),
      { label: 'tools.restrict()' },
    )
  }

  /**
   * Register a policy that may hide admitted tools from the calling scope's
   * agents on each step, after every tool's own `when` condition. Policies only
   * remove tools, compose by intersection (global policies first, then the
   * scope chain from the farthest ancestor, each layer in registration order),
   * and see the candidates earlier policies kept. A policy that returns
   * {@link orderedAdmission} also sets the declaration sequence: the last such
   * policy's sequence orders the surviving tools, which is the order of
   * declarations and of `definitions()`. Plain returns never reorder, so with no
   * ordering policy the admitted set keeps registration order. A policy that
   * throws or names a non-candidate fails step preparation as
   * `TOOL_ADMISSION_FAILED`. Hidden tools are absent from declarations and
   * rejected at dispatch, including nested PTC calls; while a policy applies to a scope, a call
   * without a step selection executes nothing. With no policy
   * registered, admission is unchanged.
   * @param policy - removal-only decision, optionally ordered, evaluated during resolution and validation.
   * @returns the exact disposer; later steps see the tools again.
   */
  registerAdmissionPolicy(policy: ToolAdmissionPolicy): () => void {
    return this.admission.effect(
      this.ctx,
      layer => layer.policies.append(policy),
      { label: 'tools.registerAdmissionPolicy()' },
    )
  }

  /**
   * Resolve visible tools and pre-restriction names. Restrictions across the
   * scope chain intersect over inherited global and ancestor tools; the viewing
   * scope's own registrations remain exempt. Nearer registrations shadow
   * farther ones. Pre-restriction names support restriction and prompt-order validation.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @returns the complete derived view for that scope.
   */
  private view(scope?: ScopeKey): ToolView {
    const layers = this.layers.chainLayers(scope)
    const own = this.layers.peek(scope)
    const inherited = new Map(this.layers.global.tools.entries())
    for (const layer of layers) {
      if (layer === own) continue
      for (const [name, registration] of layer.tools.entries()) inherited.set(name, registration)
    }
    const visible = new Map<string, ToolDefinition>()
    const registrations = new Map<string, ToolRegistration>()
    const knownNames = new Set<string>()
    const restrictableNames = new Set<string>()
    for (const [name, registration] of inherited) {
      knownNames.add(name)
      restrictableNames.add(name)
      if (layers.every(layer => layer.admits(name))) {
        visible.set(name, registration.definition)
        registrations.set(name, registration)
      }
    }
    if (own !== undefined) {
      for (const [name, registration] of own.tools.entries()) {
        knownNames.add(name)
        visible.set(name, registration.definition)
        registrations.set(name, registration)
      }
    }
    return { visible, registrations, knownNames, restrictableNames }
  }

  /**
   * Look up a tool as one scope sees it (scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param toolSet - step admission; omit only to inspect registered definitions.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition | undefined {
    return toolSet === undefined ? this.view(scope).visible.get(name) : toolSet.view(scope).get(name)
  }

  /**
   * Read where a visible registration came from.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns the origin the producer recorded; `unknown` when it recorded none or no registration of that name is visible.
   */
  originOf(name: string, scope?: ScopeKey): ToolOrigin {
    return this.view(scope).registrations.get(name)?.origin ?? 'unknown'
  }

  /**
   * Resolve the definition a call may execute. With a step's admitted set, the
   * set decides; without one, conditional registrations are unavailable, and so is every tool
   * while an admission policy applies to the scope, because a policy needs a step to run.
   * @param name - the tool name as registered.
   * @param scope - the calling agent; omitted = the global view.
   * @param toolSet - step admission, or omitted for a call outside a model step.
   * @returns the executable definition, or undefined when the call must fail as `UNKNOWN_TOOL`.
   */
  executable(name: string, scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolDefinition | undefined {
    if (toolSet !== undefined) return toolSet.view(scope).get(name)
    if (this.hasAdmissionPolicy(scope)) return undefined
    const view = this.view(scope)
    return view.registrations.get(name)?.when === undefined ? view.visible.get(name) : undefined
  }

  /**
   * Check a retained definition before body invocation without resolving a name again.
   * @param definition - exact definition accepted before execution policy.
   * @param scope - calling agent; omitted checks the global scope.
   * @param toolSet - step admission; omitted requires an unconditional registration and no admission policy.
   * @returns whether this definition remains admitted and visible to the caller.
   */
  isExecutable(definition: ToolDefinition, scope?: ScopeKey, toolSet?: ResolvedToolSet): boolean {
    if (toolSet !== undefined) return [...toolSet.view(scope).values()].includes(definition)
    if (this.hasAdmissionPolicy(scope)) return false
    const view = this.view(scope)
    return [...view.visible.values()].includes(definition)
      && [...view.registrations.values()].some(registration => registration.definition === definition && registration.when === undefined)
  }

  /** Whether a global policy or one in the scope's chain would run when this scope resolves a step. */
  private hasAdmissionPolicy(scope: ScopeKey | undefined): boolean {
    return !this.admission.global.isEmpty() || this.admission.chainLayers(scope).some(layer => !layer.isEmpty())
  }

  /**
   * Resolve conditions once for this step without changing shared registrations,
   * then narrow the result by the registered admission policies.
   * Cancellation, a rejected condition, or a failing policy publishes no partial
   * selection. Removed registrations cannot be restored by a late condition result.
   * @param context - preparing agent, captured model selection, and cancellation.
   * @returns the complete selection; the caller disposes it after its tool batch settles.
   */
  async resolve(context: ToolActivationContext): Promise<ResolvedToolSet> {
    const { agent, signal } = context
    signal.throwIfAborted()
    const view = this.view(agent)
    const evaluate = async () => {
      const admitted = new Map<string, ToolDefinition>()
      for (const [name, definition] of view.visible) {
        const registration = view.registrations.get(name)
        let enabled: boolean
        try {
          enabled = registration?.when === undefined || await registration.when(context)
        } catch (cause: unknown) {
          signal.throwIfAborted()
          throw new ToolActivationError(name, cause)
        }
        signal.throwIfAborted()
        if (enabled) admitted.set(name, definition)
      }
      const ordered = await this.applyAdmissionPolicies(context, admitted)
      return { admitted, ordered }
    }
    const { admitted, ordered } = await evaluate()
    let closed = false
    const checkRegistrations = (): void => {
      signal.throwIfAborted()
      const current = this.view(agent)
      if (closed || [...admitted.keys()].some(name =>
        current.registrations.get(name) !== view.registrations.get(name))) {
        throw new ToolAdmissionError(new Error('Tool registrations changed during request reconciliation; retry the turn'))
      }
    }
    return Object.freeze({
      dispose: () => { closed = true },
      ordered,
      validate: async (): Promise<void> => {
        checkRegistrations()
        const checked = await evaluate()
        checkRegistrations()
        const entries = [...checked.admitted]
        if (checked.ordered !== ordered || entries.length !== admitted.size
          || [...admitted].some(([name, definition], index) => {
            const entry = entries[index]
            return entry?.[0] !== name || entry[1] !== definition
          })) {
          throw new ToolAdmissionError(new Error('Tool admission did not settle after request reconciliation; retry the turn'))
        }
      },
      view: (scope: ScopeKey | undefined): ReadonlyMap<string, ToolDefinition> => {
        const visible = new Map<string, ToolDefinition>()
        if (closed || scope !== agent) return visible
        const current = this.view(agent)
        for (const [name, definition] of admitted) {
          if (current.visible.get(name) === definition
            && current.registrations.get(name) === view.registrations.get(name)) {
            visible.set(name, definition)
          }
        }
        return visible
      },
    })
  }

  /**
   * Narrow the admitted set by each registered policy in order, then order it by the
   * last policy that returned an ordered decision. Policies are snapshotted when
   * evaluation starts; a rejection or an unknown name fails preparation, and
   * cancellation takes precedence over either. Every name that survives the
   * ordering policy is in its sequence, because later policies only remove.
   * @param context - preparing agent, captured model selection, and cancellation.
   * @param admitted - candidates after `when`; narrowed in place, in registration order unless a policy ordered it.
   * @returns whether a policy ordered the survivors.
   */
  private async applyAdmissionPolicies(context: ToolActivationContext, admitted: Map<string, ToolDefinition>): Promise<boolean> {
    const { signal } = context
    const policies = [this.admission.global, ...this.admission.chainLayers(context.agent)]
      .flatMap(layer => [...layer.policies.values()])
    let sequence: readonly string[] | undefined
    for (const policy of policies) {
      let kept: Set<string>
      try {
        const decision = await policy({ ...context, candidates: new Map(admitted) })
        const read = readAdmissionDecision(decision)
        kept = read.kept
        if (read.ordered) sequence = [...kept]
        const unknown = [...kept].filter(name => !admitted.has(name))
        if (unknown.length > 0) {
          throw new TypeError(`policy named ${unknown.map(name => `"${name}"`).join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not an admitted candidate; policies may only remove tools`)
        }
      } catch (cause: unknown) {
        signal.throwIfAborted()
        throw new ToolAdmissionError(cause)
      }
      signal.throwIfAborted()
      for (const name of [...admitted.keys()]) if (!kept.has(name)) admitted.delete(name)
    }
    if (sequence === undefined) return false
    const definitions = new Map(admitted)
    admitted.clear()
    for (const name of sequence) {
      const definition = definitions.get(name)
      if (definition !== undefined) admitted.set(name, definition)
    }
    return true
  }

  /**
   * Read the visible capability definitions for descriptions and program bindings.
   * @param scope - viewing Agent or preset; omitted selects the global view.
   * @param toolSet - step admission; omit only to inspect registered definitions.
   * @returns definitions after scoped shadowing and restrictions, limited to the step's admission when given.
   */
  definitions(scope?: ScopeKey, toolSet?: ResolvedToolSet): readonly ToolDefinition[] {
    return toolSet === undefined ? [...this.view(scope).visible.values()] : [...toolSet.view(scope).values()]
  }

  /**
   * Project visible definitions onto the allowlisted model-facing schema fields,
   * excluding execution and presentation callbacks.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @param toolSet - step admission, or omitted for registered-definition inspection.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey, toolSet?: ResolvedToolSet): ToolSchema[] {
    return this.definitions(scope, toolSet).map(definition => projectToolSchema(definition, true))
  }
  /**
   * Provide the executor for the calling scope; an unscoped contribution is the deployment default.
   * Rendering any executor-owned section requires the viewing scope's selection to remain available.
   * @param executor - initialized provider owned by the contributing plugin.
   * @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
   */
  setExecutor(executor: ToolExecutor): () => void {
    const scope = scopeOf(this.ctx)
    const existing = scope === undefined ? this.root : this.scoped.get(scope)
    if (existing?.executor !== undefined) throw new Error('Only one tool executor may be registered in each scope')
    const record: Registration = { executor }
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; preserve the Cordis disposer identity
    return this.ctx.effect(function* (this: ToolsService) {
      for (const section of executor.sections ?? []) {
        yield this.ctx.systemPrompt.section({
          name: section.name,
          order: section.order,
          ...section.interpolate === undefined ? {} : { interpolate: section.interpolate },
          text: ({ scope, toolSet }) => {
            if (this.selectExecutor(scope) !== executor) return ''
            return typeof section.text === 'function' ? section.text(this.definitions(scope, toolSet)) : section.text
          },
        })
      }
      if (scope === undefined) this.root = record
      else this.scoped.set(scope, record)
      yield () => {
        // Keep an unavailable selection so a program cannot fall through to a different executor.
        record.executor = undefined
      }
    }.bind(this), 'tools.setExecutor()')
  }

  /**
   * Resolve the nearest scoped provider, or the deployment default.
   * @param scope - Agent or preset scope; omitted selects only the root contribution.
   * @returns the selected executor; throws when it is missing or unloaded.
   */
  selectExecutor(scope?: ScopeKey): ToolExecutor {
    let record: Registration | undefined
    for (const key of scopeChainOf(scope)) {
      record = this.scoped.get(key)
      if (record !== undefined) break
    }
    record ??= this.root
    const executor = record?.executor
    if (executor === undefined) throw new ToolExecutorUnavailableError()
    return executor
  }

  /**
   * Delegate a raw call batch to its Agent's provider or the deployment default.
   * Select at dispatch; accepted batches settle through that provider even if it unloads.
   * @param input - original calls, optional owning Agent, optional logging step, and optional step `toolSet`.
   * @returns the selected executor's settled batch; unavailable selections reject.
   */
  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return this.selectExecutor(input.agent).execute(input)
  }

  /**
   * Run one call to a registration a host component holds (an MCP, browser, or computer-use
   * bridge running its own provider tool for an interaction). This is not the model's dispatch
   * route: no name is resolved, so a same-named registration elsewhere, including a scoped shadow,
   * is never reached; admission policies do not apply, because they decide what a model step may
   * call; and the selected executor's model-call rules, such as PTC's `run_code`-only direct calls,
   * do not apply. The call still passes the shared pipeline: the registration must be live and
   * visible to the agent under its restrictions and must be unconditional, and pre-execute policy,
   * guards, cancellation, the execute and post-execute wrappers, and result normalization run as for
   * any call. The approval service and the `tools/*` pipeline listeners are those of the invoking
   * context, so a host component in an isolated realm is decided by that realm's approval. No
   * `tool/call` or `tool/result` Session event is committed.
   * @param input - the retained registration, its arguments, correlation id, cancellation, and agent.
   * @returns the settled result; a registration that is gone, restricted away, or conditional fails as `UNKNOWN_TOOL`.
   * @throws {ToolBatchExecutionError} when the pipeline fails internally after draining.
   */
  async invoke(input: ToolInvocation): Promise<ToolExecutionResult> {
    const { registration, agent, signal, callId } = input
    const toolSet = this.invocationSelection(registration)
    // Each call builds its pipeline from the invoking context, so approval and pipeline listeners
    // resolve in the caller's realm; nothing per-caller outlives the call.
    const pipeline = new ToolExecutionPipeline(this.ctx)
    const batch = await executeToolBatch({
      calls: [{ type: 'tool-call', id: callId, name: registration.definition.name, arguments: JSON.stringify(input.arguments) }],
      signal, toolSet, ...agent === undefined ? {} : { agent },
    }, pipeline, () => 1)
    const settled = batch.results[0]
    /* v8 ignore next -- executeToolBatch settles exactly one result per call */
    if (settled === undefined) throw new Error('tool invocation settled no result')
    return settled.result
  }

  /**
   * Build the one-registration selection {@link invoke} runs under. Its view holds the retained
   * definition only while that exact registration object is still in a layer the scope's chain
   * reads, every restriction in the chain admits it (the scope's own registrations are exempt, as
   * in {@link view}), and it has no `when` condition. A same-named entry is never substituted.
   * @param registration - the identity the host component retained.
   * @returns a selection with nothing to dispose.
   */
  private invocationSelection(registration: RegisteredTool): ResolvedToolSet {
    const { definition } = registration
    const name = definition.name
    return Object.freeze({
      dispose: (): void => undefined,
      // Host invocations bypass step admission and recheck registration identity at body start.
      validate: async (): Promise<void> => {},
      view: (scope: ScopeKey | undefined): ReadonlyMap<string, ToolDefinition> => {
        const own = this.layers.peek(scope)
        const chain = this.layers.chainLayers(scope)
        const holder = [this.layers.global, ...chain].find(layer => layer.tools.get(name) === registration)
        const entry = holder?.tools.get(name)
        const visible = entry !== undefined && entry.when === undefined
          && (holder === own || chain.every(layer => layer.admits(name)))
        return visible ? new Map([[name, definition]]) : new Map()
      },
    })
  }

  /**
   * Register a monotonic denial in the calling scope.
   * @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
   * @returns the effect disposer that removes this guard.
   */
  guard(guard: ToolGuard): () => void {
    return this.guards.effect(this.ctx, layer => layer.guards.append(guard), { label: 'tools.guard()' })
  }

  /**
   * Check global and inherited guards after pre-execute policy and approval resolve.
   * @param exec - invocation whose guards are checked before dispatch.
   * @returns the first denial reason, or undefined when no guard denies.
   */
  checkGuards(exec: ToolExecution): string | undefined {
    for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)]) {
      for (const guard of layer.guards.values()) {
        const reason = guard(exec)
        if (reason !== undefined) return reason
      }
    }
    return undefined
  }

}

export default ToolsService

export * from './contracts.ts'
export * from './executor.ts'
export * from './schema.ts'
export * from './json-schema.ts'
export * from './presentation.ts'
export { ToolsService as ToolRuntime }
