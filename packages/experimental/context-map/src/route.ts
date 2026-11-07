/**
 * Cheap-route selection for the default curator. The LLM catalog carries no price, so "cheap" is
 * the strictest proxy it does carry: among the parent provider's models whose context window
 * fits curator work, the smallest window at that model's least reasoning effort; the choice must
 * also undercut the parent's own route on window or effort, otherwise no route is cheap.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm/types'
import type { ResolvedCuratorConfig } from './config.ts'
import { ContextMapError } from './error.ts'
import type { MapRoute } from './types.ts'

/** Catalog reads route selection needs; `ctx.llm` satisfies it. */
export interface RouteCatalog {
  listModels(provider: string): Promise<readonly { readonly id: string }[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

/** The part of an agent that route selection reads; any `Agent` satisfies it. */
export interface RouteParent {
  readonly model: { current(): ReturnType<Agent['model']['current']> }
}

/** The selected route and the evidence behind the choice. */
export interface CuratorRouteChoice {
  readonly route: MapRoute
  /** Context window of the chosen model in tokens. */
  readonly contextWindow: number
  /** Models inspected, for the report when selection fails. */
  readonly inspected: number
}

function effortIndex(info: LlmResolvedModelInfo, effort: string | undefined): number {
  const efforts = info.reasoning?.efforts ?? []
  const wanted = effort ?? info.reasoning?.defaultEffort
  const index = wanted === undefined ? -1 : efforts.findIndex(entry => entry.id === wanted)
  return index === -1 ? Math.max(efforts.length - 1, 0) : index
}

/**
 * Choose the cheapest adequate route of the parent's provider.
 * @param llm - model catalog.
 * @param parent - the agent whose provider and route bound the choice.
 * @param config - route bounds.
 * @param signal - cancellation.
 * @returns the route, with its context window.
 * @throws {@link ContextMapError} `CONTEXT_MAP_NO_CHEAP_ROUTE` when the parent has no route, the catalog is empty
 * or too small, or no adequate model undercuts the parent's route.
 */
export async function selectCuratorRoute(
  llm: RouteCatalog,
  parent: RouteParent,
  config: ResolvedCuratorConfig,
  signal?: AbortSignal,
): Promise<CuratorRouteChoice> {
  const current = parent.model.current()
  if (current === undefined) {
    throw new ContextMapError('The agent has no model route to choose a cheaper curator route beside', 'CONTEXT_MAP_NO_CHEAP_ROUTE')
  }
  signal?.throwIfAborted()
  const catalog = llm.listModels(current.provider)
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal?.reason) }
  signal?.addEventListener('abort', onAbort, { once: true })
  let models: readonly { readonly id: string }[]
  try {
    // Promise.race observes late catalog rejection after cancellation; this read has no owned mutations.
    models = (await Promise.race([catalog, aborted.promise])).slice(0, config.maxRoutesInspected)
    signal?.throwIfAborted()
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  const own = await llm.resolveModelInfo(current.provider, current.model, signal)
  const ownWindow = own.context?.contextWindow ?? Number.POSITIVE_INFINITY
  const ownEffort = effortIndex(own, current.reasoningEffort)
  let best: { info: LlmResolvedModelInfo; window: number } | undefined
  for (const model of models) {
    signal?.throwIfAborted()
    const info = model.id === current.model ? own : await llm.resolveModelInfo(current.provider, model.id, signal)
    const window = info.context?.contextWindow
    if (window === undefined || window < config.minContextTokens) continue
    if (best === undefined || window < best.window) best = { info, window }
  }
  // The chosen route runs at its least effort, so it is cheaper than the parent's route when its
  // window is smaller, or equal with the parent running above its own least effort.
  const undercuts = best !== undefined && (best.window < ownWindow || (best.window === ownWindow && ownEffort > 0))
  if (best === undefined || !undercuts) {
    throw new ContextMapError(
      `No cheap curator route: ${models.length} ${current.provider} models inspected, none with at least `
      + `${config.minContextTokens} context tokens that undercuts ${current.provider}/${current.model}; `
      + 'claim the curator role with another agent, or add a smaller route',
      'CONTEXT_MAP_NO_CHEAP_ROUTE',
    )
  }
  const least = best.info.reasoning?.efforts[0]
  return {
    route: {
      provider: current.provider,
      model: best.info.id,
      ...least === undefined ? {} : { reasoningEffort: least.id },
    },
    contextWindow: best.window,
    inspected: models.length,
  }
}
