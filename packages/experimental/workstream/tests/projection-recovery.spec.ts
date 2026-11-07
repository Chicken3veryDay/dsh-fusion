/** Workstream projection state version 2 recovers from checkpoints and restarts with the same wait cursor positions. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'
import { workstreamProjectionDefinition } from '../src/projection.ts'

const contexts: Context[] = []
const directories: string[] = []
const signal = new AbortController().signal
const ROOT = SessionId('recovering-root')
const model = { provider: 'mock', model: 'mock' }

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A root with a Workstream, a member, a Ticket before the Workstream opened, and a Ticket assigned after it. */
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-recovery-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  const fiber = await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const handle = await ctx.agents.create({ sessionId: ROOT, agentOptions: model })
  const owner = handle.agent
  await ctx.agents.withInitiator(owner, () => ctx.tickets.create(owner.session, { subject: 'Before', description: 'Pre-open' }))
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Recovering work' })
  const added = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('add'), name: 'worker',
    description: 'Works', provider: 'spawn', prompt: 'Work', signal })
  const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'After', description: 'Post-open' })
  await ctx.workstreams.assignTicket(owner, owner.id, { ticketId: ticket.id, expectedRevision: ticket.revision, ownerId: added.id,
    subject: 'Do it' })
  return { ctx, fiber, handle, owner, memberId: added.id }
}

/** Fold the complete log with the definition alone: the reference every recovery path must match. */
function fullFold(session: Session) {
  return session.snapshotEvents().reduce(workstreamProjectionDefinition.apply, workstreamProjectionDefinition.init(session.header))
}

describe('Workstream projection recovery', () => {
  it('discards a stateVersion 1 checkpoint and refolds the full log, recording the event positions', async () => {
    const { ctx, owner, memberId } = await setup()
    const events = owner.session.snapshotEvents()
    const reference = fullFold(owner.session)
    expect(reference.snapshotSeq).toBe(events.findLast(event => event.type === 'workstream/state')!.seq)
    expect(reference.ticketSeq).toBe(events.findLast(event => event.type === 'ticket/state')!.seq)
    expect(reference.participantTicketSeqs[memberId]).toBe(reference.ticketSeq)
    // Only Ticket events after the Workstream opened are recorded; the pre-open Ticket is not.
    const opened = events.find(event => event.type === 'workstream/state')!.seq
    expect(Object.values(reference.participantTicketSeqs).every(seq => seq > opened)).toBe(true)
    expect(ctx.workstreams.cursor(owner, owner.id)).toBe(owner.session.seq)

    const lastSeq = SessionSeq(events.at(-1)!.seq)
    const v1 = { workstream: { ver: 1, seq: lastSeq, val: { ownerSessionId: owner.id, snapshot: reference.snapshot } } }
    expect(ctx.sessionProjections.restoreFloor(v1)).toBe(SessionLogOffset(0))
    const restored = ctx.sessionProjections.restore(v1, events, SessionLogOffset(0), owner.session.header, SessionLogOffset(0))
    expect(restored.checkpoint['workstream']).toEqual({ ver: 2, seq: lastSeq, val: reference })
    // A version 1 row never seeds a suffix read: the caller must re-read from seq 0.
    expect(() => ctx.sessionProjections.restore(v1, events.slice(1), SessionLogOffset(1), owner.session.header,
      SessionLogOffset(0))).toThrow(/re-read from seq 0/)
  })

  it('restores a stateVersion 2 checkpoint and replays its suffix to the same state as a full replay', async () => {
    const { ctx, owner } = await setup()
    const events = owner.session.snapshotEvents()
    const reference = fullFold(owner.session)
    // Cut before the last Ticket event, so the replayed suffix must advance the recorded Ticket positions.
    const cut = events.findLast(event => event.type === 'ticket/state')!.seq
    const prefix = ctx.sessionProjections.restore({}, events.slice(0, cut), SessionLogOffset(0), owner.session.header,
      SessionLogOffset(0))
    expect(prefix.checkpoint['workstream']?.val).not.toEqual(reference)
    const floor = ctx.sessionProjections.restoreFloor(prefix.checkpoint)!
    expect(floor).toBeGreaterThan(0)
    const resumed = ctx.sessionProjections.restore(prefix.checkpoint, events.slice(floor), floor, owner.session.header,
      SessionLogOffset(0))
    expect(resumed.checkpoint['workstream']?.val).toEqual(reference)
  })

  it('after a restart, a cursor read before it neither misses a later change nor repeats it', async () => {
    const { ctx, fiber, handle, owner } = await setup()
    const revision = ctx.workstreams.get(owner, owner.id).revision
    const cursor = ctx.workstreams.cursor(owner, owner.id)
    await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Committed before the restart', description: 'Owner sees it' })
    await fiber.dispose()
    await handle.dispose()
    await ctx.plugin(WorkstreamService)
    const { agent: resumed } = await ctx.agents.resume({ resumeSessionId: ROOT, agentOptions: model })
    const first = await ctx.workstreams.waitForChange(resumed, ROOT, { afterRevision: revision, afterCursor: cursor, timeoutMs: 60_000,
      signal })
    expect(first).toEqual({ timedOut: false, revision, cursor: resumed.session.seq })
    await expect(ctx.workstreams.waitForChange(resumed, ROOT, { afterRevision: first.revision, afterCursor: first.cursor, timeoutMs: 100,
      signal })).resolves.toEqual({ timedOut: true, revision, cursor: resumed.session.seq })
  })
})
