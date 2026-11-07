import { expect, it, vi } from 'vitest'
import type { ExecutionHostProvider } from '../src/index.ts'
import { fixture } from './execution-harness.ts'

function provider(): ExecutionHostProvider {
  return { name: 'admission-test', revision: '1', classify: () => 'read', registerHeld: () => ({
    prepare: async () => ({ invoke: async () => 'completed' }), cancel() {}, async cleanup() {},
  }) }
}

it('memoizes exact-provider enrollment and refuses enrollment before open or after disposal', async () => {
  const cold = await fixture({ open: false })
  try { await expect(cold.owner.enroll(provider(), () => {})).rejects.toThrow('not-live') }
  finally { await cold.dispose() }
  const f = await fixture()
  try {
    const hostProvider = provider()
    const enrolled = f.owner.enroll(hostProvider, () => {})
    expect(f.owner.enroll(hostProvider, () => {})).toBe(enrolled)
    await expect(f.owner.enroll(provider(), () => {})).rejects.toThrow('host-replacement')
    await enrolled
    await f.owner.dispose()
    await expect(f.owner.enroll(hostProvider, () => {})).rejects.toThrow('not-live')
  } finally { await f.dispose() }
})

it('refuses a held reservation when its exact writer cannot be reserved', async () => {
  const f = await fixture()
  try {
    const host = await f.owner.enroll(provider(), () => {})
    await host.grant(host.controller, f.agent.session.id)
    const run = host.bindRun(host.issuer, f.agent, new AbortController().signal)
    const spy = vi.spyOn(f.ctx.sessionPersistence, 'reserveSessionWriter').mockReturnValue({ kind: 'refused', reason: 'missing-writer' })
    expect(() => host.reserve(run, 'inspect')).toThrow('writer')
    spy.mockRestore()
  } finally { await f.dispose() }
})

it('refuses host enrollment when an existing lifetime writer is fenced', async () => {
  let fenced = false
  const f = await fixture({ configure: (options) => {
    const reserve = options.ctx.sessionPersistence.reserveSessionWriter.bind(options.ctx.sessionPersistence)
    vi.spyOn(options.ctx.sessionPersistence, 'reserveSessionWriter').mockImplementation((session) => {
      const reserved = reserve(session)
      return reserved.kind !== 'reserved' ? reserved : { kind: 'reserved', reservation: {
        ...reserved.reservation, checkDispatch: () => fenced ? { kind: 'refused', reason: 'missing-writer' }
          : reserved.reservation.checkDispatch(),
      } }
    })
    return options
  } })
  try {
    fenced = true
    await expect(f.owner.enroll(provider(), () => {})).rejects.toThrow('writer')
    fenced = false
    expect(f.owner.snapshot().owner).toBeNull()
  } finally { await f.dispose() }
})

it('removes earlier withdrawal registrations when another Session refuses registration', async () => {
  let removed = 0
  await expect(fixture({ configure: (options) => {
    const register = options.ctx.sessions.registerWithdrawal.bind(options.ctx.sessions)
    let registrations = 0
    vi.spyOn(options.ctx.sessions, 'registerWithdrawal').mockImplementation((...args) => {
      if (++registrations === 2) throw new Error('withdrawal unavailable')
      const stop = register(...args)
      return () => { removed++; stop() }
    })
    return options
  } })).rejects.toThrow('withdrawal unavailable')
  expect(removed).toBe(1)
})

it('refuses the legacy callback protocol for an enrolled held-only issuer', async () => {
  const f = await fixture()
  const host = await f.owner.enroll(provider(), () => {})
  await host.grant(host.controller, f.agent.session.id)
  const run = host.bindRun(host.issuer, f.agent, new AbortController().signal)
  await f.owner.attempt(run, 'inspect')
  expect(f.owner.snapshot().phase).toBe('blocked')
  expect(f.control.bodies).toBe(0)
  await expect(f.owner.dispose()).rejects.toThrow('drain-unknown')
})

it('normalizes a non-Error host classification failure at the final dispatch fence', async () => {
  const f = await fixture()
  try {
    await f.grant()
    let classifications = 0
    f.control.onClassify = () => { if (++classifications === 2) throw 'classification unavailable' }
    await f.owner.attempt(f.bind(), 'edit')
    expect(f.control.bodies).toBe(0)
    expect(f.control.cleanups).toBe(1)
    const result = f.child.session.snapshotEvents().find(event => event.type === 'fusion/effect-settled')
    expect(result?.data.outcome).toBe('not-dispatched')
  } finally { await f.dispose() }
})
