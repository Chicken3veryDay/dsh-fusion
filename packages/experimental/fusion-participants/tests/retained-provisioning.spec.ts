/** Real eager cache checkpoints cannot overtake retained owner durability. */
import { readFile, writeFile, rm } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { JsonlBackendTracker } from '../../../session/session-persistence-jsonl/src/storage.ts'
import { publicFixture } from './execution-public-harness.ts'
import { mount } from './harness.ts'

for (const enabled of [false, true]) it(`provisions before granting or preparing effects with eager cache ${enabled}`, async () => {
  const trace: object[] = []
  // oxlint-disable-next-line typescript/unbound-method -- invoked with the exact tracker receiver.
  const flush = JsonlBackendTracker.prototype.flushSessionDurably
  vi.spyOn(JsonlBackendTracker.prototype, 'flushSessionDurably').mockImplementation(async function (this: JsonlBackendTracker, ctx, session, provider) {
    const writer = this['writers'].get(session.id)
    if (writer == null) throw new Error('Expected actual current writer')
    const inventory = () => ({
      session: session.id, boundary: session.seq, sameSession: this['bindings'].get(writer) === session,
      sameWriter: this['writers'].get(session.id) === writer, sameProvider: ctx.get('sessionPersistence')?.identity === provider,
      cursor: writer['state'].cursor, flushed: writer['flushedCursor'], buffered: writer['buffered'].map((e: SessionEvent) => e.seq),
      generation: writer.durabilityGeneration, receipt: this['flushReceipts'].get(writer) ?? 0,
    })
    const before = inventory()
    const result = await flush.call(this, ctx, session, provider)
    const after = inventory()
    expect(result, 'initial owner event requires actual current writer coverage').toMatchObject({ kind: 'durable' })
    if (result.kind !== 'durable') throw new Error('Missing initial durability')
    const path = await writer['storage'].resolveCurrentLog(session.id)
    if (path === undefined) throw new Error('Missing actual JSONL path')
    const jsonl = await readFile(path, 'utf8')
    const committed = jsonl.trim().split('\n').map(line => JSON.parse(line) as { seq?: number }).filter(row => row.seq !== undefined)
    expect(committed.slice(0, result.boundary), 'owner prefix is on disk before provisioning returns').toEqual(session.ownEvents().slice(0, result.boundary))
    expect(result.session).toBe(session)
    expect(result.writer).toBe(writer.durabilityIdentity)
    expect(after).toMatchObject({ sameSession: true, sameWriter: true, sameProvider: true })
    expect(after.cursor).toBeGreaterThanOrEqual(result.boundary)
    expect(after.flushed).toBeGreaterThanOrEqual(result.boundary)
    expect(after.generation).toBeGreaterThan(before.generation)
    expect(after.receipt).toBeGreaterThan(before.receipt)
    trace.push({ before, after, boundary: result.boundary, path, jsonl })
    return result
  })
  const f = await publicFixture(undefined, enabled)
  try {
    expect(Boolean(f.ctx.get('sessionProjectionCache'))).toBe(enabled)
    expect(trace.length).toBeGreaterThan(0)
    expect([f.control.registrations, f.control.preparations, f.control.bodies, f.model.requests.length]).toEqual([0, 0, 0, 0])
    await f.grant()
    const attempt = f.host.reserve(f.bind(), 'edit')
    await f.host.register(attempt)
    expect([f.control.registrations, f.control.preparations, f.control.bodies]).toEqual([1, 0, 0])
    expect(await f.host.release(attempt)).toEqual({ kind: 'settled', outcome: 'completed' })
    expect([f.control.preparations, f.control.bodies, f.control.cleanups, f.model.requests.length]).toEqual([1, 1, 1, 0])
  } finally { await f.dispose() }
  if (process.env.DSH_PROVISIONING_EVIDENCE !== undefined) {
    await writeFile(`${process.env.DSH_PROVISIONING_EVIDENCE}-${enabled}.json`, JSON.stringify({ enabled, trace,
      counts: { registrations: f.control.registrations, preparations: f.control.preparations, bodies: f.control.bodies,
        cleanups: f.control.cleanups, requests: f.model.requests.length } }, null, 2) + '\n')
  }
})

it('blocks participant publication and all requests when the actual JSONL directory cannot be created', async () => {
  const { ctx, adapter, root } = await mount(undefined, 'none', false, true)
  // A file at the configured root makes the real filesystem operation fail.
  await rm(root, { recursive: true, force: true })
  await writeFile(root, 'not a session directory')
  try {
    const result = await ctx.fusionParticipants.prepare('single-test').then(() => undefined, (error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect(result).toMatchObject({ code: 'fusion-participants/preparation-blocked', cleanup: 'complete' })
    if (!(result instanceof Error)) throw new Error('Missing preparation failure')
    const causes: unknown[] = []
    const collect = (error: unknown): void => {
      causes.push(error)
      if (error instanceof AggregateError) for (const child of error.errors) collect(child)
      if (error instanceof Error && error.cause !== undefined) collect(error.cause)
    }
    collect(result)
    expect(causes.some(cause => cause instanceof Error && 'code' in cause && cause.code === 'ENOTDIR')).toBe(true)
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.agents.list()).toHaveLength(0)
  } finally {
    await rm(root, { force: true })
  }
})
