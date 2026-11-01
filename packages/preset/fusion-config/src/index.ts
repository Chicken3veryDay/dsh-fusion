/** Opt-in configuration service/provider and human preflight command; no task runtime is initialized. */
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { PiAiAdapter, resolveProfiles, authContextFrom, credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import { ReasoningEffortId, LlmError } from '@deepseek-ai/dsh-llm'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { definitionSchema, FusionConfigError, resolveCatalog } from './catalog.ts'
import type { Binding, ModelDefinition } from './catalog.ts'
import { captureSelection, selectionSchema, shippingSelections } from './selection.ts'
import type { Selection } from './selection.ts'
import { exactMembership, limitsSchema } from './metadata.ts'
import type { Membership } from './metadata.ts'

export { bind, FusionConfigError, shippingCatalog, resolveCatalog } from './catalog.ts'
export type { Binding, ModelDefinition, BindingReference } from './catalog.ts'
export { captureSelection, shippingSelections } from './selection.ts'
export type { Selection, SelectionDefinition } from './selection.ts'
export { exactMembership, metadataEndpoint } from './metadata.ts'
export type { Membership, MetadataLimits, MetadataReceipt } from './metadata.ts'

const declaration = z.strictObject({
  providerId: z.string().min(1), wireModelId: z.string().min(1),
  tools: z.boolean(), structuredDecisions: z.boolean(),
  efforts: z.array(z.enum(['low', 'medium', 'high'])).min(1),
})
const providerSchema = z.strictObject({
  api: z.enum(['openai-responses', 'anthropic-messages']),
  baseURL: definitionSchema.shape.baseURL,
  apiKeyEnv: definitionSchema.shape.credentialRef,
  transport: z.literal('sse'),
  models: z.array(z.strictObject({
    id: z.string().min(1),
    reasoningEfforts: z.strictObject({
      low: z.literal('low').optional(), medium: z.literal('medium').optional(), high: z.literal('high').optional(),
    }).optional(),
    compat: z.strictObject({ forceAdaptiveThinking: z.boolean() }).optional(),
  })),
})
const documentSchema = z.strictObject({
  credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  agentPreset: z.string().min(1),
  providers: z.record(z.string().min(1), providerSchema),
  declarations: z.array(declaration),
  bindings: z.array(definitionSchema),
  selections: z.array(selectionSchema),
  metadataLimits: limitsSchema,
})

/** Loader input; document is strictly parsed once before registrations become visible. */
export interface Config {
  /** Explicit versioned catalog, selections, provider declarations and metadata bounds. */
  document: unknown
}
/** Runtime document parser owns identity validation; schemastery supplies the Loader field. */
export const Config = schema.object({ document: schema.any().required() })

/** One binding's non-inference configuration result. Coverage never follows from an advertisement. */
export interface BindingReadiness {
  readonly binding: Binding
  readonly structural: 'ready' | 'blocked'
  readonly code: 'configured' | 'missing-provider' | 'route-mismatch' | 'unknown-capability' | 'unsupported-capability' | 'unsupported-effort'
    | 'missing-credential' | 'credential-failed' | 'adapter-failed' | 'absent-model' | 'metadata-unknown' | 'cancelled'
  readonly membership?: Membership
}
/** Selection-wide report; runtime safety and frozen integration/benchmark evidence are downstream obligations. */
export interface PreflightReport {
  readonly selection: Selection
  readonly structural: 'ready' | 'blocked'
  readonly agentPreset: 'ready' | 'blocked'
  readonly bindings: readonly (BindingReadiness & { readonly roles: readonly string[] })[]
  readonly coverage: 'live-unverified'
  readonly defaultEligible: false
  readonly productAdmission: 'unavailable-until-runtime-safety-gates'
}

declare module '@deepseek-ai/cordis' {
  interface Context { fusionConfig: FusionConfig }
}

/** Immutable named configuration, pi-ai provider registration and non-inference inspection. */
export class FusionConfig extends Service {
  static inject = ['llm', 'credentials', 'commands', 'agentPresets']
  static Config = Config
  private readonly document: z.infer<typeof documentSchema>
  private readonly catalog: readonly ModelDefinition[]
  private readonly selections = new Map<string, Selection>()
  private readonly profiles: ReturnType<typeof resolveProfiles>
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<PreflightReport>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'fusionConfig')
    const parsed = documentSchema.safeParse(config.document)
    if (!parsed.success) throw new FusionConfigError('invalid-configuration')
    this.document = deepFreeze(parsed.data)
    this.catalog = resolveCatalog(this.document.credentialRef, this.document.bindings)
    try {
      this.profiles = resolveProfiles(Object.fromEntries(Object.entries(this.document.providers).map(([id, profile]) => [id, {
        ...profile,
        models: profile.models.map(model => ({
          id: model.id,
          ...model.reasoningEfforts === undefined ? {} : { reasoningEfforts: {
            ...model.reasoningEfforts.low === undefined ? {} : { low: model.reasoningEfforts.low },
            ...model.reasoningEfforts.medium === undefined ? {} : { medium: model.reasoningEfforts.medium },
            ...model.reasoningEfforts.high === undefined ? {} : { high: model.reasoningEfforts.high },
          } },
          ...model.compat === undefined ? {} : { compat: model.compat },
        })),
      }])))
    } catch (_error) {
      throw new FusionConfigError('invalid-configuration')
    }
    // This consumer owns explicit provider profiles. Inline keys/headers and ambient auth are excluded.
    for (const profile of this.profiles.values()) {
      if (profile.apiKeyEnv === undefined || profile.headers !== undefined || profile.transport === 'auto'
        || (profile.api !== 'openai-responses' && profile.api !== 'anthropic-messages')) {
        throw new FusionConfigError('invalid-configuration')
      }
    }
    const keys = new Set<string>()
    for (const row of this.document.declarations) {
      const key = JSON.stringify([row.providerId, row.wireModelId])
      if (keys.has(key)) throw new FusionConfigError('invalid-configuration')
      keys.add(key)
    }
    for (const definition of [...shippingSelections(this.document.agentPreset), ...this.document.selections]) {
      if (this.selections.has(definition.id)) throw new FusionConfigError('identity')
      this.selections.set(definition.id, captureSelection(this.catalog, definition))
    }
  }

  protected [Service.init](): void {
    const ctx = this.ctx
    const adapter = new PiAiAdapter({
      profiles: () => this.profiles,
      auth: { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) },
      resolveApiKey: async (_provider, profile) => {
        if (profile.apiKeyEnv === undefined) throw new LlmError('Fusion route requires a credential reference', 'MISSING_CREDENTIAL')
        const hit = await ctx.credentials.resolve(profile.apiKeyEnv)
        if (hit === undefined || !hit.value.trim()) throw new LlmError('Fusion route credential is unavailable', 'MISSING_CREDENTIAL')
        return hit.value
      },
    })
    if (this.profiles.size > 0) ctx.llm.registerAdapter([...this.profiles.keys()], adapter)
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.pending])
    }, 'fusion-config.preflight')
    ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-fusion-config/preflight'),
      name: 'fusion_preflight', description: 'Inspect a Fusion selection without invoking a model',
      input: { hint: '<selection>' }, recordInput: false,
      handler: async ({ rawInput, signal }) => {
        const id = rawInput.trim()
        if (!this.selections.has(id)) return { kind: 'error', text: 'Choose a configured selection: /fusion_preflight <selection>. No model was invoked.' }
        const report = await this.preflight(id, signal)
        const issues = report.bindings.filter(row => row.structural === 'blocked').map(row => `${row.binding.presetId}: ${row.code}`)
        const text = [
          `Fusion ${report.selection.id}@${report.selection.revision}: ${report.structural}.`,
          `Agent preset: ${report.agentPreset}.`,
          ...issues,
          'Coverage: live-unverified. Default eligible: false. Runtime safety gates are pending. No model was invoked.',
        ].join('\n')
        return report.structural === 'ready' ? { kind: 'success', text } : { kind: 'error', text }
      },
    })
  }

  /**
   * Read a named frozen selection without network or credential I/O.
   * @param id - exact configured name; unknown names throw a safe configuration error.
   * @returns complete revisioned role map; later Loader replacement cannot mutate it.
   */
  selection(id: string): Selection {
    const selected = this.selections.get(id)
    if (selected === undefined) throw new FusionConfigError('not-found')
    return selected
  }

  /**
   * Inspect current credentials, adapter declarations and complete metadata without inference.
   * @param id - named captured configuration.
   * @param signal - caller cancellation; omission retains plugin disposal and per-listing deadlines.
   * @returns frozen report; failures block readiness, disposal aborts and awaits owned traversal.
   */
  preflight(id: string, signal?: AbortSignal): Promise<PreflightReport> {
    const selection = this.selection(id)
    const cancellation = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    const operation = this.inspect(selection, cancellation)
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }

  private async inspect(selection: Selection, signal: AbortSignal): Promise<PreflightReport> {
    let agentPreset: 'ready' | 'blocked' = 'blocked'
    try { agentPreset = (await this.ctx.agentPresets.resolve(selection.agentPreset)).broken === undefined ? 'ready' : 'blocked' }
    catch (_error) { /* Registry diagnostics are not safe command output; the blocked preset remains visible. */ }
    const grouped = new Map<string, { binding: Binding; roles: string[] }>()
    for (const [role, binding] of [...Object.entries(selection.roles), ...selection.upgrades.map((binding, index): [string, Binding] => [`upgrade:${index + 1}`, binding])]) {
      const key = JSON.stringify(binding)
      const existing = grouped.get(key)
      if (existing === undefined) grouped.set(key, { binding, roles: [role] })
      else existing.roles.push(role)
    }
    const bindings: (BindingReadiness & { roles: string[] })[] = []
    for (const { binding, roles } of grouped.values()) {
      bindings.push({ ...await this.inspectBinding(binding, signal), roles })
    }
    return deepFreeze({
      selection, structural: agentPreset === 'ready' && bindings.every(row => row.structural === 'ready') ? 'ready' : 'blocked',
      agentPreset, bindings, coverage: 'live-unverified', defaultEligible: false,
      productAdmission: 'unavailable-until-runtime-safety-gates',
    })
  }

  private async inspectBinding(binding: Binding, signal: AbortSignal): Promise<BindingReadiness> {
    const blocked = (code: BindingReadiness['code'], membership?: Membership): BindingReadiness => ({
      binding, structural: 'blocked', code, ...membership === undefined ? {} : { membership },
    })
    if (signal.aborted) return blocked('cancelled')
    const profile = this.profiles.get(binding.providerId)
    if (profile === undefined) return blocked('missing-provider')
    if (profile.api !== binding.transport || profile.baseURL !== binding.baseURL || profile.apiKeyEnv !== binding.credentialRef) {
      return blocked('route-mismatch')
    }
    const capabilities = this.document.declarations.find(row =>
      row.providerId === binding.providerId && row.wireModelId === binding.wireModelId)
    if (capabilities === undefined) return blocked('unknown-capability')
    if (!capabilities.tools || !capabilities.structuredDecisions) return blocked('unsupported-capability')
    if (!capabilities.efforts.includes(binding.effort)) return blocked('unsupported-effort')
    // Anthropic dispatch only sends an effort parameter when the materialized model explicitly enables adaptive thinking.
    // A cc/ advertisement or reasoning-level map alone cannot establish that support.
    const model = profile.piProvider?.getModels().find(row => row.id === binding.wireModelId)
    if (model === undefined || (binding.transport === 'anthropic-messages'
      && (model.compat === undefined || !('forceAdaptiveThinking' in model.compat) || !model.compat.forceAdaptiveThinking))) {
      return blocked('unsupported-effort')
    }
    try {
      const resolved = await this.ctx.llm.resolveCallConfig({
        provider: binding.providerId, model: binding.wireModelId, reasoningEffort: ReasoningEffortId(binding.effort),
      }, signal)
      if (resolved.reasoningEffort !== binding.effort) return blocked('unsupported-effort')
    } catch (_error) { return blocked('adapter-failed') }
    let key: string
    try {
      const hit = await this.ctx.credentials.resolve(binding.credentialRef)
      if (hit === undefined || !hit.value.trim()) return blocked('missing-credential')
      key = hit.value
    } catch (_error) { return blocked('credential-failed') }
    const membership = await exactMembership(binding, key, this.document.metadataLimits, signal)
    if (membership.kind === 'unknown') return blocked('metadata-unknown', membership)
    if (membership.kind === 'absent') return blocked('absent-model', membership)
    return { binding, structural: 'ready', code: 'configured', membership }
  }
}

export default FusionConfig
