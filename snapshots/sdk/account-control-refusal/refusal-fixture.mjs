/** Propose an account-dependent control through the shipped loop; trap every HTTP request. */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['llm']
export function apply(ctx) {
  const requestLog = join(process.env.DSH_HOME, 'account-requests.jsonl')
  writeFileSync(requestLog, '')
  ctx.effect(() => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => {
      appendFileSync(requestLog, 'unexpected HTTP request\n')
      throw new Error('Unexpected HTTP request during account control refusal')
    }
    return () => { globalThis.fetch = previousFetch }
  }, 'account refusal transport trap')
  ctx.on('agent/request', async (_event, next) => ({ ...await next(), temperature: 0.2 }))
}
