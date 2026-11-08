/**
 * Extension and trap for the refusal scenario. The extension proposes `stop`
 * through the documented `agent/request` waterfall; the real llm-pi-ai Codex
 * route cannot send it, so preparation must refuse before any credential,
 * header or HTTP work. The trap records, then fails, any outbound request: an
 * empty `codex-requests.jsonl` is the proof that none was attempted.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['llm']
export function apply(ctx) {
  const requestLog = join(process.env.DSH_HOME, 'codex-requests.jsonl')
  writeFileSync(requestLog, '')
  ctx.effect(() => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const headers = new Headers(init?.headers)
      appendFileSync(requestLog, JSON.stringify({ url, authorization: headers.get('authorization') }) + '\n')
      throw new Error(`Unexpected external request in the refusal scenario: ${url}`)
    }
    return () => { globalThis.fetch = previousFetch }
  }, 'refusal endpoint trap')
  ctx.on('agent/request', async (_event, next) => ({ ...await next(), stop: ['END'] }))
}
