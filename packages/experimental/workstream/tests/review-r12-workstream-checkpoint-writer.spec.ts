/** Real Workstream/Ticket writers must produce checkpoints accepted by their current schema. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import ProjectionCache, { checkpointRecord, projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'
import { workstreamProjectionDefinition as projection } from '../src/projection.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'review-r12-workstream-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  const cacheFiber = await ctx.plugin(ProjectionCache, { writeEveryEvents: 100_000, writeIntervalMs: 60_000 })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' } })
  const owner = handle.agent
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Checkpoint probe' })
  await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Root Ticket', description: 'Records coordinator position' })
  return { ctx, owner, handle, cacheFiber }
}

describe('checkpoints produced by the public Workstream and Ticket APIs', () => {
  for (const id of ['ordinary-root', '__proto__']) {
    it(`accepts the checkpoint produced for Session ${id}`, async () => {
      const { ctx, owner } = await setup(id)
      const row = ctx.sessionProjections.checkpoint(owner.session)['workstream']!
      // No fabricated cache payload: both source events were committed by the actual services above.
      expect(projection.stateSchema.safeParse(row.val).success).toBe(true)
    })

    it(`cold-reads its own persisted checkpoint for Session ${id}`, async () => {
      const { ctx, owner, cacheFiber } = await setup(id)
      await ctx.sessionProjectionCache.write(owner.session)
      await cacheFiber.dispose()
      await ctx.plugin(ProjectionCache, { writeEveryEvents: 100_000, writeIntervalMs: 60_000 })
      const events = owner.session.snapshotEvents()
      const reference = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), owner.session.header, SessionLogOffset(0))
      expect(() => ctx.sessionProjectionCache.coldSnapshot(owner.session.header, SessionLogOffset(0), events)).not.toThrow()
      expect(ctx.sessionProjectionCache.coldSnapshot(owner.session.header, SessionLogOffset(0), events)).toEqual(reference.snapshot)
    })

    it(`hydrates a prepared Session from the full log despite an unusable checkpoint for ${id}`, async () => {
      const { ctx, owner } = await setup(id)
      await ctx.sessionProjectionCache.write(owner.session)
      const events = owner.session.snapshotEvents()
      const prepared = Session.create(owner.id, events, owner.session.header)
      expect(ctx.sessionProjectionCache.hydratePrepared(prepared, events).values['workstream'])
        .toEqual(ctx.workstreams.get(owner, owner.id))
    })

    it(`serves its own checkpoint on the cached listing path for Session ${id}`, async () => {
      const { ctx, owner } = await setup(id)
      await ctx.sessionProjectionCache.write(owner.session)
      expect(ctx.sessionProjectionCache.cachedSnapshot(owner.session.header)?.values['workstream'])
        .toEqual(ctx.workstreams.get(owner, owner.id))
    })
  }

  it('drops a synthetic impossible row from listing and recovers cold reads and prepared Sessions from the full log', async () => {
    const { ctx, owner, cacheFiber } = await setup('synthetic-malformed')
    await ctx.sessionProjectionCache.write(owner.session)
    await cacheFiber.dispose()
    const domain = await ctx.storageDomain.open(projectionCacheDomainSpec)
    try {
      const table = domain.table('sessions')
      const record = table.get(owner.id)!
      const row = record.rows['workstream']!
      const state = projection.stateSchema.parse(row.val)
      await table.put(owner.id, checkpointRecord.parse({ ...record, rows: { ...record.rows,
        workstream: { ...row, val: { ...state, snapshotSeq: null } } } }))
    } finally { await domain.close() }
    await ctx.plugin(ProjectionCache, { writeEveryEvents: 100_000, writeIntervalMs: 60_000 })
    expect(ctx.sessionProjectionCache.cachedSnapshot(owner.session.header)?.values['workstream']).toBeUndefined()
    const events = owner.session.snapshotEvents()
    // The registry discards the schema-rejected row, so the cold read refolds the full log like hydratePrepared.
    const reference = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), owner.session.header, SessionLogOffset(0))
    expect(ctx.sessionProjectionCache.coldSnapshot(owner.session.header, SessionLogOffset(0), events)).toEqual(reference.snapshot)
    const prepared = Session.create(owner.id, events, owner.session.header)
    expect(ctx.sessionProjectionCache.hydratePrepared(prepared, events).values['workstream'])
      .toEqual(ctx.workstreams.get(owner, owner.id))
  })
})
