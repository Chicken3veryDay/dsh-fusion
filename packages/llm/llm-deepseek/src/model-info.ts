/** Protocol-independent model capabilities and reasoning choices. */
import { assessSuppliedControls, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CallControlAssessment, LlmCallControls, LlmModelBadge, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './types.ts'

const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const LOW_REASONING_EFFORT = ReasoningEffortId('low')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')
const REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
  {
    id: LOW_REASONING_EFFORT,
    name: 'Low',
    description: 'Prefer for routine or latency-sensitive tasks.',
  },
  {
    id: HIGH_REASONING_EFFORT,
    name: 'High',
    description: 'The default balance for most tasks.',
  },
  {
    id: MAX_REASONING_EFFORT,
    name: 'Max',
    description: 'Reserve for the hardest quality-first tasks.',
  },
] as const
const OFF_ONLY_REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
] as const

/** Advertise one catalog entry.
 * @param provider - registered provider id.
 * @param model - advisory catalog entry.
 * @param badge - selector badge a model listing declares for the entry.
 * @returns selector metadata.
 */
export function catalogModelInfo(provider: string, model: DeepSeekCatalogModel, badge?: LlmModelBadge): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
    ...badge === undefined ? {} : { badge },
  }
}

/** Resolve model capabilities against one configuration generation.
 * @param connection - validated connection facts.
 * @param provider - registered provider id.
 * @param model - requested wire model id.
 * @returns effective model metadata for this operation.
 */
export function modelInfo(
  connection: DeepSeekConnectionOptions,
  provider: string,
  model: string,
): LlmResolvedModelInfo {
  const configured = connection.models.find(entry => entry.id === model)
  const contextWindow = configured?.contextWindow
    ?? connection.defaultContextWindow
  return {
    // An uncatalogued endpoint is safely treated as text-only. Declaring an
    // unverified image capability would let the host persist input that the
    // endpoint may reject on every later turn.
    ...configured === undefined
      ? { provider, id: model, name: model, inputModalities: ['text' as const] }
      : catalogModelInfo(provider, configured),
    context: { contextWindow },
    defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    ...configured?.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: configured.systemPromptUpdate },
    ...configured?.toolUpdate === undefined ? {} : { toolUpdate: configured.toolUpdate },
    ...connection.defaults.thinking === 'disabled'
      ? {
        reasoning: {
          efforts: OFF_ONLY_REASONING_EFFORTS,
          defaultEffort: OFF_REASONING_EFFORT,
        },
      }
      : {
        reasoning: {
          efforts: REASONING_EFFORTS,
          defaultEffort: connection.defaults.reasoningEffort === 'off'
            ? OFF_REASONING_EFFORT
            : connection.defaults.reasoningEffort === 'low'
              ? LOW_REASONING_EFFORT
              : connection.defaults.reasoningEffort === 'max'
                ? MAX_REASONING_EFFORT
                : HIGH_REASONING_EFFORT,
        },
      },
  }
}

/** Assess request controls against the Messages serializer, which sends every one of them.
 * Reasoning effort is validated against {@link modelInfo} before assessment, and a sampling
 * temperature or stop list is forwarded with thinking enabled or disabled.
 * @param controls - the call's controls with model defaults materialized.
 * @returns every supplied control as supported.
 */
export function assessControls(controls: Readonly<LlmCallControls>): CallControlAssessment {
  return assessSuppliedControls(controls, () => ({ kind: 'supported' }))
}
