/**
 * Synthetic external Codex endpoint; the stored sign-in, route, adapter, loop and Script tool stay real.
 * `config.inBandFailure` names a Codex error code that every response instead carries in a
 * `response.failed` frame of a successful stream, with a message that names no code.
 */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const SCRIPT = 'await tools.write({ file_path: "signin-proof.txt", content: "DSH_SCRIPT_EXECUTED\\n" }); console.log("DSH_SCRIPT_EXECUTED");'

export const inject = ['llm']
export function apply(ctx, config = {}) {
  const previousFetch = globalThis.fetch
  let requests = 0
  ctx.effect(() => {
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== ENDPOINT) throw new Error(`Unexpected external request in direct sign-in scenario: ${url}`)
      const headers = new Headers(init?.headers)
      const body = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body).toString('utf8') : init.body
      await appendFile(join(process.env.DSH_HOME, 'codex-requests.jsonl'), JSON.stringify({
        url, authorization: headers.get('authorization'), body: JSON.parse(body),
      }) + '\n')
      requests += 1
      if (config.inBandFailure !== undefined) {
        return new Response([
          { type: 'response.created', response: { id: `resp_${requests}` } },
          { type: 'response.failed', response: { id: `resp_${requests}`, status: 'failed',
            error: { code: config.inBandFailure, message: 'You have hit your usage limit.' } } },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      const output = requests === 1 ? [{
        type: 'function_call', id: 'fc_signin', call_id: 'call_signin', name: 'run_code',
        arguments: JSON.stringify({ description: 'Write the sign-in proof file', code: SCRIPT }),
      }] : [{
        type: 'message', id: 'msg_signin', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Script completed.', annotations: [] }],
      }]
      const events = [
        { type: 'response.created', response: { id: `resp_${requests}` } },
        ...output.flatMap((item, output_index) => [
          { type: 'response.output_item.added', output_index, item },
          { type: 'response.output_item.done', output_index, item },
        ]),
        { type: 'response.completed', response: { id: `resp_${requests}`, status: 'completed', output,
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
      ]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return () => { globalThis.fetch = previousFetch }
  })
}
