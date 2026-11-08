/**
 * Extension and trap for the DeepSeek temperature refusal scenario. The extension
 * proposes `temperature` through the documented `agent/request` waterfall; the real
 * llm-deepseek adapter on the official origin with thinking enabled must refuse it
 * while the turn is prepared, before any credential, header or HTTP work. The trap
 * records, then fails, any outbound request: an empty `deepseek-requests.jsonl` is
 * the proof that none was attempted.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['llm']
export function apply(ctx) {
  const requestLog = join(process.env.DSH_HOME, 'deepseek-requests.jsonl')
  writeFileSync(requestLog, '')
  ctx.effect(() => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const headers = new Headers(init?.headers)
      appendFileSync(requestLog, JSON.stringify({ url, apiKey: headers.get('x-api-key') }) + '\n')
      throw new Error(`Unexpected external request in the DeepSeek temperature scenario: ${url}`)
    }
    return () => { globalThis.fetch = previousFetch }
  }, 'refusal endpoint trap')
  ctx.on('agent/request', async (_event, next) => ({ ...await next(), temperature: 0.3 }))
}
