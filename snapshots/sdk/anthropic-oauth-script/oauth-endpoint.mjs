/** Synthetic Messages endpoint; stored OAuth, the DSH loop and Script execution remain real. */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCRIPT = 'await tools.write({ file_path: "oauth-proof.txt", content: "DSH_OAUTH_EXECUTED\\n" }); console.log("DSH_OAUTH_EXECUTED");'

export const inject = ['llm']
export function apply(ctx) {
  const log = join(process.env.DSH_HOME, 'oauth-requests.jsonl')
  writeFileSync(log, '')
  let calls = 0
  ctx.effect(() => {
    const previous = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages') throw new Error('Unexpected synthetic OAuth endpoint')
      if (request.headers.get('authorization') !== 'Bearer sk-ant-oat-synthetic-dsh' || request.headers.has('x-api-key')) throw new Error('OAuth-only authentication was not retained')
      const body = await request.json()
      const system = body.system.map(block => block.text)
      appendFileSync(log, JSON.stringify({
        endpoint: url.origin + url.pathname,
        bearerAuth: true,
        apiKeyHeader: false,
        clientHeader: request.headers.get('user-agent')?.startsWith('claude-cli/') === true,
        model: body.model,
        system,
        tools: body.tools.map(tool => tool.name),
        toolResult: body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result' && JSON.stringify(block.content).includes('DSH_OAUTH_EXECUTED'))),
      }) + '\n')
      calls++
      const tool = body.tools.find(tool => tool.name.toLowerCase() === 'run_code')
      if (!tool) throw new Error('DSH Script tool was not admitted')
      const events = [
        { type: 'message_start', message: { id: `msg_oauth_${calls}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: calls === 1 ? { type: 'tool_use', id: 'toolu_dsh_oauth', name: tool.name, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: calls === 1 ? { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'Write the OAuth proof file', code: SCRIPT }) } : { type: 'text_delta', text: 'OAuth Script completed.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: calls === 1 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    return () => { globalThis.fetch = previous }
  }, 'synthetic Anthropic OAuth endpoint')
}
