import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import ToolResultPruner, { PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ACP_CONTEXT_PROJECTION_KEY, type AcpContextState } from '../src/context.ts'
import { TestCleanup } from './cleanup.ts'
import { errorResponse, makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'recovery-test': { kind: 'recovery-test' } & ContextFormed
  }
}

const cleanup = new TestCleanup()
afterEach(async () => { await cleanup.run() })

const textOf = (message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
  message.content.map(block => block.text ?? '').join('')
const isPacket = (message: Parameters<typeof textOf>[0]): boolean => textOf(message).includes('ACP automation context')

async function startSession(harness: BridgeHarness): Promise<string> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

const userMessages = (events: readonly SessionEvent[]): { seq: number; message: UserMessage }[] =>
  events.flatMap(event => event.type === 'user/message' ? [{ seq: event.seq, message: event.data }] : [])
const packetsOf = (events: readonly SessionEvent[]) => userMessages(events).filter(({ message }) => message.source.kind === 'acp-context')
const inputsOf = (events: readonly SessionEvent[]) =>
  userMessages(events).filter(({ message }) => message.source.kind === 'user' && 'input' in message.source)

describe('transient provider failure', () => {
  it('retries the same request under one input pointer and one packet', async () => {
    const harness = cleanup.adopt(await makeBridgeHarness({ script: [errorResponse('transient boom'), textResponse('recovered')] }))
    let retried = false
    harness.ctx.on('agent/request-error', () => {
      if (retried) return undefined
      retried = true
      return Promise.resolve({ kind: 'retry' as const })
    })
    const sessionId = await startSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    expect(harness.adapter.requests).toHaveLength(2)
    const events = harness.ctx.agents.get(SessionId(sessionId))!.session.snapshotEvents()
    const [input] = inputsOf(events)
    expect(inputsOf(events)).toHaveLength(1)
    expect(packetsOf(events)).toHaveLength(1)
    for (const request of harness.adapter.requests) {
      expect(request.messages.filter(message => textOf(message) === 'go')).toHaveLength(1)
      const packets = request.messages.filter(isPacket)
      expect(packets).toHaveLength(1)
      expect(textOf(packets[0]!)).toContain(`Latest client input: message ${input!.message.id}; its exact text is in this conversation`)
    }
  })
})

describe('cold process restart', () => {
  it('resumes in a new process from the persisted log and moves the pointer only on the next tagged input', async () => {
    const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-acp-cold-'))
    cleanup.defer(async () => { await rm(persistenceRoot, { recursive: true, force: true }) })
    const first = await makeBridgeHarness({ persistenceRoot, script: [textResponse('before')] })
    const sessionId = await startSession(first)
    await first.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'before restart' }] })
    await first.client.closeSession({ sessionId })
    await first.dispose()

    const second = cleanup.adopt(await makeBridgeHarness({ persistenceRoot, script: [textResponse('after')] }))
    await second.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await second.client.resumeSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    const session = second.ctx.agents.get(SessionId(sessionId))!.session
    const recovered = second.ctx.sessionProjections.checkpoint(session)[ACP_CONTEXT_PROJECTION_KEY]!.val as AcpContextState
    const [original] = inputsOf(session.snapshotEvents())
    expect(recovered.latestInput?.id).toBe(original!.message.id)
    expect(recovered.packet?.text).toContain(`message ${original!.message.id}`)

    await second.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'after restart' }] })
    const events = session.snapshotEvents()
    const inputs = inputsOf(events)
    expect(inputs.map(({ message }) => textOf(message))).toEqual(['before restart', 'after restart'])
    expect(packetsOf(events).map(({ message }) => message.source.kind === 'acp-context' ? message.source.latestInput : undefined))
      .toEqual([inputs[0]!.message.id, inputs[1]!.message.id])
    expect(second.adapter.requests[0]!.messages.filter(isPacket)).toHaveLength(2)
  })
})

