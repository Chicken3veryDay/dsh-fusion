/** Protocol-independent model capabilities and reasoning choices. */
import { assessSuppliedControls, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { CallControlAssessment, ControlDisposition, LlmCallControls, LlmModelBadge, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PUBLIC_BASE_URL } from './config.ts'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './types.ts'

/** Origin of the official API, the only endpoint whose documented request behavior this adapter asserts. */
const OFFICIAL_ORIGIN = new URL(PUBLIC_BASE_URL).origin
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

/**
 * Assess request controls against one captured connection. The serializer forwards every
 * supplied control, so wire presence is not support: `temperature` is judged by its effect.
 * Reasoning effort is validated against {@link modelInfo} before assessment.
 *
 * The official DeepSeek origin fixes the sampling temperature in thinking mode (Messages guide:
 * "takes effect in non-thinking mode", "fixed at 1.0" in thinking), so a supplied `temperature`
 * with reasoning enabled is `unsupported` as `reasoning-active`. A gateway at any other origin
 * is not known to follow that behavior, so the same call is `unverified` as `protocol-unverified`
 * and still dispatches. With reasoning `off` the field is sent and honored, so it is `supported`.
 * The reasoning mode is the call's effort, falling back to the connection default exactly as
 * the serializer does.
 * @param connection - the captured connection facts of the prepared call's adapter generation.
 * @param controls - the call's controls with model defaults materialized.
 * @returns one disposition for each supplied control.
 */
export function assessControls(connection: DeepSeekConnectionOptions, controls: Readonly<LlmCallControls>): CallControlAssessment {
  return assessSuppliedControls(controls, (control): ControlDisposition => {
    if (control !== 'temperature' || !reasoningEnabled(connection, controls)) return { kind: 'supported' }
    return new URL(connection.baseURL).origin === OFFICIAL_ORIGIN
      ? { kind: 'unsupported', reason: 'reasoning-active' }
      : { kind: 'unverified', reason: 'protocol-unverified' }
  })
}

/** Whether the serializer sends `thinking.type: enabled` for these controls on this connection. */
function reasoningEnabled(connection: DeepSeekConnectionOptions, controls: Readonly<LlmCallControls>): boolean {
  const { defaults } = connection
  return (controls.reasoningEffort ?? defaults.reasoningEffort ?? (defaults.thinking === 'disabled' ? 'off' : 'high')) !== OFF_REASONING_EFFORT
}
