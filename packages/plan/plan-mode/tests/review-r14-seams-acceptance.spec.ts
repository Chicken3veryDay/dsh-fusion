/** Round-14 probes of plan mode's `agent/step-accepted` commit point against loop failure, reassembly, and goal-driver composition. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import * as goalRoundDriver from '@deepseek-ai/dsh-goal-round-driver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import PlanModeController, { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const SECTION = 'Plan carefully before implementing.'
const NOTICE = 'The user switched this session to plan mode.'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

function texts(messages: readonly RequestMessage[], role: RequestMessage['role']): string {
  return messages.filter(message => message.role === role)
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .join('\n')
}

function toolNames(request: GenerateOptions | undefined): string[] {
  return (request?.tools ?? []).map(tool => tool.name)
}

function prompt(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
}

function logTypes(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter(event => ['plan/mode', 'step/start', 'step/end', 'turn/start', 'turn/end', 'user/message'].includes(event.type))
    .map(event => event.type === 'user/message'
      ? `user:${event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')}`
      : event.type === 'plan/mode' ? `plan/mode:${String(event.data.active)}` : event.type)
}

/** Mount the loop; `before` registers listeners ahead of plan mode (outer), `after` behind it. */
async function mount(options: {
  responses: number
  before?: (ctx: Context) => void
  after?: (ctx: Context) => void
  goals?: boolean
}): Promise<{ ctx: Context; adapter: MockAdapter; agent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '', personaSuffix: '' } })
  if (options.goals === true) {
    await ctx.plugin(GoalService)
    await ctx.plugin(goalRoundDriver)
  }
  options.before?.(ctx)
  await ctx.plugin(PlanModeController, { section: SECTION })
  options.after?.(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(Array.from({ length: options.responses }, (_, index) => textResponse(`r${index + 1}`)))
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`review-r14-${Math.random()}`), { provider: 'mock', model: 'model' })
  return { ctx, adapter, agent }
}

