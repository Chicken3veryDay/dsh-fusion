/** Keyless adapter that records the model-visible tool list and mounted services, then ends the turn. */

import { writeFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const SERVICES = ['tickets', 'workstreams', 'workstreamEvidence', 'agentTeams']

class ToolProbeAdapter extends LlmAdapter {
  constructor(ctx) {
    super()
    this.ctx = ctx
  }

  async * stream(options) {
    const out = process.env.WORKSTREAM_PROBE_OUT
    if (out === undefined) throw new Error('WORKSTREAM_PROBE_OUT must name the probe output file')
    const mounted = Object.fromEntries(SERVICES.map(service => [service, this.ctx.get(service) !== undefined]))
    writeFileSync(out, JSON.stringify({ tools: options.tools.map(tool => tool.name), mounted }))
    const text = 'WORKSTREAM_PROBE_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis plugin name. */
export const name = 'workstream-probe-llm'
/** LLM registry dependency. */
export const inject = ['llm']

/**
 * Register the probe on the shipped default provider route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - fixture context.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new ToolProbeAdapter(ctx))
}
