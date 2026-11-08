/**
 * Synthetic Messages endpoint for two Claude subscription accounts. Whichever account the pool asks first is
 * rate-limited; every later request must come from the other account, which serves a Script tool call and then
 * the final text. Stored OAuth, the DSH loop, failover and Script execution remain real.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const ACCOUNTS = new Set(['sk-ant-oat-synthetic-pool-a', 'sk-ant-oat-synthetic-pool-b'])
const SCRIPT = 'await tools.write({ file_path: "pool-proof.txt", content: "DSH_POOL_EXECUTED\\n" }); console.log("DSH_POOL_EXECUTED");'

export const inject = ['llm']
export function apply(ctx) {
  const log = join(process.env.DSH_HOME, 'pool-requests.jsonl')
  writeFileSync(log, '')
  let limitedBearer
  let served = 0
  ctx.effect(() => {
    const previous = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages') throw new Error('Unexpected synthetic pool endpoint')
      const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '')
      if (!ACCOUNTS.has(bearer) || request.headers.has('x-api-key')) throw new Error('A pool account bearer was not used alone')
      limitedBearer ??= bearer
      const role = bearer === limitedBearer ? 'limited' : 'serving'
      const body = await request.json()
      appendFileSync(log, JSON.stringify({
        role,
        endpoint: url.origin + url.pathname,
        bearerAuth: true,
        apiKeyHeader: false,
        model: body.model,
        system: body.system.map(block => block.text),
        tools: body.tools.map(tool => tool.name),
        historyDigest: createHash('sha256').update(JSON.stringify(body.messages)).digest('hex'),
        toolResult: body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result' && JSON.stringify(block.content).includes('DSH_POOL_EXECUTED'))),
      }) + '\n')
      if (role === 'limited') {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), {
          status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' },
        })
      }
      served++
      const tool = body.tools.find(tool => tool.name.toLowerCase() === 'run_code')
      if (!tool) throw new Error('DSH Script tool was not admitted')
      const events = [
        { type: 'message_start', message: { id: `msg_pool_${served}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: served === 1 ? { type: 'tool_use', id: 'toolu_dsh_pool', name: tool.name, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: served === 1 ? { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'Write the pool proof file', code: SCRIPT }) } : { type: 'text_delta', text: 'Pool Script completed.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: served === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    return () => { globalThis.fetch = previous }
  }, 'synthetic Anthropic pool endpoint')
}
