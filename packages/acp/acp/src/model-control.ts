/** Standard ACP session configuration over one Agent's model selection. */

import type { SessionConfigOption, SessionConfigValueId } from '@agentclientprotocol/sdk'
import { type Model, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig, type LlmRuntime } from '@deepseek-ai/dsh-llm'

const MODEL_CONFIG_ID = 'model'
const REASONING_CONFIG_ID = 'reasoning_effort'
// DSH reasoning effort ids are non-empty, so the empty opaque ACP value is a disjoint provider-default choice.
const PROVIDER_DEFAULT_REASONING_VALUE = ''

interface ModelGroup {
  group: string
  name: string
  options: { value: SessionConfigValueId; name: string; description?: string }[]
}

/** Caller-correctable session configuration failure. */
export class AcpModelConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpModelConfigError'
  }
}

/**
 * Project and mutate one Agent's provider/model/reasoning selection through ACP
 * config options. The Session's recorded model selection is the only selection
 * state, and a change applies from the Agent's next model step. The control
 * also keeps the provider groups of its latest catalog listing, which only
 * shape the option state a mutation returns; they never decide a selection.
 */
export class AcpModelControl {
  private tail = Promise.resolve()
  private hasResolvedState = false
  /** Provider groups from the latest catalog listing, re-projected after a mutation. */
  private listed: ModelGroup[] | undefined

  constructor(
    private readonly llm: LlmRuntime,
    private readonly model: Model,
  ) {}

