/** Synthetic external Codex responses; credentials, routes, loop and Script remain real. */
import { zstdDecompressSync } from 'node:zlib'
import { appendFile } from 'node:fs/promises'

let requests = 0
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== 'https://chatgpt.com/backend-api/codex/responses') {
    throw new Error(`Unexpected external request in direct sign-in scenario: ${url}`)
  }
  const headers = new Headers(init?.headers)
  const body = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body).toString('utf8') : init.body
  await appendFile(process.env.DSH_SIGNIN_REQUESTS, JSON.stringify({
    url, authorization: headers.get('authorization'), body: JSON.parse(body),
  }) + '\n')
  const output = ++requests === 1 ? [{
    type: 'function_call', id: 'fc_signin', call_id: 'call_signin', name: 'run_code',
    arguments: JSON.stringify({ description: 'Write the sign-in proof file', code: 'await tools.write({ file_path: "signin-proof.txt", content: "DSH_SCRIPT_EXECUTED\\n" }); console.log("DSH_SCRIPT_EXECUTED");' }),
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
