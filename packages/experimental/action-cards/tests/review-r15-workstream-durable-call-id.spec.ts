/** Prototype-named card call ids survive the durable projection cache: write, reopen, cold read. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Cache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { actionCardProjection } from '../src/projection.ts'

const args = { action: 'test_action', title: 'Counter', brief: 'Keep count visible', details: { value: 'a' } }

async function setup(id: string) {
  const root = await mkdtemp(join(tmpdir(), 'review-r15-cards-'))
  const ctx = new Context()
  onTestFinished(async () => { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  await ctx.sessionProjections.register(actionCardProjection)
  const fiber = await ctx.plugin(Cache, { writeEveryEvents: 100_000, writeIntervalMs: 60_000 })
  const session = ctx.sessions.create(SessionId(`r15-${id === '__proto__' ? 'proto' : id}`))
  const call = (callId: string, turn: number) => session.append('tool/call', {
    turn, step: 1, callId: ToolCallId(callId), name: 'propose_action', arguments: JSON.stringify(args),
  })
  const result = (callId: string, turn: number) => {
    // A JSON round trip drops the factory's undefined optional fields, as a stored event would.
    const message = createToolResultMessage({ callId: ToolCallId(callId), content: [], isError: false })
    session.append('tool/result', { turn, step: 1, message: JSON.parse(JSON.stringify(message)) as typeof message }, { surfaceOp: 'append' })
  }
  const stored = async () => readFile(join(root, 'session_projcache', 'sessions', `${session.id}.json`), 'utf8')
  return { ctx, fiber, session, call, result, stored }
}

for (const id of ['ordinary', '__proto__']) {
  it(`keeps a pending and an admitted card with call id ${id} through a durable checkpoint and cold read`, async () => {
    const f = await setup(id)
    f.session.append('turn/start', { turn: 1 })
    f.call(id, 1)
    // Durable cut while the call waits for its result.
    await f.ctx.sessionProjectionCache.write(f.session)
    expect(await f.stored()).toContain(`"${id}"`)
    f.result(id, 1)
    f.session.append('turn/start', { turn: 2 })
    f.call('next', 2)
    f.result('next', 2)
    await f.fiber.dispose()
    await f.ctx.plugin(Cache, { writeEveryEvents: 100_000, writeIntervalMs: 60_000 })
    const warn = vi.spyOn(f.ctx.logger, 'warn')
    const cold = f.ctx.sessionProjectionCache.coldSnapshot(f.session.header, SessionLogOffset(0), f.session.snapshotEvents())
    expect(warn).not.toHaveBeenCalled()
    const view = cold.values.actionCards
    expect(view === undefined ? [] : Object.keys(view.proposals)).toEqual([id, 'next'])
    expect(view !== undefined && Object.hasOwn(view.decisions, id) ? view.decisions[id]?.phase : undefined).toBe('replaced')
    expect(view).toEqual(f.ctx.sessionProjections.snapshot(f.session, ['actionCards']).values.actionCards)
  })
}
