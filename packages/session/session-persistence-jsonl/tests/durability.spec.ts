/** Host durability uses the actual Session store, routed JSONL writer and persisted bytes. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistence, SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlPlugin from '../src/index.ts'
import { JsonlSessionHandle } from '../src/storage.ts'
import { LEASE_FILENAME } from '../src/lease.ts'
import { sessionDir } from '../src/format.ts'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const contexts: Context[] = []
const roots: string[] = []
const handles: SessionHandle[] = []
const releases: (() => void)[] = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  vi.restoreAllMocks()
  for (const handle of handles.splice(0)) await handle.close()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function mount(
  root?: string,
  compression: JsonlPlugin.JsonlCompression = 'none',
): Promise<{ ctx: Context; root: string }> {
  if (root === undefined) {
    root = await mkdtemp(join(tmpdir(), 'dsh-durability-'))
    roots.push(root)
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPlugin, { root, compression })
  return { ctx, root }
}

async function owned(ctx: Context, id = 'durable') {
  const session = ctx.sessions.prepare(SessionId(id))
  const writer = await ctx.sessionPersistence.create(session.header)
  handles.push(writer)
  if (!(writer instanceof JsonlSessionHandle)) throw new Error('Expected JSONL writer')
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  return { session, writer, detach }
}

async function read(ctx: Context, session: Session): Promise<readonly SessionEvent[]> {
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  try { return (await reader.read()).events } finally { await reader.close() }
}

function barrier() {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  return { entered, release }
}

it('requires an owned routed writer even when stock flush has a successful listener', async () => {
  const { ctx } = await mount()
  const session = ctx.sessions.create(SessionId('missing'))
  ctx.on('session/flush', () => {})
  expect(await ctx.sessions.flush(session)).toBe(true)
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toEqual({ kind: 'refused', reason: 'missing-writer' })
  expect(await ctx.sessionPersistence.stat(session.id)).toBeUndefined()
})

it('materializes an empty session and verifies fresh coverage on each operation', async () => {
  const { ctx, root } = await mount()
  const { session, writer } = await owned(ctx)
  const first = await ctx.sessionPersistence.flushSessionDurably(session)
  expect(first).toMatchObject({ kind: 'durable', session, boundary: 0, writer: writer.durabilityIdentity })
  const second = await ctx.sessionPersistence.flushSessionDurably(session)
  expect(second).toMatchObject({ kind: 'durable', boundary: 0 })
  if (first.kind !== 'durable' || second.kind !== 'durable') throw new Error('Missing proof')
  expect(second.operation).not.toBe(first.operation)
  const remounted = await mount(root)
  expect(await read(remounted.ctx, session)).toEqual([])
  expect(await remounted.ctx.sessionPersistence.stat(session.id)).toBeDefined()
  // A no-op handle flush cannot borrow the previous operation's receipt.
  vi.spyOn(writer, 'flush').mockResolvedValue(undefined)
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'coverage' })
})

it('refuses a bound writer with matching events but a different session header', async () => {
  const { ctx, root } = await mount()
  const session = ctx.sessions.create(SessionId('different-header'), { meta: { delegationDepth: 0 } })
  const header = { ...session.header, createdAt: session.header.createdAt + 1 }
  const writer = await ctx.sessionPersistence.create(header)
  handles.push(writer)
  const event = session.append('turn/start', { turn: 1 })

  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'coverage' })
  const remounted = await mount(root)
  const reader = await remounted.ctx.sessionPersistence.open(session.id, 'read')
  try {
    expect(reader.header).toEqual(header)
    expect((await reader.read()).events).toEqual([event])
  } finally {
    await reader.close()
  }
})

it.each(['none', 'zstd'] as const)('waits for append acknowledgement and certifies the captured boundary (%s)', async (compression) => {
  const { ctx, root } = await mount(undefined, compression)
  const { session, writer } = await owned(ctx)
  session.append('turn/start', { turn: 1 })
  const gate = barrier()
  const storage = writer['storage']
  const persist = storage.persistBatch.bind(storage)
  vi.spyOn(storage, 'persistBatch').mockImplementationOnce(async (...args) => {
    gate.entered.resolve(undefined)
    await gate.release.promise
    await persist(...args)
  })
  let settled = false
  const pending = ctx.sessionPersistence.flushSessionDurably(session).then((result) => { settled = true; return result })
  await gate.entered.promise
  expect(settled).toBe(false)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  gate.release.resolve(undefined)
  expect(await pending).toMatchObject({ kind: 'durable', boundary: 1 })
  const remounted = await mount(root, compression)
  expect(await read(remounted.ctx, session)).toEqual(session.snapshotEvents())
})

it('waits for the actual handle flush and refuses its rejection even if another listener succeeds', async () => {
  const { ctx } = await mount()
  const { session, writer } = await owned(ctx)
  session.append('turn/start', { turn: 1 })
  ctx.on('session/flush', () => {})
  const gate = barrier()
  const failure = new Error('flush refused')
  vi.spyOn(writer, 'flush').mockImplementationOnce(async () => {
    gate.entered.resolve(undefined)
    await gate.release.promise
    throw failure
  })
  let settled = false
  const pending = ctx.sessionPersistence.flushSessionDurably(session).then((result) => { settled = true; return result })
  await gate.entered.promise
  expect(settled).toBe(false)
  gate.release.resolve(undefined)
  expect(await pending).toEqual({ kind: 'refused', reason: 'flush-failed', cause: failure })
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'durable', boundary: 1 })
  expect(await read(ctx, session)).toEqual(session.snapshotEvents())
})

it('cannot replace a missing routed append with an unrelated successful flush', async () => {
  const { ctx } = await mount()
  const { session, writer } = await owned(ctx)
  const route = writer.enqueueLive.bind(writer)
  const withheld: Parameters<JsonlSessionHandle['enqueueLive']>[] = []
  const spy = vi.spyOn(writer, 'enqueueLive').mockImplementation((...args) => { withheld.push(args) })
  session.append('turn/start', { turn: 1 })
  ctx.on('session/flush', () => {})
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'coverage' })
  expect(await read(ctx, session)).toEqual([])
  spy.mockRestore()
  for (const args of withheld) route(...args)
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'durable', boundary: 1 })
  expect(await read(ctx, session)).toEqual(session.snapshotEvents())
})

it('rejects equal event counts with different contents', async () => {
  const { ctx } = await mount()
  const { session, writer } = await owned(ctx)
  const route = vi.spyOn(writer, 'enqueueLive').mockImplementation(() => {})
  const event = session.append('turn/start', { turn: 1 })
  await writer.append([{ ...event, time: event.time + 1 }])
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'coverage' })
  expect(await read(ctx, session)).toEqual([{ ...event, time: event.time + 1 }])
  route.mockRestore()
})

it('rejects a different Session object with the same id and an already bound writer', async () => {
  const { ctx } = await mount()
  const { session, writer } = await owned(ctx)
  // A second store can publish the same identity; the backend may not lend the first object's writer.
  const otherCtx = new Context()
  contexts.push(otherCtx)
  await otherCtx.plugin(SessionStore)
  const otherStore = otherCtx.sessions
  const other = otherStore.create(session.id, { meta: session.header })
  const live = vi.spyOn(ctx.sessions, 'get').mockReturnValue(other)
  expect(await ctx.sessionPersistence.flushSessionDurably(other)).toMatchObject({ kind: 'refused', reason: 'missing-writer' })
  live.mockRestore()
  expect(await ctx.sessionPersistence.flushSessionDurably(Session.create(session.id))).toMatchObject({ kind: 'refused', reason: 'not-live' })
  expect(writer.durabilityOpen).toBe(true)
})

it('refuses session removal while the store flush is suspended', async () => {
  const { ctx } = await mount()
  const { session, detach, writer } = await owned(ctx)
  const gate = barrier()
  const flushed = Promise.withResolvers<undefined>()
  const flush = writer.flush.bind(writer)
  vi.spyOn(writer, 'flush').mockImplementationOnce(async () => { await flush(); flushed.resolve(undefined) })
  ctx.on('session/flush', async () => { gate.entered.resolve(undefined); await gate.release.promise })
  const pending = ctx.sessionPersistence.flushSessionDurably(session)
  await gate.entered.promise
  await flushed.promise
  detach()
  await writer.close()
  gate.release.resolve(undefined)
  expect(await pending).toMatchObject({ kind: 'refused', reason: 'stale-writer' })
})

it('refuses a writer closed during flush and permits a later reopen on the same storage', async () => {
  const { ctx, root } = await mount()
  const { session, writer } = await owned(ctx)
  session.append('turn/start', { turn: 1 })
  const gate = barrier()
  const flush = writer.flush.bind(writer)
  vi.spyOn(writer, 'flush').mockImplementationOnce(async () => {
    await flush()
    gate.entered.resolve(undefined)
    await gate.release.promise
  })
  const pending = ctx.sessionPersistence.flushSessionDurably(session)
  await gate.entered.promise
  await writer.close()
  gate.release.resolve(undefined)
  expect(await pending).toMatchObject({ kind: 'refused', reason: 'stale-writer' })
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'missing-writer' })
  const remounted = await mount(root)
  const reopened = await remounted.ctx.sessionPersistence.open(session.id, 'write')
  handles.push(reopened)
  const stored = await reopened.read()
  const resumed = remounted.ctx.sessions.prepare(session.id, {
    seed: [...stored.events], meta: reopened.header, eventState: stored.eventState,
    inheritedEventCount: reopened.inheritedEventCount,
  })
  // Restore can add an unpublished end-seed marker; the owning lifecycle appends that suffix before publication.
  await reopened.append(resumed.snapshotEvents().slice(stored.events.length))
  remounted.ctx.sessions.enter(resumed)
  remounted.ctx.sessions.announce(resumed)
  expect(await remounted.ctx.sessionPersistence.flushSessionDurably(resumed)).toMatchObject({ kind: 'durable', boundary: resumed.seq })
  expect(await read(remounted.ctx, resumed)).toEqual(resumed.snapshotEvents())
})

it('rejects writer replacement after verification but before returning the result', async () => {
  const { ctx } = await mount()
  const { session, writer } = await owned(ctx)
  const gate = barrier()
  const verify = writer.verifyDurability.bind(writer)
  vi.spyOn(writer, 'verifyDurability').mockImplementationOnce(async (...args) => {
    const result = await verify(...args)
    expect(result).toBe(true)
    gate.entered.resolve(undefined)
    await gate.release.promise
    return result
  })
  const pending = ctx.sessionPersistence.flushSessionDurably(session)
  await gate.entered.promise
  await writer.close()
  const replacement = await ctx.sessionPersistence.open(session.id, 'write')
  handles.push(replacement)
  gate.release.resolve(undefined)
  expect(await pending).toMatchObject({ kind: 'refused', reason: 'stale-writer' })
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'missing-writer' })
})

it.runIf(process.platform !== 'win32')('refuses ownership lost by replacement of the POSIX lock inode', async () => {
  const { ctx, root } = await mount()
  const { session } = await owned(ctx)
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'durable' })
  const path = join(sessionDir(root, session.header.cwd, session.id), LEASE_FILENAME)
  await unlink(path)
  await writeFile(path, '')
  const result = await ctx.sessionPersistence.flushSessionDurably(session)
  expect(result).toMatchObject({ kind: 'refused', reason: 'flush-failed' })
  if (result.kind !== 'refused' || result.reason !== 'flush-failed') throw new Error('Missing ownership refusal')
  expect(result.cause).toBeInstanceOf(SessionOwnershipLostError)
})

it('does not certify read-only storage and fails a lazy lease refusal', async () => {
  const { ctx, root } = await mount()
  const { session, writer } = await owned(ctx)
  const rival = await mount(root)
  const competing = await rival.ctx.sessionPersistence.create(session.header)
  handles.push(competing)
  await competing.flush()
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'flush-failed' })
  await writer.close()
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  handles.push(reader)
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'missing-writer' })
})

it('refuses an unbound empty writer even though legacy flush materializes it', async () => {
  const { ctx } = await mount()
  const session = ctx.sessions.create(SessionId('unbound'))
  const writer = await ctx.sessionPersistence.create(session.header)
  handles.push(writer)
  expect(await ctx.sessions.flush(session)).toBe(true)
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'missing-writer' })
  expect(await read(ctx, session)).toEqual([])
})

it('keeps an append rejection a refusal and recovers only after the retained batch persists', async () => {
  const { ctx, root } = await mount()
  const { session, writer } = await owned(ctx)
  session.append('turn/start', { turn: 1 })
  const gate = barrier()
  const failure = new Error('append refused')
  vi.spyOn(writer['storage'], 'persistBatch').mockImplementationOnce(async () => {
    gate.entered.resolve(undefined)
    await gate.release.promise
    throw failure
  })
  let settled = false
  const pending = ctx.sessionPersistence.flushSessionDurably(session).then((result) => { settled = true; return result })
  await gate.entered.promise
  expect(settled).toBe(false)
  gate.release.resolve(undefined)
  expect(await pending).toEqual({ kind: 'refused', reason: 'flush-failed', cause: failure })
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'durable' })
  expect(await read((await mount(root)).ctx, session)).toEqual(session.snapshotEvents())
})

it('requires a true store result and lets unsupported providers refuse explicitly', async () => {
  const { ctx } = await mount()
  const { session } = await owned(ctx)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (target) => { await flush(target); return false })
  expect(await ctx.sessionPersistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused', reason: 'coverage' })
  expect(await SessionPersistence.prototype.flushSessionDurably.call(ctx.sessionPersistence, session)).toEqual({ kind: 'refused', reason: 'unsupported' })
})

it.each([false, true])('verifies seeded prefix content rather than trusting equal counts (different=%s)', async (different) => {
  const { ctx, root } = await mount()
  const source = Session.create(SessionId('source'))
  source.append('turn/start', { turn: 1 })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const session = ctx.sessions.prepare(SessionId('seeded'), {
    seed: [...source.snapshotEvents()], meta: { isSeeded: true }, inheritedEventCount: source.seq,
  })
  const writer = await ctx.sessionPersistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
  handles.push(writer)
  const prefix = session.snapshotEvents()
  await writer.append(different ? prefix.map(event => ({ ...event, time: event.time + 1 })) : prefix)
  ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const result = await ctx.sessionPersistence.flushSessionDurably(session)
  expect(result).toMatchObject(different ? { kind: 'refused', reason: 'coverage' } : { kind: 'durable', boundary: prefix.length })
  const persisted = await read((await mount(root)).ctx, session)
  expect(persisted).toEqual(different ? prefix.map(event => ({ ...event, time: event.time + 1 })) : prefix)
})

it('cannot borrow another session’s successful flush coverage through a listener', async () => {
  const { ctx, root } = await mount()
  const left = await owned(ctx, 'left')
  const right = await owned(ctx, 'right')
  vi.spyOn(left.writer, 'enqueueLive').mockImplementation(() => {})
  left.session.append('turn/start', { turn: 1 })
  right.session.append('turn/start', { turn: 1 })
  ctx.on('session/flush', async (session) => {
    if (session !== left.session) return
    expect(await ctx.sessionPersistence.flushSessionDurably(right.session)).toMatchObject({ kind: 'durable', boundary: 1 })
  })
  expect(await ctx.sessionPersistence.flushSessionDurably(left.session)).toMatchObject({ kind: 'refused', reason: 'coverage' })
  const remounted = await mount(root)
  expect(await read(remounted.ctx, left.session)).toEqual([])
  expect(await read(remounted.ctx, right.session)).toEqual(right.session.snapshotEvents())
})
