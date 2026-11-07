/** ACP projection of a Node PTC `run_code` program: nested tool lifecycles and the whole-program approval request. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

function runCodeResponse(args: object): StreamChunk[] {
  const arguments_ = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('program'), name: 'run_code', argumentsDelta: arguments_ },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('program'), name: 'run_code', arguments: arguments_ } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('ACP run_code programs', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  async function open(options: Parameters<typeof makeBridgeHarness>[0]): Promise<BridgeHarness> {
    harness = await makeBridgeHarness(options)
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Return a deterministic result.',
      parameters: { word: { type: 'string', required: true, description: 'Word to echo.' } },
      execute: args => Promise.resolve([{ type: 'text', text: `echo ${args.word}` }]),
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return harness
  }

  it('shows each nested call as its own tool lifecycle parented to the program call', async () => {
    const h = await open({
      ptc: {},
      script: [
        runCodeResponse({ description: 'Echo twice', code: "await tools.echo({ word: 'a' }); return await tools.echo({ word: 'b' })" }),
        textResponse('done'),
      ],
    })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await vi.waitFor(() => { expect(h.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true) })

    const lifecycle = h.updates.flatMap(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'
      ? [`${update.sessionUpdate}:${update.toolCallId}`]
      : [])
    expect(lifecycle).toEqual([
      'tool_call:program',
      'tool_call:program:ptc:1',
      'tool_call_update:program:ptc:1',
      'tool_call:program:ptc:2',
      'tool_call_update:program:ptc:2',
      'tool_call_update:program',
    ])
    expect(h.updates.find(update => update.sessionUpdate === 'tool_call' && update.toolCallId === 'program:ptc:2')).toMatchObject({
      title: 'echo',
      kind: 'other',
      status: 'in_progress',
      rawInput: { word: 'b' },
      _meta: { 'dsh/parentToolCallId': 'program' },
    })
    expect(h.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'program:ptc:2')).toMatchObject({
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'echo b' } }],
      _meta: { 'dsh/parentToolCallId': 'program' },
    })
    const program = h.updates.find(update => update.sessionUpdate === 'tool_call' && update.toolCallId === 'program')
    expect(program).toMatchObject({ title: 'run_code' })
    expect(program && '_meta' in program).toBe(false)
  })

  it('reports a failed nested call as failed while the program call settles on its own result', async () => {
    const h = await open({
      ptc: {},
      script: [
        runCodeResponse({ description: 'Call a missing tool', code: "try { await tools.echo({}) } catch (error) { return 'caught' }" }),
        textResponse('done'),
      ],
    })
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await vi.waitFor(() => { expect(h.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true) })
    expect(h.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'program:ptc:1'))
      .toMatchObject({ status: 'failed', _meta: { 'dsh/parentToolCallId': 'program' } })
    expect(h.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'program'))
      .toMatchObject({ status: 'completed' })
  })

  it('asks once for the whole program and says which standing mode it widens', async () => {
    const h = await open({
      ptc: { sandboxMode: 'read-only' },
      script: [
        runCodeResponse({
          description: 'Write the report',
          code: "await tools.echo({ word: 'a' }); return await tools.echo({ word: 'b' })",
          sandbox_permissions: 'workspace-write',
          justification: 'The report must be saved in the workspace',
        }),
        textResponse('done'),
      ],
    })
    await h.ctx.plugin(ApprovalService)
    const request = vi.spyOn(h.ctx.approval, 'request')
    h.onPermission = (request) => {
      expect(request.toolCall.toolCallId).toBe('program')
      expect(h.updates.at(-1)).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'program', title: 'run_code' })
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    }
    const { sessionId } = await h.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await h.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await vi.waitFor(() => { expect(h.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true) })

    expect(h.permissionRequests).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'run_code',
      callId: 'program',
      reason: 'escalate sandbox to workspace-write: The report must be saved in the workspace',
      displayReason: { en: 'Allow this operation with workspace-write permissions: The report must be saved in the workspace' },
    })
    expect(h.updates.filter(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId.startsWith('program:ptc:')))
      .toHaveLength(2)
  })
})
