/**
 * Extension and traps for the DeepSeek default-catalog refusal scenario. The extension
 * proposes `temperature` through the documented `agent/request` waterfall, which is the
 * final control selection. Everything the traps see is appended to `deepseek-work.jsonl`
 * under the phase it happened in: `startup` until the extension returns its controls, then
 * `refusal`. Session startup may legitimately discover the model listing, so the scenario
 * pins that startup work explicitly and requires the `refusal` phase to be empty. The trap
 * serves the official listing from memory and fails every other outbound request.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LISTING_URL = 'https://api.deepseek.com/models'
const LISTING = {
  object: 'list',
  data: [{
    id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1_048_576, max_output_tokens: 393_216,
    input_modalities: ['text'], output_modalities: ['text'], api_capabilities: { anthropic_messages: {} },
  }],
}

export const inject = ['llm', 'credentials']
export function apply(ctx) {
  const workLog = join(process.env.DSH_HOME, 'deepseek-work.jsonl')
  writeFileSync(workLog, '')
  let phase = 'startup'
  const record = entry => appendFileSync(workLog, JSON.stringify({ phase, ...entry }) + '\n')
  ctx.effect(() => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      record({ kind: 'http', method: request.method, url: request.url, authenticated: request.headers.has('x-api-key') })
      if (request.method === 'GET' && request.url === LISTING_URL) {
        return new Response(JSON.stringify(LISTING), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected external request in the DeepSeek default-catalog scenario: ${request.method} ${request.url}`)
    }
    return () => { globalThis.fetch = previousFetch }
  }, 'default-catalog endpoint trap')
  ctx.effect(() => {
    const credentials = ctx.get('credentials')
    const resolve = credentials.resolve.bind(credentials)
    credentials.resolve = async (ref) => {
      record({ kind: 'credential', ref })
      return resolve(ref)
    }
    return () => { credentials.resolve = resolve }
  }, 'credential read trace')
  ctx.on('agent/request', async (_event, next) => {
    const request = { ...await next(), temperature: 0.3 }
    phase = 'refusal'
    return request
  })
}
