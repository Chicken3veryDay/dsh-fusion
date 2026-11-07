/** Unknown writers remain owned by this fork until its process exits. */
import { expect, it, vi } from 'vitest'
import { publicFixture } from './execution-public-harness.ts'

it.each(['allocation', 'cancel', 'cleanup', 'invoke', 'uncertain', 'start', 'result', 'release'] as const)(
  'reports %s uncertainty and retains ownership without dispatching another effect', async (phase) => {
    const f = await publicFixture()
    await f.grant()
    const run = f.bind()
    if (run === undefined) throw new Error('Expected run')
    const abort = new AbortController()
    const effectRun = phase === 'cancel' ? f.host.bindRun(f.host.issuer, f.adopted.agent, abort.signal) : run
    const attempt = f.host.reserve(effectRun, 'operation')
    if (phase === 'allocation') f.control.onRegister = () => { throw new Error('allocator unknown') }
    if (phase === 'cancel') f.control.cancelError = new Error('cancel unknown')
    if (phase === 'cleanup') f.control.cleanupError = new Error('cleanup unknown')
    if (phase === 'invoke') f.control.invokeError = new Error('invocation unknown')
    if (phase === 'uncertain') f.control.outcome = 'uncertain'
    if (phase === 'allocation') {
      await expect(f.host.register(attempt)).rejects.toThrow('allocator unknown')
      await expect(f.host.release(attempt)).resolves.toMatchObject({ kind: 'blocked', reason: 'cleanup-unknown' })
    } else {
      await f.host.register(attempt)
      if (phase === 'cancel') abort.abort()
      if (phase === 'start') vi.spyOn(f.adopted.agent.session, 'matchesDurabilityPrefix').mockResolvedValue(false)
      if (phase === 'result') f.control.onInvoke = () => {
        vi.spyOn(f.adopted.agent.session, 'matchesDurabilityPrefix').mockResolvedValue(false)
      }
      if (phase === 'release') {
        // The reservation flushes twice before release; fail only its release acknowledgement.
        let acknowledgements = 0
        const original = f.adopted.agent.session.matchesDurabilityPrefix.bind(f.adopted.agent.session)
        vi.spyOn(f.adopted.agent.session, 'matchesDurabilityPrefix').mockImplementation(async (...args) =>
          ++acknowledgements > 2 ? false : original(...args))
      }
      expect(await f.host.release(attempt)).toMatchObject({ kind: 'blocked' })
    }
    expect(f.task.execution.phase).toBe('blocked')
    expect(f.task.execution.unknown).toHaveLength(1)
    expect(f.control.bodies).toBe(['allocation', 'cancel', 'start'].includes(phase) ? 0 : 1)
    await expect(f.host.dispose()).rejects.toThrow()
    await expect(f.ctx.sessionPersistence.open(f.adopted.agent.session.id, 'write')).rejects.toThrow()
  },
)

it('keeps enrollment rollback uncertainty blocked when a partial writer cannot be released', async () => {
  const { mount } = await import('./harness.ts')
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const reserve = ctx.sessionPersistence.reserveSessionWriter.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'reserveSessionWriter').mockImplementation((session) => {
    if (session.id !== task.roster.rootSessionId) return { kind: 'refused', reason: 'missing-writer' }
    const reserved = reserve(session)
    return reserved.kind !== 'reserved' ? reserved : { kind: 'reserved', reservation: { ...reserved.reservation,
      release: async () => { throw new Error('rollback unavailable') },
    } }
  })
  const provider = { name: 'rollback', revision: '1', classify: () => undefined,
    registerHeld: () => { throw new Error('must not allocate') } }
  await expect(ctx.fusionParticipants.registerExecutionHost(task, provider)).rejects.toThrow('enrollment-cleanup')
  expect(task.execution.phase).toBe('blocked')
  await expect(task.dispose()).rejects.toThrow()
})

it('settles a reservation already cancelled by its writer before registration', async () => {
  const f = await publicFixture()
  await f.grant()
  const reserve = f.ctx.sessionPersistence.reserveSessionWriter.bind(f.ctx.sessionPersistence)
  vi.spyOn(f.ctx.sessionPersistence, 'reserveSessionWriter').mockImplementation((session) => {
    const reserved = reserve(session)
    return reserved.kind !== 'reserved' ? reserved : { kind: 'reserved', reservation: { ...reserved.reservation,
      signal: AbortSignal.abort(new Error('writer withdrawn')),
    } }
  })
  const attempt = f.host.reserve(f.bind(), 'edit')
  expect(await f.host.release(attempt)).toEqual({ kind: 'settled', outcome: 'not-dispatched' })
  expect(f.control.registrations).toBe(0)
  expect(f.control.bodies).toBe(0)
  await f.dispose()
})

it('cancels an anchor returned by a reentrant registration callback without entering its payload', async () => {
  const f = await publicFixture()
  await f.grant()
  const abort = new AbortController()
  const attempt = f.host.reserve(f.bind(abort.signal), 'edit')
  f.control.onRegister = () => { abort.abort(new Error('cancel during allocation')) }
  await expect(f.host.register(attempt)).rejects.toThrow('cancel during allocation')
  expect(await f.host.release(attempt)).toEqual({ kind: 'settled', outcome: 'not-dispatched' })
  expect(f.control.cancellations).toBe(1)
  expect(f.control.cleanups).toBe(1)
  expect(f.control.bodies).toBe(0)
  await f.dispose()
})

it('keeps a legacy attempt uncertain when its Session withdraws before dispatch', async () => {
  const { fixture, gate } = await import('./execution-harness.ts')
  const f = await fixture()
  await f.grant()
  const hold = gate()
  f.control.wrapper = hold
  const work = f.owner.attempt(f.bind(), 'edit')
  await hold.entered.promise
  const failed = expect(work).rejects.toThrow('outcome-unknown')
  const closing = f.child.dispose()
  const withdrawn = expect(closing).rejects.toThrow()
  expect(f.ctx.sessions.isWithdrawing(f.child.session)).toBe(true)
  hold.resume.resolve(undefined)
  await Promise.all([failed, withdrawn])
  expect(f.control.bodies).toBe(0)
  expect(f.owner.snapshot().unknown).toHaveLength(1)
})
