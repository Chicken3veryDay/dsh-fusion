/** Receiver delivery tracking over the real event log of a Node PTC `run_code` program, live and interrupted mid-program. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { interruptedTurnClosers, SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { createIntent, DeliveryId, receiverProjection } from '../src/delivery-state.ts'
import type { ReceiverState } from '../src/delivery-state.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const RECEIVER = SessionId('receiver')
const header: SessionHeader = { id: RECEIVER, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false }

/** Run one real program that awaits a gated nested tool; return the log cut at the gate and the settled log. */
async function runProgram() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' } })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(FileSystem)
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(NodeRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  ctx.tools.register(defineTool({
    name: 'gated', description: 'Block until released.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { entered.resolve(undefined); await release.promise; return 'released' },
  }))
  const agent = await ctx.agentLoop.create(RECEIVER, { provider: 'mock', model: 'mock' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([
    toolCallResponse('program', 'run_code', { code: 'return await tools.gated({})', description: 'Hold a nested call open' }),
    textResponse('done'),
  ]))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }))
  await entered.promise
  const atGate = agent.session.snapshotEvents()
  release.resolve(undefined)
  await agent.whenIdle()
  return { atGate, settled: agent.session.snapshotEvents() }
}

const intent = createIntent({ deliveryId: DeliveryId('during-program'), targetParticipantId: RECEIVER,
  inboxTarget: 'next-step', correlationId: null, text: 'peer note' }, SessionId('root'), { kind: 'user' }, 1)

function renumber(events: SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: SessionSeq(index) }))
}

function fold(events: readonly SessionEvent[]): ReceiverState {
  let state: ReceiverState = receiverProjection.init(header, SessionLogOffset(0))
  for (const event of events) state = receiverProjection.apply(state, event)
  return state
}

it('tracks the run_code call, not its nested dispatches, when a delivery lands mid-program', async () => {
  const { atGate, settled } = await runProgram()
  const dispatchStart = atGate.findIndex(event => event.type === 'tool/ptc-dispatch-start')
  expect(dispatchStart).toBeGreaterThan(-1)
  expect(atGate.some(event => event.type === 'tool/call' && event.data.name === 'run_code')).toBe(true)
  const insertAt = dispatchStart + 1
  const accepted = { type: 'fusion/delivery-accepted', seq: SessionSeq(0), time: 0, data: intent } satisfies SessionEvent
  const spliced = { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 0,
    data: { target: 'next-step', start: 0, inserted: [intent.instruction] } } satisfies SessionEvent
  const log = renumber([...settled.slice(0, insertAt), accepted, spliced, ...settled.slice(insertAt)])
  const state = fold(log)
  expect(state.entries).toHaveLength(1)
  expect(state.entries[0]?.instructionSeq).toBe(insertAt + 1)
  expect(state.calls).toEqual([])
  expect(log.filter(event => event.type === 'tool/ptc-dispatch')).toHaveLength(1)
})

it('seals an acceptance-only delivery after a program interrupted with its nested call still open', async () => {
  const { atGate } = await runProgram()
  const runCodeCall = atGate.find(event => event.type === 'tool/call' && event.data.name === 'run_code')
  if (runCodeCall?.type !== 'tool/call') throw new Error('expected the run_code call to be recorded')
  const accepted = { type: 'fusion/delivery-accepted', seq: SessionSeq(0), time: 0, data: intent } satisfies SessionEvent
  const prefix = renumber([...atGate, accepted])
  expect(fold(prefix).calls).toEqual([expect.objectContaining({ id: runCodeCall.data.callId, started: runCodeCall.seq })])
  const closers = interruptedTurnClosers(prefix)
  expect(closers.map(event => event.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
  const sealed = fold([...prefix, ...closers])
  expect(sealed.calls).toEqual([])
  expect(sealed.entries[0]?.instructionSeq).toBeNull()
})
