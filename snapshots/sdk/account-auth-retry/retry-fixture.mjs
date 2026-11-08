/** Real OAuth refresh fails once; the shipped retry plugin prepares a fresh authenticated request. */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['llm']
export function apply(ctx) {
  const log = join(process.env.DSH_HOME, 'auth-requests.jsonl')
  writeFileSync(log, '')
  let refreshes = 0
  ctx.effect(() => {
    const previous = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const body = await request.text()
      if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
        const fields = new URLSearchParams(body)
        if (fields.get('grant_type') !== 'refresh_token' || fields.get('client_id') !== 'synthetic-issued-client' || fields.get('refresh_token') !== 'synthetic-refresh') throw new Error('Unexpected synthetic refresh fields')
        refreshes++
        appendFileSync(log, JSON.stringify({ kind: 'refresh', attempt: refreshes }) + '\n')
        return refreshes === 1
          ? new Response('Synthetic sign-in service unavailable', { status: 503 })
          : Response.json({ access_token: 'sk-synthetic-fresh-binding', refresh_token: 'synthetic-refreshed-grant', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' })
      }
      if (request.url !== 'https://api.openai.com/v1/responses') throw new Error(`Unexpected synthetic request: ${request.url}`)
      const payload = JSON.parse(body)
      if (request.headers.get('authorization') !== 'Bearer sk-synthetic-fresh-binding' || payload.temperature !== 0.2 || refreshes !== 2) throw new Error('Request did not use the fresh binding')
      appendFileSync(log, JSON.stringify({ kind: 'inference', refreshes, temperature: payload.temperature, model: payload.model }) + '\n')
      const item = { type: 'message', id: 'msg_auth_retry', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Authentication retry completed.', annotations: [] }] }
      const events = [
        { type: 'response.created', response: { id: 'resp_auth_retry' } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_auth_retry', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
      ]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    return () => { globalThis.fetch = previous }
  }, 'synthetic authentication transport')
  ctx.on('agent/request', async (_event, next) => ({ ...await next(), temperature: 0.2 }))
}
