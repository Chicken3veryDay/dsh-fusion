/**
 * Keyless scripted adapter for the post-restart turn: it issues the tool calls listed in
 * `WORKSTREAM_RESTART_SCRIPT` one per model step, then writes every `rs-*` tool result to
 * `WORKSTREAM_RESTART_OUT` and ends the turn.
 */

import { writeFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const PREFIX = 'rs-'

class RestartScriptAdapter extends LlmAdapter {
  /** A declared context window lets the resumed Session switch from its recorded replay model without compaction. */
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000_000 } })
  }

  async * stream(options) {
    const script = JSON.parse(process.env.WORKSTREAM_RESTART_SCRIPT ?? '[]')
    const results = options.messages
      .filter(message => message.role === 'tool' && message.toolCallId.startsWith(PREFIX))
      .map(message => ({ id: message.toolCallId, isError: message.isError, text: message.content.map(block => block.text ?? '').join('') }))
    if (results.length < script.length) {
      const step = script[results.length]
      const id = `${PREFIX}${String(results.length)}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: JSON.stringify(step.arguments) }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: JSON.stringify(step.arguments) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    writeFileSync(process.env.WORKSTREAM_RESTART_OUT, JSON.stringify(results))
    const text = 'WORKSTREAM_RESTART_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis plugin name. */
export const name = 'workstream-restart-script-llm'
/** LLM registry dependency. */
export const inject = ['llm']

/**
 * Register the scripted adapter on the shipped default provider route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - fixture context.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new RestartScriptAdapter())
}