describe('projection checkpoints for a cold read', () => {
  /** One real two-prompt ACP session, its log, and the registry that folds it. */
  async function recordedSession() {
    const harness = cleanup.adopt(await makeBridgeHarness({ script: [textResponse('one'), textResponse('two')] }))
    const sessionId = await startSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'first input' }] })
    const session = harness.ctx.agents.get(SessionId(sessionId))!.session
    const firstTurnEnd = session.snapshotEvents().findLast(event => event.type === 'turn/end')!.seq
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'second input' }] })
    const registry = harness.ctx.sessionProjections
    const events = session.snapshotEvents()
    const none = SessionLogOffset(0)
    const full = registry.checkpoint(session)[ACP_CONTEXT_PROJECTION_KEY]!
    /** Rows a store would hold had it checkpointed after the first prompt. */
    const earlier = registry.restore({}, events.slice(0, firstTurnEnd + 1), none, session.header, none).checkpoint
    return { registry, session, events, full, earlier, none, firstTurnEnd }
  }

  it('refolds only the tail over a valid row and reaches the state a full fold reaches', async () => {
    const { registry, session, events, full, earlier, none } = await recordedSession()
    expect(earlier[ACP_CONTEXT_PROJECTION_KEY]!.seq).toBeLessThan(full.seq)
    const floor = registry.restoreFloor(earlier)!
    expect(floor).toBeGreaterThan(0)
    const restored = registry.restore(earlier, events.slice(floor), floor, session.header, none).checkpoint
    expect(restored[ACP_CONTEXT_PROJECTION_KEY]).toEqual(full)
  })

  it('refolds from the start when the row is missing, and refuses a tail-only read that cannot rebuild it', async () => {
    const { registry, session, events, full, earlier, none, firstTurnEnd } = await recordedSession()
    const { [ACP_CONTEXT_PROJECTION_KEY]: _missing, ...others } = earlier
    expect(registry.restoreFloor(others)).toBe(0)
    expect(registry.restore(others, events, none, session.header, none).checkpoint[ACP_CONTEXT_PROJECTION_KEY]).toEqual(full)
    const tailOnly = SessionLogOffset(firstTurnEnd + 1)
    expect(() => registry.restore(others, events.slice(tailOnly), tailOnly, session.header, none)).toThrow()
  })

  it('discards an incompatible-version, malformed, or past-the-end row and never serves it as the pointer', async () => {
    const { registry, session, events, full, earlier, none, firstTurnEnd } = await recordedSession()
    const row = earlier[ACP_CONTEXT_PROJECTION_KEY]!
    const tailOnly = SessionLogOffset(firstTurnEnd + 1)
    const incompatible = { ...earlier, [ACP_CONTEXT_PROJECTION_KEY]: { ...row, ver: row.ver + 1 } }
    expect(registry.restoreFloor(incompatible)).toBe(0)
    expect(registry.restore(incompatible, events, none, session.header, none).checkpoint[ACP_CONTEXT_PROJECTION_KEY]).toEqual(full)

    const malformed = { ...earlier, [ACP_CONTEXT_PROJECTION_KEY]: { ...row, val: { latestInput: 'not-a-reference', packet: 7 } } }
    expect(() => registry.restore(malformed, events.slice(tailOnly), tailOnly, session.header, none)).toThrow()
    const rebuilt = registry.restore(malformed, events, none, session.header, none).checkpoint[ACP_CONTEXT_PROJECTION_KEY]
    expect(rebuilt).toEqual(full)

    const pastEnd = { ...earlier, [ACP_CONTEXT_PROJECTION_KEY]: { ...row, seq: events.length + 100 } }
    expect(registry.restore(pastEnd, events, none, session.header, none).checkpoint[ACP_CONTEXT_PROJECTION_KEY]).toEqual(full)
  })
})

describe('pruned tool results', () => {
  it('leaves the packet and input pointer untouched, where compaction of the input rebuilds the packet', async () => {
    const harness = cleanup.adopt(await makeBridgeHarness({
      script: [toolCallResponse('bulk-1', 'bulky', {}), textResponse('first done'), textResponse('autonomous done')],
      beforeAcp: async (ctx) => { await ctx.plugin(ToolResultPruner, { thresholdChars: 400, headChars: 40, tailChars: 20 }) },
    }))
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'bulky', description: 'Return a long result.', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'x'.repeat(2000) }]),
    }))
    const sessionId = await startSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'run the bulky tool' }] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const [input] = inputsOf(agent.session.snapshotEvents())
    const [packet] = packetsOf(agent.session.snapshotEvents())

    const { pruned } = harness.ctx.toolResultPruner.pruneSession(agent.session)
    expect(pruned).toHaveLength(1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'carry on' }], source: { kind: 'recovery-test' } }))
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    expect(packetsOf(events).map(({ seq }) => seq)).toEqual([packet!.seq])
    const last = harness.adapter.requests.at(-1)!.messages
    expect(last.some(message => textOf(message).includes(PRUNE_MARKER.trim()))).toBe(true)
    expect(last.filter(message => textOf(message) === 'run the bulky tool')).toHaveLength(1)
    const packets = last.filter(isPacket)
    expect(packets).toHaveLength(1)
    expect(textOf(packets[0]!)).toContain(`message ${input!.message.id}; its exact text is in this conversation`)
    const state = harness.ctx.sessionProjections.checkpoint(agent.session)[ACP_CONTEXT_PROJECTION_KEY]!.val as AcpContextState
    expect(state.latestInput?.id).toBe(input!.message.id)
  })
})
