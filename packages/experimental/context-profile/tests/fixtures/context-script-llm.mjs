/**
 * Keyless scripted adapter plus two hidden probe tools. It records the tool declarations and the
 * conversation text of every model request, walks the model through `context_load` of the probe
 * tools, two probe calls, an explicit compaction, then a few small steps and ends the
 * turn.
 */

import { writeFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { modelToolCall, modelToolNames } from '../../../workstream-profile/tests/fixtures/model-tools.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'

const PROBE_TOOLS = ['probe_alpha', 'probe_beta']
/** Model steps 3 through this one browse the tree so a compaction can land between larger messages. */
const BROWSE_STEPS = 9
const SUMMARY_MARKER = 'Output only the checkpoint text'

const textOf = message => message.content.map(block => block.text ?? '').join('')

class ContextScriptAdapter extends LlmAdapter {
  requests = []

  // The generated SDK and the real summary request both fit this synthetic route.
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 20_000 } })
  }

  async * stream(options) {
    const out = process.env.CONTEXT_PROBE_OUT
    if (out === undefined) throw new Error('CONTEXT_PROBE_OUT must name the probe output file')
    const last = options.messages[options.messages.length - 1]
    if (last !== undefined && last.role === 'user' && textOf(last).includes(SUMMARY_MARKER)) {
      const text = 'Checkpoint: the user is probing the context tree.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const conversation = options.messages.map(textOf).join('\n')
    this.requests.push({
      tools: modelToolNames(options),
      wireTools: options.tools.map(tool => tool.name),
      hasCatalog: conversation.includes('<context_tree>'),
      catalogIsUpdate: conversation.includes('replaces any earlier one'),
      hasActivation: conversation.includes('<context-activation>'),
      hasGrant: conversation.includes('<context-grant'),
      hasStub: conversation.includes('tools no longer callable'),
    })
    writeFileSync(out, JSON.stringify(this.requests))
    const step = this.requests.length
    const call = async function * (id, name, args) {
      const call = name === 'run_code' ? { name, arguments: JSON.stringify(args) } : modelToolCall(options, name, args)
      if (call.name === 'run_code' && name === 'context_load' && !modelToolNames(options).includes('probe_alpha')) {
        const input = JSON.parse(call.arguments)
        input.code = [
          "let denied = false; try { await tools.probe_alpha({}) } catch { denied = true }",
          "if (!denied) throw new Error('hidden probe executed')",
          `const loaded = await tools.context_load(${JSON.stringify(args)})`,
          "let stillDenied = false; try { await tools.probe_alpha({}) } catch { stillDenied = true }",
          "if (!stillDenied) throw new Error('current program gained an unadmitted binding')",
          "console.log('hidden-probe-denied'); return loaded",
        ].join('; ')
        call.arguments = JSON.stringify(input)
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    if (step === 1) {
      yield * call('cs-load', 'context_load', { paths: ['Tools/Global/probe'] })
    } else if (step === 2) {
      // A small result leaves the next request available to check SDK cache stability.
      yield * call('cs-probe-small', 'probe_beta', {})
    } else if (step === 3) {
      yield * call('cs-probe', 'probe_alpha', {})
    } else if (step <= BROWSE_STEPS) {
      yield * call(`cs-browse-${String(step)}`, 'context_browse', { path: 'Tools', depth: 1 })
    } else if (step === BROWSE_STEPS + 1 && !modelToolNames(options).includes('probe_alpha')) {
      const code = "let denied = false; try { await tools.probe_alpha({}) } catch { denied = true }; if (!denied) throw new Error('compacted probe executed'); console.log('hidden-probe-denied')"
      yield * call('cs-denied-after-compaction', 'run_code', { code, description: 'Verify compacted probe is unavailable' })
    } else {
      const text = 'CONTEXT_PROBE_OK'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** Cordis plugin name. */
export const name = 'context-script-llm'
/** Registry dependencies. */
export const inject = ['llm', 'tools', 'compaction']

/**
 * Register the scripted adapter on the shipped default provider route and the hidden probe tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - fixture context.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new ContextScriptAdapter())
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next()
    if (step !== 4) return decision
    const nodes = agent.session.surface.nodes
    const start = nodes.find(seq => agent.session.eventAt(seq)?.type !== 'system/message')
    const end = nodes.at(-1)
    if (start === undefined || end === undefined) throw new Error('probe history is absent')
    await ctx.compaction.compactRegion(start, end, { session: agent.session, options: agent.session.requestHeader().config }, signal)
    return decision
  })
  for (const toolName of PROBE_TOOLS) {
    ctx.tools.register(defineTool({
      name: toolName,
      description: `Probe operation ${toolName}.`,
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve(toolName === 'probe_alpha' ? 'bulk filler text '.repeat(6000) : `ran:${toolName}`),
    }))
  }
}
