/** A result image the attachment store cannot read becomes a notice; the tool lifecycle still terminates with its own outcome. */
import { expect, it, onTestFinished } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ACP_UNAVAILABLE_IMAGE_NOTICE } from '../src/updates.ts'
import { makeBridgeHarness, textResponse } from './harness.ts'

it.each([
  { executor: 'native', call: toolCallResponse('direct', 'image', {}), toolCallId: 'direct' },
  {
    executor: 'run_code',
    call: toolCallResponse('program', 'run_code', { code: "await tools.image({}); return 'done'", description: 'Read one image' }),
    toolCallId: 'program:ptc:1',
  },
] as const)('replaces an unreadable result image with a notice and keeps the other blocks ($executor)', async ({ executor, call, toolCallId }) => {
  const h = await makeBridgeHarness({ ...executor === 'run_code' ? { ptc: {} } : {}, imageCapable: true, script: [call, textResponse('finished')] })
  onTestFinished(() => h.dispose())
  const attachments = h.attachments!
  const image = await attachments.saveImage({ data: Uint8Array.of(1), mediaType: 'image/png' })
  h.ctx.tools.register(defineContentToolFixture({
    name: 'image', description: 'Return a stored image.', parameters: {},
    execute: () => Promise.resolve([{ type: 'text', text: 'caption' }, { type: 'image', attachment: image }]),
  }))
  attachments.beforeRead = () => Promise.reject(new Error('fixture: image storage unavailable'))
  await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  expect((await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })).stopReason).toBe('end_turn')
  expect(h.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === toolCallId)).toMatchObject({
    status: 'completed',
    content: [
      { type: 'content', content: { type: 'text', text: 'caption' } },
      { type: 'content', content: { type: 'text', text: ACP_UNAVAILABLE_IMAGE_NOTICE } },
    ],
  })
})
