/** External provider fixture returns failures without controlling a browser or desktop. */
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  switch (request.method) {
    case 'server/discover':
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
      break
    case 'initialize':
      reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'failing-provider', version: '1' } })
      break
    case 'tools/list':
      reply({ tools: ['browser_navigate', 'get_desktop_state'].map(name => ({ name, description: 'Fails the requested operation.', inputSchema: { type: 'object', properties: {} } })) })
      break
    case 'tools/call':
      reply({ isError: true, content: [{ type: 'text', text: 'Upstream provider failed' }] })
      break
  }
})
