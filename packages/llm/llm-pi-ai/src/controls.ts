/** Pure assessment of request controls against one captured pi-ai model and profile. */

import { MIN_ANSWER_TOKENS, thinkingBudgetForLevel } from '@earendil-works/pi-ai/api/simple-options'
import type { Api, AnthropicMessagesCompat, Model, ThinkingLevel } from '@earendil-works/pi-ai'
import { assessSuppliedControls } from '@deepseek-ai/dsh-llm'
import type { CallControlAssessment, ControlDisposition, LlmCallControls } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from './config.ts'

/**
 * Judge each supplied control against the exact model and profile one stream
 * will dispatch with, mirroring what the pi-ai protocol sends.
 *
 * - `stop`: never sent by this adapter, so it is refused.
 * - `reasoningEffort`: already validated against the model's levels; supported.
 * - Anthropic Messages `temperature`: pi-ai omits it while thinking is on and
 *   when the model's compat forbids it; the omission is refused here instead.
 * - Anthropic Messages `maxTokens`: an answer allowance. Budget-based thinking
 *   adds the profile's thinking budget to the wire ceiling (translated);
 *   adaptive thinking and reasoning off send it unchanged (supported).
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
    return control === 'temperature' ? anthropicTemperature(compat, reasoning) : anthropicAllowance(compat, profile, reasoning)
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

function anthropicAllowance(
  compat: AnthropicMessagesCompat,
  profile: ResolvedPiAiProviderProfile,
  reasoning: ThinkingLevel | undefined,
): ControlDisposition {
  if (reasoning === undefined || compat.forceAdaptiveThinking === true) return { kind: 'supported' }
  return {
    kind: 'translated',
    translations: [{
      kind: 'add-thinking-allowance',
      thinkingTokens: thinkingBudgetForLevel(reasoning, profile.thinkingBudgets),
      answerReserve: MIN_ANSWER_TOKENS,
    }],
  }
}
