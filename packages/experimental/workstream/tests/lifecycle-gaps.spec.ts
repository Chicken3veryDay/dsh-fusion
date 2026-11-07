/** Workstream lifecycle edges: uncertain provisioning, foreign events, shutdown during a handoff, and a cancelled owner resume. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []
const signal = new AbortController().signal
const MODEL = { provider: 'mock', model: 'mock' }
const OWNER = SessionId('owner')

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-lifecycle-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  const service = ctx.workstreams
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const handle = await ctx.agents.create({ sessionId: OWNER, agentOptions: MODEL })
  await ctx.workstreams.open(handle.agent, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, fiber, service, handle, owner: handle.agent }
}

function member(name: string) {
  return { operationId: WorkstreamOperationId(`create-${name}`), name, description: `${name} responsibility`, provider: 'spawn',
    prompt: `${name} initial`, signal }
}

describe('uncertain member provisioning', () => {
  it('reports unknown provisioning when the started child leaves the live registry before confirmation', async () => {
    const { ctx, owner } = await setup()
    const start = ctx.subagents.startActivation.bind(ctx.subagents)
    let gone: SessionId | undefined
    vi.spyOn(ctx.subagents, 'startActivation').mockImplementationOnce(async (spec) => {
      const started = await start(spec)
      gone = spec.childId
      return started
    })
    const get = ctx.sessions.get.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'get').mockImplementation(id => id === gone ? undefined : get(id))
    const added = ctx.workstreams.addMember(owner, owner.id, member('lost'))
    await expect(added).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    await expect(added.catch((error: unknown) => (error as { cause: unknown }).cause)).resolves.toMatchObject({
      message: expect.stringContaining('left the live registry') as string })
    expect(ctx.workstreams.get(owner, owner.id).members.find(candidate => candidate.name === 'lost')?.phase).toBe('provisioning')
  })

  it('reports unknown provisioning when the child log holds no acceptance of the launch message', async () => {
    const { ctx, owner } = await setup()
    const start = ctx.subagents.startActivation.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'startActivation').mockImplementationOnce(async spec =>
      ({ ...await start(spec), messageId: 'unrelated' as MessageId }))
    const added = ctx.workstreams.addMember(owner, owner.id, member('unaccepted'))
    await expect(added).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    await expect(added.catch((error: unknown) => (error as { cause: unknown }).cause)).resolves.toMatchObject({
      message: expect.stringContaining('provisioning remains unknown') as string })
    expect(ctx.workstreams.get(owner, owner.id).members.find(candidate => candidate.name === 'unaccepted')?.phase).toBe('provisioning')
  })
})

describe('waiting for changes', () => {
  it('ends when the Workstream itself changes', async () => {
    const { ctx, owner } = await setup()
    const current = ctx.workstreams.get(owner, owner.id)
    const waiting = ctx.workstreams.waitForChange(owner, owner.id,
      { afterRevision: current.revision, afterCursor: ctx.workstreams.cursor(owner, owner.id), timeoutMs: 60_000, signal })
    await ctx.workstreams.addMember(owner, owner.id, member('changing'))
    await expect(waiting).resolves.toMatchObject({ timedOut: false, revision: current.revision + 1 })
  })

  it('ignores a Workstream event that belongs to another owner', async () => {
    const { ctx, owner } = await setup()
    const current = ctx.workstreams.get(owner, owner.id)
    const waiting = ctx.workstreams.waitForChange(owner, owner.id,
      { afterRevision: current.revision, afterCursor: ctx.workstreams.cursor(owner, owner.id), timeoutMs: 150, signal })
    owner.session.append('workstream/state', { version: 1, snapshot: { ...current, ownerSessionId: SessionId('foreign') } })
    await expect(waiting).resolves.toMatchObject({ timedOut: true, revision: current.revision })
  })
})

describe('a stopped service', () => {
  it('refuses queued work through a retained reference', async () => {
    const { ctx, fiber, service, owner } = await setup()
    await fiber.dispose()
    expect(ctx.get('workstreams')).toBeUndefined()
    await expect(service.acknowledge(owner, owner.id, WorkstreamOperationId('after'))).rejects.toMatchObject({
      code: 'WORKSTREAM_DISPOSED' })
  })
})

describe('shutdown during a coordinator handoff', () => {
  async function withLead() {
    const fixture = await setup()
    const lead = await fixture.ctx.workstreams.addMember(fixture.owner, fixture.owner.id, member('lead'))
    const before = fixture.ctx.workstreams.get(fixture.owner, fixture.owner.id)
    return { ...fixture, lead, before }
  }

  it('commits nothing when the service stops before the first Ticket moves', async () => {
    const { ctx, service, owner, lead, before } = await withLead()
    const list = ctx.tickets.list.bind(ctx.tickets)
    let stopping: Promise<void> | undefined
    vi.spyOn(ctx.tickets, 'list').mockImplementationOnce((...args) => {
      // Stop the service exactly between the successor checks and the first Ticket move.
      stopping = service['shutdown']()
      return list(...args)
    })
    await expect(ctx.workstreams.handoff(owner, owner.id, { expectedRevision: before.revision, coordinatorId: lead.id }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_DISPOSED' })
    await stopping
    expect(owner.session.snapshotEvents().filter(event => event.type === 'workstream/state').at(-1)?.data.snapshot).toEqual(before)
  })

  it('refuses a successor that stopped running before the snapshot could name it', async () => {
    const { ctx, owner, lead, before } = await withLead()
    const list = ctx.tickets.list.bind(ctx.tickets)
    const get = ctx.agents.get.bind(ctx.agents)
    let stopped = false
    vi.spyOn(ctx.tickets, 'list').mockImplementationOnce((...args) => { stopped = true; return list(...args) })
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => stopped && id === lead.id ? undefined : get(id))
    await expect(ctx.workstreams.handoff(owner, owner.id, { expectedRevision: before.revision, coordinatorId: lead.id }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT', message: expect.stringContaining('not a registered live Agent') as string })
    expect(ctx.workstreams.get(owner, owner.id)).toEqual(before)
  })

  it('reports the shutdown, not a resume failure, when it interrupts resuming a stopped successor', async () => {
    const { ctx, fiber, owner, lead, before } = await withLead()
    await ctx.subagents.drainChildren(owner, [lead.id])
    expect(ctx.agents.get(lead.id)).toBeUndefined()
    const get = ctx.agents.get.bind(ctx.agents)
    let stopping: Promise<void> | undefined
    vi.spyOn(ctx.agents, 'get').mockImplementation((id) => {
      if (id === lead.id && stopping === undefined) stopping = fiber.dispose()
      return get(id)
    })
    await expect(ctx.workstreams.handoff(owner, owner.id, { expectedRevision: before.revision, coordinatorId: lead.id }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_DISPOSED' })
    await stopping
  })
})

describe('owner resume with a caller signal', () => {
  it('adds no notice about unfinished members once the resume was cancelled', async () => {
    const { ctx, fiber, handle, owner } = await setup()
    const busy = await ctx.workstreams.addMember(owner, owner.id, member('busy'))
    await vi.waitFor(() => { expect(ctx.agents.get(busy.id)).toBeDefined() })
    await fiber.dispose()
    await handle.dispose()
    await ctx.plugin(WorkstreamService)
    const cancel = new AbortController()
    const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      if (args[0] === busy.id && args[1] === 'read') cancel.abort(new Error('resume cancelled'))
      return open(...args)
    })
    const resumed = await ctx.agents.resume({ resumeSessionId: OWNER, agentOptions: MODEL, signal: cancel.signal })
      .then(({ agent }) => agent, (error: unknown) => error)
    expect(cancel.signal.aborted).toBe(true)
    const session = ctx.sessions.get(OWNER)
    const logged = session?.snapshotEvents() ?? []
    expect(logged.filter(event => event.type === 'user/message' && event.data.source.kind === 'workstream-notice')).toEqual([])
    expect(resumed).toBeDefined()
  })
})
