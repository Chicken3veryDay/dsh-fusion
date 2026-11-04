/** Caller ownership ends with task cleanup, including failed preparation and cleanup. */
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import Participants from '../src/index.ts'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
import { mount } from './harness.ts'

const callerHooks = (ctx: Context) => ctx.fiber.getEffects().filter(effect => effect.label === 'fusion-participants.caller').length

it('releases caller hooks after repeated preparation and recovery while retaining live ownership', async () => {
  const { ctx, adapter } = await mount()
  for (let index = 0; index < 5; index++) {
    const task = await ctx.fusionParticipants.prepare('single-test')
    expect(callerHooks(ctx)).toBe(1)
    await task.dispose()
    expect(callerHooks(ctx)).toBe(0)
    const recovered = await ctx.fusionParticipants.recover(task.roster.rootSessionId)
    expect(callerHooks(ctx)).toBe(1)
    await recovered.dispose()
    expect(callerHooks(ctx)).toBe(0)
  }
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
})

it('releases hooks after failures before acquisition, during provisioning and during recovery', async () => {
  const { ctx } = await mount()
  await expect(ctx.fusionParticipants.prepare('absent')).rejects.toThrow()
  expect(callerHooks(ctx)).toBe(0)
  await expect(ctx.fusionParticipants.recover(SessionId('missing-root'))).rejects.toThrow()
  expect(callerHooks(ctx)).toBe(0)
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockResolvedValue({ kind: 'refused', reason: 'unsupported' })
  await expect(ctx.fusionParticipants.prepare('single-test')).rejects.toMatchObject({ cleanup: 'complete' })
  expect(callerHooks(ctx)).toBe(0)
  expect(ctx.sessions.list()).toHaveLength(0)
})

it('caller cancellation joins a live task and retains its hook until held cleanup settles', async () => {
  const { ctx } = await mount()
  const caller = createScope(ctx, {})
  const task = await caller.ctx.get('fusionParticipants')!.prepare('single-test')
  const resident = await task.adopt('participant')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  await resident.agent.ctx.plugin((owner) => {
    owner.effect(() => async () => { entered.resolve(undefined); await release.promise })
  })
  expect(callerHooks(caller.ctx)).toBe(1)
  let settled = false
  const disposal = caller.dispose().then(() => { settled = true })
  try {
    await entered.promise
    await setImmediate()
    expect(settled).toBe(false)
    expect(ctx.sessions.list()).toHaveLength(2)
    await expect(task.adopt('participant')).rejects.toThrow()
  } finally { release.resolve(undefined); await disposal }
  expect(callerHooks(caller.ctx)).toBe(0)
  expect(ctx.sessions.list()).toHaveLength(0)
  await task.dispose()
})

it('releases caller hooks on failed task cleanup without discarding the owner failure', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const resident = await task.adopt('participant')
  const failure = new Error('descendant cleanup failed')
  await resident.agent.ctx.plugin((owner) => { owner.effect(() => () => { throw failure }) })
  const disposal = task.dispose()
  await expect(disposal).rejects.toThrow('participant task cleanup failed')
  expect(callerHooks(ctx)).toBe(0)
  expect(task.dispose()).toBe(disposal)
  expect(ctx.sessions.list()).toHaveLength(2)
  const logger = vi.spyOn(ctx.logger, 'error')
  await [...ctx.registry.get(Participants)!.fibers][0]!.dispose()
  expect(logger).toHaveBeenCalled()
})

it('releases caller hooks on unknown rollback while preserving cleanup errors at owner shutdown', async () => {
  const { ctx } = await mount()
  const failure = new Error('rollback writer close failed')
  // oxlint-disable-next-line typescript/unbound-method -- invoked on its original receiver.
  const close = JsonlSessionHandle.prototype.close
  vi.spyOn(JsonlSessionHandle.prototype, 'close').mockImplementation(async function (this: JsonlSessionHandle) {
    const writable = this.access === 'write'
    await close.call(this)
    if (writable) throw failure
  })
  vi.spyOn(ctx.agentPresets, 'mount').mockRejectedValue(new Error('composition failed'))
  await expect(ctx.fusionParticipants.prepare('single-test')).rejects.toMatchObject({ cleanup: 'unknown' })
  expect(callerHooks(ctx)).toBe(0)
  const logger = vi.spyOn(ctx.logger, 'error')
  await [...ctx.registry.get(Participants)!.fibers][0]!.dispose()
  expect(logger).toHaveBeenCalled()
})
