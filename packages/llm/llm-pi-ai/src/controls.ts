/** Pure assessment of request controls against one captured pi-ai model and profile. */

import { MIN_ANSWER_TOKENS, thinkingBudgetForLevel } from '@earendil-works/pi-ai/api/simple-options'
import type { Api, AnthropicMessagesCompat, AuthResult, Model, ThinkingLevel } from '@earendil-works/pi-ai'
import { assessSuppliedControls } from '@deepseek-ai/dsh-llm'
import type { CallControlAssessment, ControlConstraint, ControlDisposition, LlmCallControls } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from './config.ts'

/**
 * Tokens of the context window pi-ai 1.3.0 keeps free when it lowers an output
 * ceiling to fit the input (`CONTEXT_SAFETY_TOKENS` in its `simple-options`,
 * not exported). `controls.spec.ts` pins this value to the installed bytes.
 */
export const CONTEXT_RESERVE_TOKENS = 4096

/** Smallest output ceiling pi-ai 1.3.0 sends after a context clamp (`MIN_MAX_TOKENS`, not exported). */
export const MINIMUM_WIRE_TOKENS = 1

/**
 * Thinking budget pi-ai 1.3.0 sends when the budget it computed is 0
 * (`thinkingBudgetTokens || 1024` in its Anthropic serializer, not exported).
 * `controls.spec.ts` pins this value to the bytes sent.
 */
export const ZERO_BUDGET_SENDS = 1024

/**
 * Judge each supplied control against the exact model and profile one stream
 * will dispatch with, mirroring what the pi-ai protocol sends. The verdict is
 * logical: it names the conditions the serializer applies, and the final
 * values exist only once messages are serialized.
 *
 * - `stop`: never sent by this adapter, so it is refused.
 * - `reasoningEffort`: already validated against the model's levels; supported.
 * - Anthropic Messages `temperature`: pi-ai omits it while thinking is on and
 *   when the model's compat forbids it; the omission is refused here instead.
 * - Anthropic Messages `maxTokens`: an answer allowance. Budget-based thinking
 *   adds the profile's thinking budget (translated) and caps the sum at the
 *   model's output ceiling, then lowers the thinking budget to leave
 *   {@link MIN_ANSWER_TOKENS} for the answer (a zero budget is sent as
 *   {@link ZERO_BUDGET_SENDS}). Adaptive thinking and reasoning
 *   off send the allowance without the model ceiling. Every Anthropic
 *   allowance is also lowered when the estimated input leaves less than it in
 *   the context window (a `context-window-clamp` constraint).
 * - Every other protocol: `unverified`. The official OpenAI route additionally
 *   depends on the credential mode, which a pure assessment cannot discover.
 * @param model - the captured pi-ai model descriptor.
 * @param profile - the captured route profile.
 * @param controls - the call's controls with model defaults materialized.
 * @returns one disposition per supplied control.
 */
export function assessPiAiControls(
  model: Model<Api>,
  profile: ResolvedPiAiProviderProfile,
  controls: Readonly<LlmCallControls>,
): CallControlAssessment {
  const effort = controls.reasoningEffort ?? profile.reasoning
  const reasoning: ThinkingLevel | undefined = effort === undefined || effort === 'off' ? undefined : effort as ThinkingLevel
  return assessSuppliedControls(controls, (control): ControlDisposition => {
    if (control === 'stop') return { kind: 'unsupported', reason: 'adapter-rejects' }
    if (control === 'reasoningEffort') return { kind: 'supported' }
    if (!isAnthropicMessages(model)) return unverified(model)
    const compat = model.compat ?? {}
    return control === 'temperature' ? anthropicTemperature(compat, reasoning) : anthropicAllowance(model, compat, profile, reasoning)
  })
}

function isAnthropicMessages(model: Model<Api>): model is Model<'anthropic-messages'> {
  return model.api === 'anthropic-messages'
}

function unverified(model: Model<Api>): ControlDisposition {
  return { kind: 'unverified', reason: model.provider === 'openai' ? 'account-mode-unresolved' : 'protocol-unverified' }
}

function anthropicTemperature(compat: AnthropicMessagesCompat, reasoning: ThinkingLevel | undefined): ControlDisposition {
  if (compat.supportsTemperature === false || compat.supportsMidConvoEffort === true) {
    return { kind: 'unsupported', reason: 'model-forbids' }
  }
  return reasoning === undefined ? { kind: 'supported' } : { kind: 'unsupported', reason: 'reasoning-active' }
}

/** The context clamp pi-ai applies; a non-positive window is not clamped at all. */
function contextClamp(model: Model<'anthropic-messages'>): readonly ControlConstraint[] {
  return model.contextWindow > 0
    ? [{
      kind: 'context-window-clamp',
      contextWindow: model.contextWindow,
      reserveTokens: CONTEXT_RESERVE_TOKENS,
      minimumTokens: MINIMUM_WIRE_TOKENS,
    }]
    : []
}

function anthropicAllowance(
  model: Model<'anthropic-messages'>,
  compat: AnthropicMessagesCompat,
  profile: ResolvedPiAiProviderProfile,
  reasoning: ThinkingLevel | undefined,
): ControlDisposition {
  if (reasoning === undefined || compat.forceAdaptiveThinking === true) {
    const constraints = contextClamp(model)
    return constraints.length === 0 ? { kind: 'supported' } : { kind: 'supported', constraints }
  }
  return {
    kind: 'translated',
    translations: [{
      kind: 'add-thinking-allowance',
      thinkingTokens: thinkingBudgetForLevel(reasoning, profile.thinkingBudgets),
      answerReserve: MIN_ANSWER_TOKENS,
      zeroBudgetSends: ZERO_BUDGET_SENDS,
    }],
    constraints: [{ kind: 'model-output-ceiling', maxTokens: model.maxTokens }, ...contextClamp(model)],
  }
}

/**
 * Finalize Responses controls using the authentication dispatch will apply.
 * Only the exact official endpoint and non-API key combination triggers
 * pi-ai's session omission. Legacy allowances retain floor and context-clamp
 * behavior and remain protocol-unverified rather than claiming an exact cap.
 * @param model - captured protocol descriptor.
 * @param controls - resolved controls before request admission.
 * @param assessment - pure verdicts, already checked for refusal.
 * @param auth - detached effective authentication, kept private to preparation.
 * @returns detached nonsecret final verdicts; missing authentication stays unverified.
 */
export function finalizeOpenAiControls(
  model: Model<Api>,
  controls: Readonly<LlmCallControls>,
  assessment: CallControlAssessment,
  auth: AuthResult | undefined,
): CallControlAssessment {
  const key = auth?.auth.apiKey
  const session = model.provider === 'openai' && (auth?.auth.baseUrl || model.baseUrl) === 'https://api.openai.com/v1'
    && key !== undefined && !key.startsWith('sk-')
  return assessSuppliedControls(controls, (control) => {
    if (control !== 'temperature' && control !== 'maxTokens') return assessment.fields[control] ?? { kind: 'unverified', reason: 'adapter-undeclared' }
    if (key === undefined) return { kind: 'unverified', reason: 'account-mode-unresolved' }
    if (session) return { kind: 'unsupported', reason: 'account-omits' }
    return control === 'temperature' ? { kind: 'supported' } : { kind: 'unverified', reason: 'protocol-unverified' }
  })
}