  /**
   * Return the complete standard config-option state after prior mutations
   * settle. This lists every provider's catalog and retains the result for the
   * state returned by later mutations.
   * @param signal - optional catalog and exact-model cancellation.
   * @returns all current standard configuration options.
   */
  options(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => this.project(await this.list(), signal))
  }

  /**
   * Set one advertised option and return the complete resulting option state.
   * A model value is accepted when it is exactly an opaque value this control
   * produces, for a registered provider whose adapter lets an interface select
   * that model, or when it names the current selection; the check makes no
   * catalog listing for an adapter that answers locally. The returned state
   * re-projects the latest listed catalog rather than listing again, so an
   * accepted change never fails or waits on a listing.
   * @param configId - standard option id.
   * @param value - opaque selected value returned by a previous option state.
   * @param signal - optional selection-check and exact-model cancellation.
   * @returns all standard options after the serialized mutation.
   */
  set(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    return this.serialize(async () => {
      if (typeof value !== 'string') throw new AcpModelConfigError(`${configId} requires a select value`)
      const current = this.model.current()
      if (current === undefined) throw new AcpModelConfigError('this session has no model selection')
      if (configId === MODEL_CONFIG_ID) {
        const selected = await this.selectable(value, current, signal)
        if (selected === undefined) throw new AcpModelConfigError(`unknown model option: ${value}`)
        await this.resolveSelection(selected, signal)
        this.model.select(selected)
      } else if (configId === REASONING_CONFIG_ID) {
        const info = await this.llm.resolveModelInfo(current.provider, current.model, signal)
        const providerDefault = value === PROVIDER_DEFAULT_REASONING_VALUE
          && info.reasoning?.defaultEffort === undefined
        if (
          info.reasoning === undefined
          || (!providerDefault && !info.reasoning.efforts.some(effort => effort.id === value))
        ) {
          throw new AcpModelConfigError(`unknown reasoning effort for ${current.provider}/${current.model}: ${value}`)
        }
        this.model.select(await this.resolveSelection({
          provider: current.provider,
          model: current.model,
          ...providerDefault ? {} : { reasoningEffort: ReasoningEffortId(value) },
        }, signal))
      } else {
        throw new AcpModelConfigError(`unknown session config option: ${configId}`)
      }
      return this.project(this.listed ?? await this.list(), signal)
    })
  }

  /** Keep concurrent client mutations in receive order without wedging after rejection. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Decode one opaque model value and decide whether it may be selected.
   * @returns the selection, or undefined for a value this control would refuse.
   */
  private async selectable(
    value: SessionConfigValueId,
    current: ModelSelection,
    signal: AbortSignal | undefined,
  ): Promise<ModelSelection | undefined> {
    if (value === modelValue(current.provider, current.model)) return { provider: current.provider, model: current.model }
    const route = decodeModelValue(value)
    if (route === undefined || !this.llm.listProviders().some(provider => provider.id === route.provider)) return undefined
    try {
      return await this.llm.canSelectModel(route.provider, route.model, signal) ? route : undefined
    } catch (_selectionUnavailable) {
      // A provider whose selection check fails offers nothing, as its catalog would.
      signal?.throwIfAborted()
      return undefined
    }
  }

  /** List every provider's catalog as option groups and retain them. */
  private async list(): Promise<ModelGroup[]> {
    const groups = await Promise.all(this.llm.listProviders().map(async (provider): Promise<ModelGroup> => {
      try {
        const models = await this.llm.listModels(provider.id)
        return {
          group: provider.id,
          name: provider.name,
          options: models.map(model => ({
            value: modelValue(provider.id, model.id),
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
          })),
        }
      } catch (_providerCatalogUnavailable) {
        return { group: provider.id, name: provider.name, options: [] }
      }
    }))
    this.listed = groups
    return groups
  }

  /** Project listed groups plus the current selection and its reasoning option. */
  private async project(listed: readonly ModelGroup[], signal?: AbortSignal): Promise<SessionConfigOption[]> {
    const selected = this.model.current()
    if (selected === undefined) return []
    let resolved: ModelSelection
    let routeAvailable = true
    try {
      resolved = await this.resolveSelection(selected, signal)
      this.hasResolvedState = true
    } catch (error: unknown) {
      if (!this.hasResolvedState) throw error
      resolved = selected
      routeAvailable = false
    }
    const groups = listed.map(group => ({ ...group, options: [...group.options] }))
    const currentValue = modelValue(resolved.provider, resolved.model)
    if (!groups.some(group => group.options.some(option => option.value === currentValue))) {
      let group = groups.find(item => item.group === resolved.provider)
      if (group === undefined) {
        group = { group: resolved.provider, name: resolved.provider, options: [] }
        groups.push(group)
      }
      group.options.unshift({ value: currentValue, name: resolved.model })
    }
    const options: SessionConfigOption[] = [{
      id: MODEL_CONFIG_ID,
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: groups.filter(group => group.options.length > 0),
    }]
    const info = routeAvailable
      ? await this.llm.resolveModelInfo(resolved.provider, resolved.model, signal)
      : undefined
    if (info?.reasoning !== undefined) {
      options.push({
        id: REASONING_CONFIG_ID,
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: resolved.reasoningEffort === undefined
          ? PROVIDER_DEFAULT_REASONING_VALUE
          : String(resolved.reasoningEffort),
        options: [
          ...info.reasoning.defaultEffort === undefined
            ? [{ value: PROVIDER_DEFAULT_REASONING_VALUE, name: 'Provider default' }]
            : [],
          ...info.reasoning.efforts.map(effort => ({
            value: String(effort.id),
            name: effort.name,
            ...effort.description === undefined ? {} : { description: effort.description },
          })),
        ],
      })
    }
    return options
  }

  /** Validate an exact route and retain only Agent-owned selection fields. */
  private async resolveSelection(selection: ModelSelection, signal?: AbortSignal): Promise<ModelSelection> {
    const resolved: LlmCallConfig = await this.llm.resolveCallConfig(selection, signal)
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    }
  }
}

/** Opaque ACP selector value carrying the full route identity. */
function modelValue(provider: string, model: string): SessionConfigValueId {
  return JSON.stringify([provider, model])
}

/**
 * Decode a value only when it is exactly what {@link modelValue} produces.
 * @param value - the client's opaque selector value.
 * @returns the route it names, or undefined for any other string.
 */
function decodeModelValue(value: string): ModelSelection | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch (_notJson) { return undefined }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined
  const entries: readonly unknown[] = parsed
  const [provider, model] = entries
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  return modelValue(provider, model) === value ? { provider, model } : undefined
}
