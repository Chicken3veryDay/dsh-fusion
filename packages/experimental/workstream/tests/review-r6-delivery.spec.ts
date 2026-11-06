/** Round-6 delivery ordering, retry, stop, and unload probes using real continuable children. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
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
  const dir = mkdtempSync(join(tmpdir(), 'review-r6-workstream-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner, fiber }
}

async function logged(ctx: Context, id: SessionId) {
  const session = ctx.sessions.get(id)
  if (session !== undefined) await ctx.sessions.flush(session)
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try { return (await handle.read(0)).events } finally { await handle.close() }
}

function request(name: string) {
  return { operationId: WorkstreamOperationId(`create-${name}`), name, description: `${name} responsibility`, provider:
    'spawn', prompt: `${name} initial`, signal }
}


/** Own the gate so every assertion failure still releases the underlying storage operation. */
function deferred(): PromiseWithResolvers<void> { return Promise.withResolvers() }

it('R6-C1 cold-resumed sends preserve admission order and same-operation retries accept only one inbox copy', async () => {
  const { ctx, owner } = await setup()
  const member = await ctx.workstreams.addMember(owner, owner.id, request('worker'))
  await ctx.subagents.drainChildren(owner, [member.id])
  const entered = deferred(), release = deferred()
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  const spy = vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (...args) => {
    entered.resolve(); await release.promise; return observe(...args)
  })
  const firstRequest = { operationId: WorkstreamOperationId('first'), targetId: member.id, text: 'First', signal }
  const first = ctx.workstreams.sendMessage(owner, owner.id, firstRequest)
  let second: ReturnType<typeof ctx.workstreams.sendMessage> | undefined
  let retry: ReturnType<typeof ctx.workstreams.sendMessage> | undefined
  try {
    await entered.promise
    retry = ctx.workstreams.sendMessage(owner, owner.id, firstRequest)
    second = ctx.workstreams.sendMessage(owner, owner.id, { ...firstRequest, operationId: WorkstreamOperationId('second'), text: 'Second' })
    release.resolve()
    const [a, b, again] = await Promise.all([first, second, retry])
    expect(a.delivery.phase).toBe('accepted')
    expect(b.delivery.phase).toBe('accepted')
    expect(again).toEqual(a)
    const events = await logged(ctx, member.id)
    const accepted = events.flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
      .filter(message => message.source.kind === 'workstream-message')
    expect(accepted.map(message => message.source.kind === 'workstream-message' ? message.source.operationId : '')).toEqual(['first', 'second'])
    expect(ctx.workstreams.get(owner, owner.id).messages).toHaveLength(2)
  } finally { release.resolve(); spy.mockRestore(); await Promise.allSettled([first, second, retry]) }
})

it('R6-C2 stopping a recipient during cold resume drains the admitted delivery and refuses a later send', async () => {
  const { ctx, owner } = await setup()
  const member = await ctx.workstreams.addMember(owner, owner.id, request('worker'))
  await ctx.subagents.drainChildren(owner, [member.id])
  const entered = deferred(), release = deferred(), stoppingRecorded = deferred()
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (...args) => {
    entered.resolve(); await release.promise; return observe(...args)
  })
  const stopListening = ctx.on('session/event', (_session, event) => {
    if (event.type === 'workstream/state' && event.data.snapshot.members.some(m => m.id === member.id && m.phase === 'stopping')) stoppingRecorded.resolve()
  })
  const message = { operationId: WorkstreamOperationId('before-stop'), targetId: member.id, text: 'Before stop', signal }
  const sending = ctx.workstreams.sendMessage(owner, owner.id, message)
  let stopping: ReturnType<typeof ctx.workstreams.stop> | undefined
  try {
    await entered.promise
    stopping = ctx.workstreams.stop(owner, owner.id, member.id)
    await stoppingRecorded.promise
    await expect(ctx.workstreams.sendMessage(owner, owner.id, { ...message, operationId: WorkstreamOperationId('after-stop') }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_INVALID_INPUT' })
    release.resolve()
    const [receipt, stopped] = await Promise.all([sending, stopping])
    expect(receipt.delivery.phase).toBe('accepted')
    expect(stopped.phase).toBe('stopped')
    expect(ctx.agents.get(member.id)).toBeUndefined()
    expect(await ctx.workstreams.sendMessage(owner, owner.id, message)).toEqual(receipt)
  } finally { release.resolve(); stopListening(); await Promise.allSettled([sending, stopping]) }
})

it('R6-C3 shutdown during cold resume settles delivery without creating a child after unload, and reload reconciles it', async () => {
  const { ctx, owner, fiber } = await setup()
  const service = ctx.workstreams
  const member = await service.addMember(owner, owner.id, request('worker'))
  await ctx.subagents.drainChildren(owner, [member.id])
  const entered = deferred(), release = deferred(), aborted = deferred()
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (...args) => {
    const options = args[1]
    options?.signal?.addEventListener('abort', () => { aborted.resolve() }, { once: true })
    entered.resolve(); await release.promise; return observe(...args)
  })
  const message = { operationId: WorkstreamOperationId('shutdown-send'), targetId: member.id, text: 'Before unload', signal }
  const delivery = service.sendMessage(owner, owner.id, message).then(value => ({ value }), (error: unknown) => ({ error }))
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = fiber.dispose()
    await aborted.promise
    release.resolve()
    expect(await delivery).toMatchObject({ error: { code: 'WORKSTREAM_UNKNOWN' } })
    await closing
    expect(ctx.agents.get(member.id)).toBeUndefined()
    await ctx.plugin(WorkstreamService)
    await expect(ctx.workstreams.sendMessage(owner, owner.id, message)).rejects.toMatchObject({ code: 'WORKSTREAM_UNKNOWN' })
    expect(ctx.agents.get(member.id)).toBeUndefined()
    expect(ctx.workstreams.get(owner, owner.id).messages).toHaveLength(1)
  } finally { release.resolve(); await Promise.allSettled([delivery, closing]) }
})
