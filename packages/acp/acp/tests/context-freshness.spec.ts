import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import GoalService from '@deepseek-ai/dsh-goal'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestCleanup } from './cleanup.ts'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

const cleanup = new TestCleanup()
afterEach(async () => { vi.restoreAllMocks(); await cleanup.run() })

const textOf = (message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
  message.content.map(block => block.text ?? '').join('')

/**
 * The goal line the request ends with. Runtime-context snapshots accumulate in history and each states
 * that it supersedes the earlier ones, so the last line is the state the model is told to use.
 */
function currentGoalLine(messages: readonly Parameters<typeof textOf>[0][]): string | undefined {
  return messages.flatMap(message => textOf(message).split('\n').filter(line => line.startsWith('Goal:'))).at(-1)
}

const ACTIVE_LINE = 'Goal: active, round 0 of 256; the objective is supplied by the goal itself.'

async function mountedSession(options: { script: Parameters<typeof makeBridgeHarness>[0] }): Promise<{
  harness: BridgeHarness
  sessionId: string
  goals: GoalService
}> {
  const harness = cleanup.adopt(await makeBridgeHarness(options.script))
  await harness.ctx.plugin(GoalService)
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  return { harness, sessionId, goals: harness.ctx.goals }
}

function agentOf(harness: BridgeHarness, sessionId: string) {
  const agent = harness.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error('missing agent')
  return agent
}

/** The newest committed runtime-context snapshot text, which is what a later request carries. */
function loggedRuntimeContext(events: readonly SessionEvent[]): string {
  const snapshots = events.flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'runtime-context' ? [textOf(event.data)] : [])
  return snapshots.at(-1) ?? ''
}

describe('goal state at request admission', () => {
  it('dispatches and logs the goal committed in the microtask after the goal was read', async () => {
    const { harness, sessionId, goals } = await mountedSession({ script: { script: [textResponse('ok')] } })
    const agent = agentOf(harness, sessionId)
    const read = goals.get.bind(goals)
    let queued = false
    vi.spyOn(goals, 'get').mockImplementation((recipient) => {
      const result = read(recipient)
      if (!queued) {
        queued = true
        queueMicrotask(() => { goals.create(agent, { objective: 'post-read objective' }) })
      }
      return result
    })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'work' }] })

    expect(goals.get(agent)?.phase).toBe('active')
    expect(harness.adapter.requests).toHaveLength(1)
    expect(currentGoalLine(harness.adapter.requests[0]!.messages)).toBe(ACTIVE_LINE)
    expect(loggedRuntimeContext(agent.session.snapshotEvents())).toContain(ACTIVE_LINE)
  })

  it('dispatches and logs the goal committed while the last admission await is held', async () => {
    const { harness, sessionId, goals } = await mountedSession({ script: { script: [textResponse('one'), textResponse('two')] } })
    const agent = agentOf(harness, sessionId)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] })
    expect(currentGoalLine(harness.adapter.requests[0]!.messages)).toBe('Goal: none.')

    // A newly registered tool commits a registry notice, which makes request admission validate once more;
    // its activation predicate is the last await before the request freezes.
    const hold = cleanup.barrier()
    let notice = false
    let held = false
    harness.ctx.on('session/event', (_session, event) => {
      if (event.type === 'developer/message' && event.data.message.source.kind === 'tool-registry') notice = true
    })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'late-tool', description: 'Registered between prompts.', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'unused' }]),
    }), {
      when: async () => {
        if (notice && !held) {
          held = true
          hold.reach()
          await hold.released
        }
        return true
      },
    })
    const prompting = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await hold.reached
    goals.create(agent, { objective: 'created at final admission' })
    hold.release()
    await prompting

    expect(held).toBe(true)
    expect(harness.adapter.requests).toHaveLength(2)
    expect(currentGoalLine(harness.adapter.requests[1]!.messages)).toBe(ACTIVE_LINE)
    expect(loggedRuntimeContext(agent.session.snapshotEvents())).toContain(ACTIVE_LINE)
  })
})

describe('goal detail in the context', () => {
  it('shows a goal block reason code that fits and omits one that does not, with explicit accounting', async () => {
    const { harness, sessionId, goals } = await mountedSession({ script: { script: [textResponse('one'), textResponse('two')] } })
    const agent = agentOf(harness, sessionId)
    const goal = goals.create(agent, { objective: 'bounded context' })
    goals.block(agent, goal, { code: 'external-policy-blocked', message: 'blocked by policy' })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'short code' }] })
    expect(currentGoalLine(harness.adapter.requests[0]!.messages))
      .toBe('Goal: blocked, reason external-policy-blocked, round 0 of 256; the objective is supplied by the goal itself.')

    const long = 'x'.repeat(100_000)
    goals.block(agent, goals.resume(agent, goals.get(agent)!), { code: long, message: 'blocked by policy' })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'long code' }] })

    const request = harness.adapter.requests[1]!.messages
    const line = currentGoalLine(request)
    expect(Buffer.byteLength(line!, 'utf8')).toBeLessThanOrEqual(512)
    expect(line).toContain('blocked')
    expect(line).toContain('reason code omitted (100000 characters; limit 64)')
    expect(request.some(message => textOf(message).includes('x'.repeat(65)))).toBe(false)
  })
})
