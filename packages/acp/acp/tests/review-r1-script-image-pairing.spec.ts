/** Nested ACP lifecycles still need a terminal update if supplemental image delivery fails. */
import { expect, it, onTestFinished } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { makeBridgeHarness, textResponse } from './harness.ts'

it.each([false, true])('settles a nested image tool when attachment reading fails: %s', async (readFails) => {
  const h = await makeBridgeHarness({
    ptc: {}, imageCapable: true,
    script: [
      toolCallResponse('program', 'run_code', {
        code: "await tools.image({}); return 'done'", description: 'Read one image',
      }),
      textResponse('finished'),
    ],
  })
  onTestFinished(() => h.dispose())
  const attachments = h.attachments!
  const image = await attachments.saveImage({ data: Uint8Array.of(1), mediaType: 'image/png' })
  h.ctx.tools.register(defineContentToolFixture({
    name: 'image', description: 'Return a stored image.', parameters: {},
    execute: () => Promise.resolve([{ type: 'image', attachment: image }]),
  }))
  if (readFails) attachments.beforeRead = async () => { throw new Error('review fixture: image storage unavailable') }
  await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  const result = await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
  expect(result.stopReason).toBe('end_turn')
  expect(h.updates.find(update => update.sessionUpdate === 'tool_call' && update.toolCallId === 'program:ptc:1')).toBeDefined()
  expect(h.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'program')).toMatchObject({ status: 'completed' })
  const terminal = h.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'program:ptc:1')
  expect(terminal, 'every emitted nested tool_call must receive its terminal tool_call_update').toBeDefined()
  if (!readFails) expect(terminal).toMatchObject({
    status: 'completed', content: [{ type: 'content', content: { type: 'image', data: 'AQ==', mimeType: 'image/png' } }],
  })
})

it('settles a cancelled nested tool before completing its enclosing ACP prompt', async () => {
  const entered = Promise.withResolvers<undefined>()
  const h = await makeBridgeHarness({
    ptc: {}, script: [toolCallResponse('program', 'run_code', {
      code: 'await tools.hold({})', description: 'Wait for cancellation',
    })],
  })
  onTestFinished(() => h.dispose())
  h.ctx.tools.register(defineContentToolFixture({
    name: 'hold', description: 'Wait for cancellation.', parameters: {},
    execute: (_args, exec) => new Promise((_resolve, reject) => {
      const abort = () => { reject(new Error('nested operation cancelled')) }
      exec.signal.addEventListener('abort', abort, { once: true })
      if (exec.signal.aborted) abort()
      entered.resolve(undefined)
    }),
  }))
  await h.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  const prompt = h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
  try {
    await entered.promise
    await h.client.cancel({ sessionId })
    expect((await prompt).stopReason).toBe('cancelled')
    expect(h.updates.filter(update => update.sessionUpdate === 'tool_call_update').map(update => update.toolCallId))
      .toEqual(['program:ptc:1', 'program'])
    expect(h.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'program:ptc:1'))
      .toMatchObject({ status: 'failed', _meta: { 'dsh/parentToolCallId': 'program' } })
  } finally {
    await h.client.cancel({ sessionId })
    await prompt
  }
})
