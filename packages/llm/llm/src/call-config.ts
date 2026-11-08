/**
 * Conversation call configuration and freeze utilities. Provider routing,
 * model, reasoning effort, and sampling values are request-header state that
 * can affect cache reuse; request waterfalls replace them and the loop logs
 * changed snapshots instead of allowing silent per-call drift.
 * @module dsh-llm/call-config
 */

import type { GenerateOptions, LlmControlName, LlmResolvedModelInfo, UnsupportedControlReason } from './types.ts'
import type { ReasoningEffortId } from './brand.ts'

/** Process-local identities of request objects assembled by dsh-agent-loop. */
const AGENT_LOOP_REQUESTS = new WeakSet<GenerateOptions>()

/** Concrete generation settings; omitted controls use the selected route's defaults. */
export interface LlmCallControls {
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

// TODO(call-config-shape): Revisit which fields are epoch-level for cache reuse
// and where provider-specific request options belong.
/**
 * Provider, model, reasoning effort, and sampling scalars of one conversation's
 * requests. Every field maps 1:1 onto the same-named `GenerateOptions` field;
 * the loop builds requests from the logged header rather than accepting these
 * per call.
 */
export interface LlmCallConfig extends LlmCallControls {
  provider: string
  model: string
}

/**
 * Synchronous, pure configuration of one call before defaults and validation.
 * Compose functions in the desired order; later writes replace earlier ones.
 * The returned controls cannot change the captured route. Errors reject
 * preparation before dispatch; only the resolved configuration is recordable.
 * @param controls - detached, deeply frozen proposed controls, without defaults.
 * @param model - detached, deeply frozen metadata from the captured adapter generation.
 * @returns concrete controls; omitted fields receive the route's defaults.
 */
export type ConfigureCall = (
  controls: Readonly<LlmCallControls>,
  model: Readonly<LlmResolvedModelInfo>,
) => LlmCallControls

/**
 * How an adapter generation turns a supplied control into a different wire
 * value. `add-thinking-allowance`: `maxTokens` is an answer allowance and the
 * wire ceiling becomes `maxTokens + thinkingTokens`, with `answerReserve`
 * tokens of that ceiling kept for the answer.
 */
export type ControlTranslation =
  | { readonly kind: 'add-thinking-allowance'; readonly thinkingTokens: number; readonly answerReserve: number }

/**
 * One adapter generation's verdict on one supplied control. `unverified` means
 * the generation cannot establish support from its captured facts; it is
 * neither refused nor advertised as supported.
 */
export type ControlDisposition =
  | { readonly kind: 'supported' }
  | { readonly kind: 'translated'; readonly translations: readonly ControlTranslation[] }
  | { readonly kind: 'unsupported'; readonly reason: UnsupportedControlReason }
  | { readonly kind: 'unverified'; readonly reason: 'account-mode-unresolved' | 'protocol-unverified' | 'adapter-undeclared' }

/** Process-local verdicts on the controls one prepared call supplied; never persisted. */
export interface CallControlAssessment {
  /** One entry per supplied control (a field whose value is not `undefined`). */
  readonly fields: Readonly<Partial<Record<LlmControlName, ControlDisposition>>>
}

/** Every control name, checked against both {@link LlmControlName} and {@link LlmCallControls}. */
const CONTROL_NAME_SET = {
  reasoningEffort: true,
  temperature: true,
  maxTokens: true,
  stop: true,
} as const satisfies Record<LlmControlName, true> & Record<keyof LlmCallControls, true>

/**
 * Build an assessment with one entry per supplied control, so an adapter
 * cannot omit a supplied field and be read as supporting it.
 * @param controls - controls after `ConfigureCall` and model defaults.
 * @param decide - the adapter's verdict for one supplied control.
 * @returns a deep-frozen assessment covering exactly the supplied controls.
 */
export function assessSuppliedControls(
  controls: Readonly<LlmCallControls>,
  decide: (control: LlmControlName) => ControlDisposition,
): CallControlAssessment {
  const fields: Partial<Record<LlmControlName, ControlDisposition>> = {}
  for (const control of Object.keys(CONTROL_NAME_SET) as LlmControlName[]) {
    if (controls[control] !== undefined) fields[control] = Object.freeze(decide(control))
  }
  return Object.freeze({ fields: Object.freeze(fields) })
}

/**
 * Assessment of an adapter that declares nothing about request controls.
 * @param controls - controls after `ConfigureCall` and model defaults.
 * @returns every supplied control `unverified` as `adapter-undeclared`.
 */
export function undeclaredControlAssessment(controls: Readonly<LlmCallControls>): CallControlAssessment {
  return assessSuppliedControls(controls, () => ({ kind: 'unverified', reason: 'adapter-undeclared' }))
}

/**
 * Effective config fields supplied by exact-model adapter resolution rather
 * than by the caller's request proposal.
 */
export interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

/**
 * Field-wise equality over {@link LlmCallConfig} — the comparison a caller
 * runs to decide whether a proposed configuration is a real change (worth a
 * logged header snapshot) or the held one restated.
 * @param a - one configuration.
 * @param b - the other.
 * @returns whether every field (including the `stop` list, element-wise) matches.
 */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens
  ) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

/**
 * Mark one exact request object as assembled by dsh-agent-loop.
 * @param request - loop-owned request envelope before LLM dispatch.
 * @returns the same request object marked as created by the process-local agent loop.
 */
export function markAgentLoopRequest<T extends GenerateOptions>(request: T): T {
  AGENT_LOOP_REQUESTS.add(request)
  return request
}

/**
 * Test whether the exact request object was assembled by dsh-agent-loop.
 * @param request - request envelope observed at the LLM waterfall.
 * @returns whether {@link markAgentLoopRequest} recorded this object.
 */
export function isAgentLoopRequest(request: GenerateOptions): boolean {
  return AGENT_LOOP_REQUESTS.has(request)
}
