/** Initialization rollback and task teardown retain exact writer ownership. */
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { fixture, gate } from './execution-harness.ts'

it('rolls back a known partial writer acquisition before returning initialization failure', async () => {
  const f = await fixture({ open: false })
  const reserve = f.ctx.sessionPersistence.reserveSessionWriter.bind(f.ctx.sessionPersistence)
  const spy = vi.spyOn(f.ctx.sessionPersistence, 'reserveSessionWriter').mockImplementation(session =>
    session === f.child.session ? { kind: 'refused', reason: 'missing-writer' } : reserve(session))
  try {
    const opening = f.owner.open()
    expect(f.owner.open()).toBe(opening)
    await expect(opening).rejects.toThrow('missing-writer')
    const rootHandle = f.handles.find(row => row.id === f.root.session.id)
    if (rootHandle === undefined) throw new Error('missing root handle')
    expect(rootHandle).toHaveProperty('hasReservations', false)
    await rootHandle.close()
    expect(f.projection.stateOf(f.root.session).opened).toBeNull()
  } finally { spy.mockRestore(); await f.dispose() }
})

it('publishes the disposal join before reentrant transport cleanup and retains writers until it settles', async () => {
  const hold = gate()
  let reentry: Promise<void> | undefined
  const f = await fixture({ configure: options => ({ ...options, drain: async () => {
    reentry = dispose?.()
    hold.entered.resolve(undefined)
    await hold.resume.promise
  } }) })
  const dispose = () => f.owner.dispose()
  let closing: Promise<void> | undefined
  try {
    const first = f.owner.dispose()
    await hold.entered.promise
    expect(reentry).toBe(first)
    expect(f.owner.dispose()).toBe(first)
    const handle = f.handles.find(row => row.id === f.root.session.id)
    if (handle === undefined) throw new Error('missing root handle')
    let closed = false
    closing = handle.close().then(() => { closed = true })
    await setImmediate()
    expect(closed).toBe(false)
    hold.resume.resolve(undefined)
    await first
    await closing
  } finally { hold.resume.resolve(undefined); await closing; await f.dispose() }
})

it('removes task and reservation listeners after a normal disposal', async () => {
  const lifetime = new AbortController()
  const f = await fixture({ configure: options => ({ ...options, signal: lifetime.signal }) })
  const remove = vi.spyOn(lifetime.signal, 'removeEventListener')
  try {
    await f.owner.dispose()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    lifetime.abort()
    expect(f.owner.snapshot().phase).toBe('stopped')
  } finally { await f.dispose() }
})

it('retains task leases when its execution cleanup cannot establish completion', async () => {
  const { TaskExecutionOwner } = await import('../src/execution.ts')
  const { mount } = await import('./harness.ts')
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const stop = vi.spyOn(TaskExecutionOwner.prototype, 'dispose').mockRejectedValue(new Error('execution cleanup unknown'))
  try {
    await expect(task.dispose()).rejects.toThrow('participant task drain failed')
    await expect(ctx.sessionPersistence.open(task.roster.rootSessionId, 'write')).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
  } finally { stop.mockRestore() }
})
