/**
 * Keyless scripted adapter for the project map composition test. One adapter plays both the working
 * agent and the background curator: a request whose conversation carries the curator prompt follows
 * the curator script, every other request follows the main script. It records, per request, who sent
 * it, the model it used, the tool names, and the conversation size, and it advertises one smaller model
 * so the default curator can pick a cheaper route.
 *
 * Main script: file one note with `context_note`, load the hidden wait tool, wait until the curator
 * filed the note, finish.
 * Curator script: read the map, create a group when there is none, file the pending note, stop.
 */

import { writeFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

const CURATOR_MARKER = 'You are the project map curator'
const SMALL_MODEL = 'curator-small'
const FILE_CALL = 'cm-file'
const NOTE_TEXT = 'Tests run with vitest.'
const WAIT_MS = 60_000
/** Hidden until `context_load` of its group, as the tree profile hides every non-base tool. */
const WAIT_TOOL = 'probe_curator_wait'

const textOf = message => message.content.map(block => block.text ?? '').join('')

/** Resolves when the curator has seen the result of filing the pending note. */
let markFiled
const filed = new Promise((resolve) => { markFiled = resolve })

async function * call(id, name, args) {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function * say(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** The JSON of the newest tool result in a conversation, with its call id. */
function lastResult(messages) {
  const last = messages[messages.length - 1]
  if (last === undefined || last.role !== 'tool') return undefined
  try {
    return { id: last.toolCallId, json: JSON.parse(textOf(last)) }
  } catch {
    return { id: last.toolCallId, json: undefined }
  }
}

class MapScriptAdapter extends LlmAdapter {
  requests = []
  models = new Set([SMALL_MODEL])
  mainSteps = 0

  listModels(provider) {
    return Promise.resolve([...this.models].map(id => ({ provider, id, name: id })))
  }

  resolveModel(provider, model) {
    const small = model === SMALL_MODEL
    const efforts = small ? ['low'] : ['low', 'high']
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: small ? 40_000 : 200_000 },
      reasoning: { efforts: efforts.map(id => ({ id, name: id })), defaultEffort: small ? 'low' : 'high' },
    })
  }

  async * stream(options) {
    const out = process.env.CONTEXT_PROBE_OUT
    if (out === undefined) throw new Error('CONTEXT_PROBE_OUT must name the probe output file')
    const conversation = options.messages.map(textOf).join('\n')
    const curator = conversation.includes(CURATOR_MARKER)
    // The loop's auxiliary requests (session titles) carry no tools; they are not steps of either script.
    const auxiliary = (options.tools ?? []).length === 0
    if (!curator && !auxiliary) this.models.add(options.model)
    this.requests.push({
      curator,
      auxiliary,
      model: options.model,
      effort: options.reasoningEffort ?? null,
      tools: (options.tools ?? []).map(tool => tool.name),
      bytes: conversation.length,
      hasNote: conversation.includes(NOTE_TEXT),
      hasGroupTitle: conversation.includes('Shell tools'),
      hasCuratorText: conversation.includes(CURATOR_MARKER) || conversation.includes('map_view'),
    })
    writeFileSync(out, JSON.stringify(this.requests))
    if (auxiliary) yield * say('Project map probe')
    else yield * (curator ? this.curate(options.messages) : this.work())
  }

  work() {
    this.mainSteps += 1
    if (this.mainSteps === 1) return call('cm-note', 'context_note', { text: NOTE_TEXT, cites: ['ref:package.json test script'] })
    if (this.mainSteps === 2) return call('cm-load', 'context_load', { paths: ['Tools/Global/probe'] })
    if (this.mainSteps === 3) return call('cm-wait', WAIT_TOOL, {})
    return say('MAP_PROBE_OK')
  }

  curate(messages) {
    const result = lastResult(messages)
    if (result === undefined) return call('cm-view-1', 'map_view', {})
    if (result.id === FILE_CALL) {
      markFiled()
      return say('Map is up to date.')
    }
    const view = result.json
    if (view !== undefined && Array.isArray(view.groups) && Array.isArray(view.pending)) {
      if (view.groups.length === 0) {
        return call('cm-group', 'map_group', {
          action: 'set',
          expected_revision: view.revision,
          path: 'Tools/Global/shell',
          title: 'Shell tools',
          summary: 'Use when running commands or builds.',
          tools: ['bash'],
        })
      }
      if (view.pending.length > 0) {
        return call(FILE_CALL, 'map_note', {
          action: 'file',
          expected_revision: view.revision,
          pending_id: view.pending[0].id,
          group_id: view.groups[0].id,
        })
      }
      return say('Nothing to file.')
    }
    return call(`cm-view-${String(this.requests.length)}`, 'map_view', {})
  }
}

/** Cordis plugin name. */
export const name = 'context-map-script-llm'
/** Registry dependencies. */
export const inject = ['llm', 'tools']

/**
 * Register the scripted adapter on the shipped default provider route and the wait tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - fixture context.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new MapScriptAdapter())
  ctx.tools.register(defineTool({
    name: WAIT_TOOL,
    description: 'Wait until the project map curator has filed the pending note.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => {
      const outcome = await Promise.race([
        filed.then(() => 'filed'),
        new Promise(resolve => setTimeout(() => resolve('timeout'), WAIT_MS)),
      ])
      return outcome
    },
  }))
}
