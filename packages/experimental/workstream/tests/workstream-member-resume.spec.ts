import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { logPath } from '../../../session/session-persistence-jsonl/src/format.ts'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []
const signal = new AbortController().signal
const MODEL = { provider: 'mock', model: 'mock' }

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const textOf = (message: Message): string => typeof message.content === 'string' ? message.content
  : message.content.map(block => block.type === 'text' ? block.text : '').join('')

/** Answers `ok`, except that a member whose conversation contains a hanging prompt runs until it is aborted. */
class RoleAdapter extends MockAdapter {
  constructor(private readonly hanging: readonly string[]) { super([]) }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = options.messages.map(textOf).join('\n')
    if (!this.hanging.some(prompt => text.includes(prompt))) {
      yield* textResponse('ok')
      return
    }
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error('aborted')); return }
      options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }
}

async function setup(hanging: readonly string[]) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-resume-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  const mock = new RoleAdapter(hanging)
  ctx.llm.registerAdapter(['mock'], mock)
  const owner = await ctx.agents.create({ sessionId: SessionId('owner'), agentOptions: MODEL })
  await ctx.workstreams.open(owner.agent, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner, fiber, mock, dir }
}

function request(name: string) {
  return { operationId: WorkstreamOperationId(`create-${name}`), name, description: `${name} responsibility`, provider:
    'spawn', prompt: `${name} initial`, signal }
}

/** Workstream notices recorded in one Session's log. */
function notices(session: Session): string[] {
  return session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'workstream-notice'
    ? [event.data.content.map(block => block.type === 'text' ? block.text : '').join('')] : [])
}

/** Wait until one Session has sent a model request. */
async function requested(mock: RoleAdapter, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(mock.requests.some(options => options.sessionId === id)).toBe(true) })
}

describe('coordinator handoff to a member that is not running', () => {
  it('cold-resumes the member with a logged notice and commits it as coordinator', async () => {
    const { ctx, owner } = await setup(['lead initial'])
    const member = await ctx.workstreams.addMember(owner.agent, owner.agent.id, request('lead'))
    await ctx.subagents.drainChildren(owner.agent, [member.id])
    expect(ctx.agents.get(member.id)).toBeUndefined()
    const ticket = await ctx.workstreams.createTicket(owner.agent, owner.agent.id, { subject: 'Lead it', description: '' })
    const before = ctx.workstreams.get(owner.agent, owner.agent.id)
    const after = await ctx.workstreams.handoff(owner.agent, owner.agent.id,
      { expectedRevision: before.revision, coordinatorId: member.id })
    expect(after).toMatchObject({ revision: before.revision + 1, coordinatorId: member.id })
    expect(ctx.tickets.get(owner.agent.session, ticket.id).coordinatorId).toBe(member.id)
    const live = ctx.agents.get(member.id)
    expect(live).toBeDefined()
    expect(notices(live!.session)).toEqual([expect.stringContaining(`coordinator role of Workstream ${owner.agent.id}`)])
  })

  it('refuses with nothing committed when the member cannot be resumed', async () => {
    const { ctx, owner, dir } = await setup(['lead initial'])
    const member = await ctx.workstreams.addMember(owner.agent, owner.agent.id, request('lead'))
    const cwd = ctx.sessions.get(member.id)!.header.cwd
    await ctx.subagents.drainChildren(owner.agent, [member.id])
    rmSync(logPath(dir, cwd, member.id, 'none'))
    const before = ctx.workstreams.get(owner.agent, owner.agent.id)
    await expect(ctx.workstreams.handoff(owner.agent, owner.agent.id, { expectedRevision: before.revision, coordinatorId: member.id }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT', message: expect.stringContaining('workstream_send') as string })
    expect(ctx.workstreams.get(owner.agent, owner.agent.id)).toEqual(before)
  })

  it('does not message a successor that is already running', async () => {
    const { ctx, owner } = await setup(['lead initial'])
    const member = await ctx.workstreams.addMember(owner.agent, owner.agent.id, request('lead'))
    const before = ctx.workstreams.get(owner.agent, owner.agent.id)
    await ctx.workstreams.handoff(owner.agent, owner.agent.id, { expectedRevision: before.revision, coordinatorId: member.id })
    expect(notices(ctx.agents.get(member.id)!.session)).toEqual([])
  })
})

describe('owner resume after members were stopped mid-turn', () => {
  /** Stop the service and owner as a process shutdown does, then load Workstream again and resume the owner. */
  async function restart(fixture: Awaited<ReturnType<typeof setup>>, between?: () => void): Promise<Agent> {
    await fixture.fiber.dispose()
    await fixture.owner.dispose()
    between?.()
    await fixture.ctx.plugin(WorkstreamService)
    const { agent } = await fixture.ctx.agents.resume({ resumeSessionId: fixture.owner.agent.id, agentOptions: MODEL })
    return agent
  }

  /** Run one owner turn and return the text of its model request. */
  async function ownerRequest(fixture: Awaited<ReturnType<typeof setup>>, owner: Agent): Promise<string> {
    const mine = (): GenerateOptions[] => fixture.mock.requests.filter(options => options.sessionId === owner.id)
    const count = mine().length
    owner.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(mine()).toHaveLength(count + 1) })
    await owner.whenIdle()
    return mine().at(-1)!.messages.map(textOf).join('\n')
  }

  /** Let a member finish its first turn and the owner absorb the settlement notice. */
  async function settle(fixture: Awaited<ReturnType<typeof setup>>, id: SessionId): Promise<void> {
    await requested(fixture.mock, id)
    await fixture.ctx.agents.get(id)?.whenIdle()
    await fixture.owner.agent.whenIdle()
  }

  it('tells the owner which member turn did not finish, and not the member that finished', async () => {
    const fixture = await setup(['busy initial'])
    const { ctx, owner } = fixture
    const done = await ctx.workstreams.addMember(owner.agent, owner.agent.id, request('done'))
    await settle(fixture, done.id)
    const busy = await ctx.workstreams.addMember(owner.agent, owner.agent.id, request('busy'))
    await requested(fixture.mock, busy.id)
    const resumed = await restart(fixture)
    const notice = `busy (${busy.id}, turn 1)`
    expect(await ownerRequest(fixture, resumed), 'the notice reaches the first resumed request').toContain(notice)
    expect(notices(resumed.session)).toEqual([expect.stringContaining(notice)])
    expect(notices(resumed.session)[0]).not.toContain(done.id)
    expect(ctx.workstreams.get(resumed, resumed.id).members.find(member => member.id === busy.id)?.phase).toBe('active')
  })

  it('reports a member whose log cannot be read instead of failing the owner resume', async () => {
    const fixture = await setup(['busy initial'])
    const { ctx, owner, dir } = fixture
    const busy = await ctx.workstreams.addMember(owner.agent, owner.agent.id, request('busy'))
    await requested(fixture.mock, busy.id)
    const cwd = ctx.sessions.get(busy.id)!.header.cwd
    const resumed = await restart(fixture, () => { rmSync(logPath(dir, cwd, busy.id, 'none')) })
    expect(await ownerRequest(fixture, resumed)).toContain(`busy (${busy.id}, log unreadable)`)
  })

  it('adds nothing when no member was interrupted', async () => {
    const fixture = await setup([])
    const { ctx, owner } = fixture
    const done = await ctx.workstreams.addMember(owner.agent, owner.agent.id, request('done'))
    await settle(fixture, done.id)
    const resumed = await restart(fixture)
    await ownerRequest(fixture, resumed)
    expect(notices(resumed.session)).toEqual([])
  })
})