describe('plan mode at agent/step-accepted', () => {
  it('a later acceptance listener that throws keeps the commit and records the notice in the failed step', async () => {
    let failNext = false
    const { ctx, adapter, agent } = await mount({
      responses: 2,
      after: (context) => {
        context.on('agent/step-accepted', () => {
          if (!failNext) return
          failNext = false
          throw new Error('acceptance failed')
        })
      },
    })
    prompt(agent, 'first')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)

    const stop = ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject === agent && ctx.planMode.get(agent).pending === undefined && !ctx.planMode.get(agent).active) {
        expect(ctx.planMode.set(agent, true)).toBe('queued')
      }
      return next()
    }, { prepend: true })
    failNext = true
    prompt(agent, 'second')
    await agent.whenIdle()
    stop()
    expect(adapter.requests, 'the failed step makes no request').toHaveLength(1)
    const turn2 = logTypes(agent).slice(logTypes(agent).lastIndexOf('turn/start'))
    // Documented: prior listener effects remain committed, and added messages follow ordinary delivery.
    expect(turn2).toEqual(['turn/start', 'plan/mode:true', 'step/start', 'user:second', `user:${NOTICE}`, 'step/end', 'turn/end'])
    expect(ctx.planMode.get(agent)).toEqual({ active: true })

    prompt(agent, 'third')
    await agent.whenIdle()
    const third = adapter.requests[1]
    expect(texts(third?.messages ?? [], 'system')).toContain(SECTION)
    expect(texts(third?.messages ?? [], 'user')).toContain(NOTICE)
    expect(toolNames(third)).toContain(EXIT_PLAN_MODE)
  })

  it('an outer listener selecting after its next() returns is committed at acceptance and reassembled into the request', async () => {
    let selectAfter = false
    const { adapter, agent } = await mount({
      responses: 2,
      before: (context) => {
        context.on('agent/pre-step', async ({ agent: subject }, next) => {
          const decision = await next()
          if (selectAfter) {
            selectAfter = false
            expect(context.planMode.set(subject, true)).toBe('queued')
          }
          return decision
        })
      },
    })
    prompt(agent, 'first')
    await agent.whenIdle()
    selectAfter = true
    prompt(agent, 'second')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const second = adapter.requests[1]
    expect(agent.session.snapshotEvents().filter(event => event.type === 'plan/mode').map(event => event.data)).toEqual([{ active: true }])
    expect(texts(second?.messages ?? [], 'system')).toContain(SECTION)
    expect(texts(second?.messages ?? [], 'user')).toContain(NOTICE)
    expect(toolNames(second)).toContain(EXIT_PLAN_MODE)
  })

  it('an outer listener that answers without delegating still commits and presents the selection', async () => {
    let shortCircuit = false
    const { ctx, adapter, agent } = await mount({
      responses: 2,
      before: (context) => {
        context.on('agent/pre-step', async ({ messages }, next) => {
          if (!shortCircuit) return next()
          shortCircuit = false
          return { kind: 'enter', messages }
        })
      },
    })
    prompt(agent, 'first')
    await agent.whenIdle()
    // Queue the selection inside the open turn, before the short-circuiting listener answers.
    const select = ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (shortCircuit && subject === agent) expect(ctx.planMode.set(agent, true)).toBe('queued')
      return next()
    }, { prepend: true })
    shortCircuit = true
    prompt(agent, 'second')
    await agent.whenIdle()
    select()
    expect(adapter.requests).toHaveLength(2)
    const second = adapter.requests[1]
    expect(agent.session.snapshotEvents().filter(event => event.type === 'plan/mode').map(event => event.data)).toEqual([{ active: true }])
    expect(texts(second?.messages ?? [], 'system')).toContain(SECTION)
    expect(texts(second?.messages ?? [], 'user')).toContain(NOTICE)
    expect(toolNames(second)).toContain(EXIT_PLAN_MODE)
  })

  it('goal-round-driver rejecting after next() leaves the selection pending for the next accepted round', async () => {
    let editOnce = false
    const { ctx, adapter, agent } = await mount({
      responses: 2,
      goals: true,
      after: (context) => {
        // Inner to both goal-round-driver and plan mode: select plan mode, then invalidate the
        // reservation so the driver's post-decision recheck rejects the step after next() returns.
        context.on('agent/pre-step', ({ agent: subject, messages }, next) => {
          if (editOnce && messages.some(message => message.source.kind === 'goal')) {
            editOnce = false
            expect(context.planMode.set(subject, true)).toBe('queued')
            const goal = context.goals.get(subject)
            if (goal === undefined) throw new Error('missing goal')
            context.goals.edit(subject, goal, { objective: 'edited downstream' })
          }
          return next()
        })
      },
    })
    prompt(agent, 'first')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)

    let modesAtReject: unknown[] | undefined
    const watch = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end' && event.data.reason.kind === 'blocked') {
        modesAtReject = agent.session.snapshotEvents().filter(entry => entry.type === 'plan/mode').map(entry => entry.data)
      }
    })
    editOnce = true
    ctx.goals.create(agent, { objective: 'plan the change', maxGoalRounds: 1 })
    await vi.waitFor(() => { expect(ctx.goals.get(agent)?.phase).toBe('blocked') }, { timeout: 30_000 })
    await agent.whenIdle()
    watch()

    expect(modesAtReject, 'the rejected round logs no mode').toEqual([])
    expect(adapter.requests).toHaveLength(2)
    const round = adapter.requests[1]
    expect(agent.session.snapshotEvents().filter(event => event.type === 'plan/mode').map(event => event.data)).toEqual([{ active: true }])
    expect(texts(round?.messages ?? [], 'system')).toContain(SECTION)
    expect(texts(round?.messages ?? [], 'user')).toContain(NOTICE)
    expect(texts(round?.messages ?? [], 'user').split(NOTICE)).toHaveLength(2)
  })
})
