/** Schema-rejected cache rows recover without changing the cold-read and prepared-Session durability rules. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import Sessions, { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Cache, { checkpointRecord, projectionCacheDomainSpec } from '../src/index.ts'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'review-r13-cache-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  const apply = vi.fn((state: number) => state + 1)
  await ctx.sessionProjections.register({ key: 'review/count', stateVersion: 1,
    stateSchema: z.number().int().nonnegative(), init: () => 0, apply })
  const header: import('@deepseek-ai/dsh-session').SessionHeader = { id: SessionId('discard-cache'), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const domain = await ctx.storageDomain.open(projectionCacheDomainSpec)
  await domain.table('sessions').put(header.id, {
    identity: { formatVersion: header.version, createdAt: 0, isSeeded: false, inheritedEventCount: SessionLogOffset(0) },
    rows: { 'review/count': { ver: 1, seq: SessionSeq(1), val: 'rejected number' } },
  })
  await domain.close()
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const fiber = await ctx.plugin(Cache, { writeEveryEvents: 100_000, writeIntervalMs: 60_000 })
  const whenWritten = () => new Promise<void>((resolve) => {
    const stop = ctx.on('domain/changed', (change) => {
      if (change.domain !== projectionCacheDomainSpec.name || change.table !== 'sessions' || change.key !== header.id
        || change.operation !== 'put') return
      stop(); resolve()
    })
  })
  const stored = async () => z.object({ record: checkpointRecord }).parse(
    JSON.parse(await readFile(join(root, 'session_projcache', 'sessions', `${header.id}.json`), 'utf8')))
  return { ctx, apply, header, events, warn, fiber, whenWritten, stored }
}

it('refolds the rejected row, durably replaces it, and seeds a second cold read after reopening the cache', async () => {
  const f = await setup()
  const written = f.whenWritten()
  expect(f.ctx.sessionProjectionCache.coldSnapshot(f.header, SessionLogOffset(0), f.events)).toEqual({ asOfSeq: 1, values: {} })
  await written
  expect(f.apply).toHaveBeenCalledTimes(2)
  expect(f.warn).toHaveBeenCalledTimes(1)
  await f.fiber.dispose()
  await f.ctx.plugin(Cache, { writeEveryEvents: 100_000, writeIntervalMs: 60_000 })
  expect((await f.stored()).record.rows['review/count']).toEqual({ ver: 1, seq: 1, val: 2 })
  f.apply.mockClear()
  const rewritten = f.whenWritten()
  expect(f.ctx.sessionProjectionCache.coldSnapshot(f.header, SessionLogOffset(0), f.events)).toEqual({ asOfSeq: 1, values: {} })
  await rewritten
  expect(f.apply).not.toHaveBeenCalled()
  expect(f.warn).toHaveBeenCalledTimes(1)
})

it('hydrates an unpublished Session from the rejected row without persisting its observation', async () => {
  const f = await setup()
  const prepared = Session.create(f.header.id, f.events, f.header)
  expect(f.ctx.sessionProjectionCache.hydratePrepared(prepared, f.events)).toEqual({ asOfSeq: 1, values: {} })
  expect(f.apply).toHaveBeenCalledTimes(2)
  expect(f.ctx.sessionProjections.checkpoint(prepared)['review/count']).toEqual({ ver: 1, seq: prepared.seq - 1, val: prepared.seq })
  expect((await f.stored()).record.rows['review/count']?.val).toBe('rejected number')
})
