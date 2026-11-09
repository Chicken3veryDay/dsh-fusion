import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import GoalService from '@deepseek-ai/dsh-goal'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-test': { kind: 'context-test' } & ContextFormed
  }
}

async function newSession(harness: BridgeHarness): Promise<string> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

const textOf = (message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
  message.content.map(block => block.text ?? '').join('')

function eventsOf(harness: BridgeHarness, sessionId: string): SessionEvent[] {
  const agent = harness.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error('missing agent')
  return agent.session.snapshotEvents()
}

function userMessages(events: readonly SessionEvent[]): { seq: SessionEvent['seq']; message: UserMessage }[] {
  return events.flatMap(event => event.type === 'user/message' ? [{ seq: event.seq, message: event.data }] : [])
}

const packetsOf = (events: readonly SessionEvent[]) =>
  userMessages(events).filter(({ message }) => message.source.kind === 'acp-context')

describe('ACP recipient, latest-input, and state context', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('declares the recipient and names the exact admitted input on an ordinary unseeded session', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('done')] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    expect(agent.session.header.isSeeded).not.toBe(true)
    const prompt = 'You are the reviewer now. Review only. Never edit files.'
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: prompt }] })

    const events = eventsOf(harness, sessionId)
    const inputs = userMessages(events).filter(({ message }) => message.source.kind === 'user')
    expect(inputs).toHaveLength(1)
    const input = inputs[0]!.message
    expect(input.source).toEqual({ kind: 'user', input: { kind: 'acp' } })
    expect(input.content).toEqual([{ type: 'text', text: prompt }])

    const packets = packetsOf(events)
    expect(packets).toHaveLength(1)
    const packet = packets[0]!.message
    expect(packet.source).toMatchObject({
      kind: 'acp-context', form: 'snapshot', recipient: 'acp-automation', session: sessionId, latestInput: input.id,
    })
    expect(textOf(packet)).toContain('Recipient: ACP automation')
    expect(textOf(packet)).toContain(`Latest client input: message ${input.id}`)
    expect(textOf(packet)).not.toContain('reviewer')
    expect(packets[0]!.seq).toBeGreaterThan(inputs[0]!.seq)

    // The frozen request carries exactly the logged input and packet bytes, input first.
    const request = harness.adapter.requests[0]!.messages
    expect(request.at(-2)?.content).toEqual(input.content)
    expect(request.at(-1)?.content).toEqual(packet.content)
    expect(request.filter(message => textOf(message).includes('ACP automation context'))).toHaveLength(1)
  })

  it('moves the latest-input reference on a later independent input without repeating, revoking, or creating a goal', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('one'), textResponse('two')] })
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Never touch the production database.' }] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Now summarize the README.' }] })

    const events = eventsOf(harness, sessionId)
    const inputs = userMessages(events).filter(({ message }) => message.source.kind === 'user').map(({ message }) => message)
    const packets = packetsOf(events).map(({ message }) => message)
    expect(inputs).toHaveLength(2)
    expect(packets.map(packet => packet.source.kind === 'acp-context' ? packet.source.latestInput : undefined))
      .toEqual([inputs[0]!.id, inputs[1]!.id])
    expect(events.some(event => event.type === 'goal/change')).toBe(false)
    // The earlier restriction stays in the second request unchanged.
    const second = harness.adapter.requests[1]!.messages
    expect(second.some(message => textOf(message) === 'Never touch the production database.')).toBe(true)
    expect(textOf(second.at(-1)!)).toContain(inputs[1]!.id)
    expect(textOf(second.at(-1)!)).toContain('does not replace or expire any earlier instruction')
  })

  it('keeps the pointer through a tool continuation without a second packet', async () => {
    harness = await makeBridgeHarness({ script: [toolCallResponse('probe-1', 'probe', {}), textResponse('after tool')] })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'probe', description: 'Return a fixed value.', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'probed' }]),
    }))
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'probe it' }] })

    expect(harness.adapter.requests).toHaveLength(2)
    const events = eventsOf(harness, sessionId)
    expect(packetsOf(events)).toHaveLength(1)
    const continuation = harness.adapter.requests[1]!.messages
    expect(continuation.filter(message => textOf(message).includes('ACP automation context'))).toHaveLength(1)
  })

  it('reports an unknown latest input and tags nothing for non-ACP input, and states absent services as unavailable', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('ok')] })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'autonomous work' }], source: { kind: 'context-test' } }))
    await agent.whenIdle()

    const [packet] = packetsOf(eventsOf(harness, sessionId))
    expect(textOf(packet!.message)).toContain('Latest client input: unknown')
    expect(textOf(packet!.message)).toContain('Goal: unavailable (no goal service is mounted).')
    expect(packet!.message.source).toMatchObject({ latestInput: null })
    expect(userMessages(eventsOf(harness, sessionId)).some(({ message }) => message.source.kind === 'user')).toBe(false)
  })

  it('reads the goal after every other provider settles, so a change during collection reaches the dispatched packet', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('ok')] })
    await harness.ctx.plugin(GoalService)
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    // Registered before the session exists, like a plugin loaded ahead of it: it wraps the ACP provider and settles last.
    harness.ctx.on('system-prompt/request-context', async (_context, _pending, next) => {
      const added = await next()
      reached.resolve(undefined)
      await release.promise
      return added
    })
    const sessionId = await newSession(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const prompting = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'state changes mid-collection' }] })
    await reached.promise
    ;(harness.ctx.get('goals') as GoalService).create(agent, { objective: 'ship the slice' })
    release.resolve(undefined)
    await prompting

    const [packet] = packetsOf(eventsOf(harness, sessionId))
    expect(textOf(packet!.message)).toContain('Goal: active, round 0 of 256; the objective is supplied by the goal itself.')
    expect(textOf(packet!.message)).not.toContain('ship the slice')
    const dispatched = harness.adapter.requests[0]!.messages.filter(message => textOf(message).includes('ACP automation context'))
    expect(dispatched.map(textOf)).toEqual([textOf(packet!.message)])
  })

  it('commits neither the input pointer nor a packet when preparation is cancelled', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('never sent')] })
    const sessionId = await newSession(harness)
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    harness.ctx.on('agent/request', async (_info, next) => {
      reached.resolve(undefined)
      await release.promise
      return next()
    })
    const prompting = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'cancel me' }] })
    await reached.promise
    await harness.client.cancel({ sessionId })
    release.resolve(undefined)
    await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' })

    const events = eventsOf(harness, sessionId)
    expect(packetsOf(events)).toEqual([])
    expect(userMessages(events).filter(({ message }) => message.source.kind === 'user')).toEqual([])
    expect(harness.adapter.requests).toEqual([])
  })

  it('publishes nothing when the Agent is disposed while another provider holds the request context', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('never sent')] })
    const sessionId = await newSession(harness)
    const session = harness.ctx.agents.get(SessionId(sessionId))!.session
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    harness.ctx.on('system-prompt/request-context', async (_context, _pending, next) => {
      const added = await next()
      reached.resolve(undefined)
      await release.promise
      return added
    })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const cancelled = Promise.withResolvers<undefined>()
    const cancel = agent.cancel.bind(agent)
    vi.spyOn(agent, 'cancel').mockImplementation((...args) => {
      cancel(...args)
      cancelled.resolve(undefined)
    })
    const prompting = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'dispose during collection' }] })
    await reached.promise
    const closing = harness.client.closeSession({ sessionId })
    await cancelled.promise
    release.resolve(undefined)
    await closing
    await prompting.catch(() => undefined)

    expect(packetsOf(session.snapshotEvents())).toEqual([])
    expect(harness.adapter.requests).toEqual([])
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('rebuilds the packet after compaction removes it from the conversation, naming the replaced input', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('first'), textResponse('second')] })
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'original task' }] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    const before = eventsOf(harness, sessionId)
    const input = userMessages(before).find(({ message }) => message.source.kind === 'user')!
    const replaced = agent.session.surface.nodes.filter(seq => seq >= input.seq)
    // A compaction-style replacement of the input through the last answer drops both input and packet nodes.
    const checkpoint = createUserMessage({ content: [{ type: 'text', text: 'checkpoint summary' }], source: { kind: 'context-test' } })
    agent.session.append('user/message', checkpoint, {
      surfaceOp: { op: 'replace', startSeq: input.seq, endSeq: replaced.at(-1)! },
      sourceEventSeqs: replaced,
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'context-test' } }))
    await agent.whenIdle()

    const packets = packetsOf(eventsOf(harness, sessionId))
    expect(packets).toHaveLength(2)
    expect(textOf(packets[1]!.message)).toContain(`message ${input.message.id}; its text is no longer in this conversation`)
    expect(packets[1]!.message.source).toMatchObject({ latestInput: input.message.id })
    const last = harness.adapter.requests.at(-1)!.messages
    expect(last.filter(message => textOf(message).includes('ACP automation context'))).toHaveLength(1)
    expect(last.some(message => textOf(message) === 'original task')).toBe(false)
  })

  it('resumes with the recorded pointer and moves it on the next tagged input', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('one'), textResponse('two')] })
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'before restart' }] })
    await harness.client.closeSession({ sessionId })
    await harness.client.resumeSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'after restart' }] })

    const events = eventsOf(harness, sessionId)
    const inputs = userMessages(events).filter(({ message }) => message.source.kind === 'user').map(({ message }) => message)
    const packets = packetsOf(events).map(({ message }) => message)
    expect(packets.map(packet => packet.source.kind === 'acp-context' ? packet.source.latestInput : undefined))
      .toEqual([inputs[0]!.id, inputs[1]!.id])
  })

  it('keeps old untagged history valid but unclassified across resume, until a tagged input arrives', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('one'), textResponse('two'), textResponse('three')] })
    const sessionId = await newSession(harness)
    const old = createUserMessage({ content: [{ type: 'text', text: 'Never push to main.' }], source: { kind: 'user' } })
    const first = harness.ctx.agents.get(SessionId(sessionId))!
    first.followup(old)
    await first.whenIdle()
    await harness.client.closeSession({ sessionId })
    await harness.client.resumeSession({ sessionId, cwd: process.cwd(), mcpServers: [] })
    const resumed = harness.ctx.agents.get(SessionId(sessionId))!
    resumed.followup(createUserMessage({ content: [{ type: 'text', text: 'Also keep it small.' }], source: { kind: 'user' } }))
    await resumed.whenIdle()

    // The recorded packet already says "unknown"; resume does not repeat it or guess a channel for old input.
    let events = eventsOf(harness, sessionId)
    expect(packetsOf(events)).toHaveLength(1)
    expect(textOf(packetsOf(events)[0]!.message)).toContain('Latest client input: unknown')
    expect(userMessages(events).filter(({ message }) => message.source.kind === 'user').map(({ message }) => message.source))
      .toEqual([{ kind: 'user' }, { kind: 'user' }])
    const afterResume = harness.adapter.requests[1]!.messages
    expect(afterResume.some(message => textOf(message) === 'Never push to main.')).toBe(true)

    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Now a tagged task.' }] })
    events = eventsOf(harness, sessionId)
    const tagged = userMessages(events).filter(({ message }) => message.source.kind === 'user' && 'input' in message.source)
    expect(tagged).toHaveLength(1)
    expect(packetsOf(events)).toHaveLength(2)
    expect(packetsOf(events)[1]!.message.source).toMatchObject({ latestInput: tagged[0]!.message.id })
  })

  it('does not label a spawned child as the ACP recipient while the parent keeps its own packet', async () => {
    harness = await makeBridgeHarness({ script: [
      toolCallResponse('delegate-1', 'delegate', {}), textResponse('child answer'), textResponse('parent answer'),
    ] })
    const ctx = harness.ctx
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'local-test', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
      prepareContinuable: () => Promise.resolve({}),
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'delegate', description: 'Run a child.', parameters: {},
      execute: async (_args, exec) => {
        const child = await ctx.subagents.startActivation({
          provider: 'local-test', label: 'child', delivery: 'caller', signal: exec.signal,
          request: { parent: exec.agent!, prompt: [{ type: 'text', text: 'child task' }] },
        })
        return [...(await child.result).output]
      },
    }))
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'parent task' }] })

    const isPacket = (message: { content: readonly { type: string; text?: string }[] }): boolean =>
      textOf(message).includes('ACP automation context')
    const [parentFirst, childRequest, parentLast] = harness.adapter.requests
    expect(parentFirst!.messages.filter(isPacket)).toHaveLength(1)
    expect(childRequest!.messages.some(message => textOf(message) === 'child task')).toBe(true)
    expect(childRequest!.messages.filter(isPacket)).toEqual([])
    expect(parentLast!.messages.filter(isPacket)).toHaveLength(1)
    expect(packetsOf(eventsOf(harness, sessionId))).toHaveLength(1)
  })
})
