/** Dormant production denial and real final-dispatch admission under held races. */
import { expect, it, vi } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { fixture, gate } from './execution-harness.ts'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
import { mount } from './harness.ts'

it('publishes immutable closed authority with no executable callbacks, requests or input claims', async () => {
  const { ctx, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  try {
    expect(task.execution).toMatchObject({ phase: 'closed', owner: null, blockers: ['integration-missing'], attempts: [] })
    expect(Object.isFrozen(task.execution)).toBe(true)
    expect(Object.isFrozen(task.execution.attempts)).toBe(true)
    expect(Object.values(task.execution).some(value => typeof value === 'function')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
  } finally { await task.dispose() }
})

it('registers synchronously and dispatches exactly once only after durable start', async () => {
  const f = await fixture()
  try {
    await f.grant()
    const work = f.owner.attempt(f.bind(), 'edit')
    expect(f.owner.snapshot().attempts).toHaveLength(1)
    await work
    expect(f.control.bodies).toBe(1)
    expect(f.control.cleanups).toBe(1)
    expect(f.owner.snapshot().attempts).toHaveLength(0)
    const state = f.projection.stateOf(f.child.session)
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]?.settlement?.outcome).toBe('completed')
    const reader = await f.ctx.sessionPersistence.open(f.child.session.id, 'read')
    try { expect((await reader.read()).events.some(event => event.type === 'fusion/effect-settled')).toBe(true) }
    finally { await reader.close() }
  } finally { await f.dispose() }
})

for (const phase of ['wrapper', 'body', 'cleanup'] as const) {
  it(`cuts admission synchronously and retains cleanup before successor grant while ${phase} is held`, async () => {
    const f = await fixture()
    const hold = gate()
    f.control[phase] = hold
    let work: Promise<void> | undefined
    let revoke: Promise<void> | undefined
    let successor: Promise<void> | undefined
    try {
      await f.grant()
      const old = f.bind()
      work = f.owner.attempt(old, 'edit')
      await hold.entered.promise
      revoke = f.owner.revoke('handoff')
      expect(f.owner.snapshot().owner).toBeNull()
      await expect(f.owner.attempt(old, 'edit')).rejects.toThrow()
      let granted = false
      successor = f.grant().then(() => { granted = true })
      await setImmediate()
      expect(granted).toBe(false)
      hold.resume.resolve(undefined)
      await work
      await revoke
      await successor
      expect(f.control.bodies).toBe(phase === 'wrapper' ? 0 : 1)
      expect(f.owner.snapshot()).toMatchObject({ generation: 2, phase: 'granted' })
      await expect(f.owner.attempt(old, 'edit')).rejects.toThrow()
    } finally {
      hold.resume.resolve(undefined)
      await Promise.allSettled([work, revoke, successor])
      await f.dispose()
    }
  })
}

it('authenticates opaque issuers/runs/controllers and keeps host reads separate from mutation ownership', async () => {
  const f = await fixture()
  try {
    expect(() => f.owner.bindRun({}, f.agent, new AbortController().signal)).toThrow('integration-missing')
    await expect(f.owner.grant({}, f.child.session.id)).rejects.toThrow('integration-missing')
    await expect(f.owner.attempt({}, 'read')).rejects.toThrow('integration-missing')
    const run = f.bind()
    await expect(f.owner.attempt(run, 'edit')).rejects.toThrow('not-owner')
    f.control.classification = 'read'
    await f.owner.attempt(run, 'inspect')
    expect(f.control.bodies).toBe(1)
    f.control.classification = undefined
    await expect(f.owner.attempt(run, 'shell')).rejects.toThrow()
  } finally { await f.dispose() }
})

it('checks current policy and host classification again after asynchronous wrappers', async () => {
  const f = await fixture()
  const hold = gate()
  f.control.wrapper = hold
  try {
    await f.grant()
    const work = f.owner.attempt(f.bind(), 'edit')
    await hold.entered.promise
    f.control.classification = 'read'
    hold.resume.resolve(undefined)
    await work
    expect(f.control.bodies).toBe(0)
    expect(f.projection.stateOf(f.child.session).entries[0]?.settlement?.outcome).toBe('not-dispatched')
  } finally { hold.resume.resolve(undefined); await f.dispose() }
})

for (const boundary of ['start', 'result'] as const) {
  it(`joins a held ${boundary} durability barrier before granting a successor`, async () => {
    const f = await fixture()
    const hold = gate()
    // oxlint-disable-next-line typescript/unbound-method -- invoked below with the observed handle receiver.
    const original = JsonlSessionHandle.prototype.flushRetained
    let held = false
    vi.spyOn(JsonlSessionHandle.prototype, 'flushRetained').mockImplementation(async function (this: JsonlSessionHandle, session, seq) {
      const entry = f.projection.stateOf(f.child.session).entries[0]
      if (this.id === f.child.session.id && !held && entry !== undefined
        && (boundary === 'start' ? entry.settlement === null : entry.settlement !== null)) {
        held = true; hold.entered.resolve(undefined); await hold.resume.promise
      }
      return original.call(this, session, seq)
    })
    let work: Promise<void> | undefined
    let revoke: Promise<void> | undefined
    let successor: Promise<void> | undefined
    try {
      await f.grant()
      work = f.owner.attempt(f.bind(), 'edit')
      await hold.entered.promise
      expect(f.control.bodies).toBe(boundary === 'start' ? 0 : 1)
      revoke = f.owner.revoke('handoff')
      let granted = false
      successor = f.grant().then(() => { granted = true })
      await setImmediate()
      expect(granted).toBe(false)
      hold.resume.resolve(undefined)
      await work; await revoke; await successor
      expect(f.control.bodies).toBe(boundary === 'start' ? 0 : 1)
    } finally {
      hold.resume.resolve(undefined)
      await Promise.allSettled([work, revoke, successor])
      await f.dispose()
    }
  })
}

it('orders revoke after an in-flight grant and can grant again after its drain', async () => {
  const f = await fixture()
  const hold = gate()
  // oxlint-disable-next-line typescript/unbound-method -- invoked below with the observed handle receiver.
  const original = JsonlSessionHandle.prototype.flushRetained
  let held = false
  vi.spyOn(JsonlSessionHandle.prototype, 'flushRetained').mockImplementation(async function (this: JsonlSessionHandle, session, seq) {
    if (this.id === f.root.session.id && !held) { held = true; hold.entered.resolve(undefined); await hold.resume.promise }
    return original.call(this, session, seq)
  })
  let granting: Promise<void> | undefined
  let revoked: Promise<void> | undefined
  try {
    granting = f.grant()
    await hold.entered.promise
    revoked = f.owner.revoke('handoff')
    hold.resume.resolve(undefined)
    await expect(granting).rejects.toThrow('revoked-during-grant')
    await revoked
    expect(f.projection.stateOf(f.root.session).revoke?.generation).toBe(1)
    await f.grant()
    expect(f.owner.snapshot()).toMatchObject({ generation: 2, phase: 'granted' })
  } finally { hold.resume.resolve(undefined); await Promise.allSettled([granting, revoked]); await f.dispose() }
})

it('registers before host classification and rolls back a synchronously revoked setup', async () => {
  const f = await fixture()
  let revoked: Promise<void> | undefined
  try {
    await f.grant()
    f.control.onClassify = () => {
      f.control.onClassify = undefined
      expect(f.owner.snapshot().attempts).toHaveLength(1)
      revoked = f.owner.revoke('handoff')
    }
    await expect(f.owner.attempt(f.bind(), 'edit')).rejects.toThrow()
    await revoked
    expect(f.owner.snapshot().attempts).toHaveLength(0)
    expect(f.control.bodies).toBe(0)
    await f.grant()
  } finally { f.control.onClassify = undefined; await f.dispose() }
})

for (const which of ['root', 'participant'] as const) {
  it(`fences a held final dispatch synchronously on public ${which} writer close and drains before unlocking`, async () => {
    const f = await fixture()
    const hold = gate()
    f.control.wrapper = hold
    let work: Promise<void> | undefined
    let closing: Promise<void> | undefined
    try {
      await f.grant()
      work = f.owner.attempt(f.bind(), 'edit')
      await hold.entered.promise
      const handle = f.handles.find(row => row.id === (which === 'root' ? f.root.session.id : f.child.session.id))
      if (handle === undefined) throw new Error('missing writer')
      let closed = false
      closing = handle.close().then(() => { closed = true })
      expect(f.owner.snapshot().owner).toBeNull()
      await setImmediate()
      expect(closed).toBe(false)
      hold.resume.resolve(undefined)
      await work; await f.owner.dispose(); await closing
      expect(f.control.bodies).toBe(0)
      expect(f.control.cleanups).toBe(1)
    } finally {
      hold.resume.resolve(undefined)
      await Promise.allSettled([work, closing])
      await f.dispose()
    }
  })
}

it('revalidates policy after a held wrapper without dispatching the body', async () => {
  const f = await fixture()
  const hold = gate()
  f.control.wrapper = hold
  try {
    await f.grant()
    const work = f.owner.attempt(f.bind(), 'edit')
    await hold.entered.promise
    f.control.policy = false
    hold.resume.resolve(undefined)
    await work
    expect(f.control.bodies).toBe(0)
  } finally { hold.resume.resolve(undefined); await f.dispose() }
})

for (const lifecycle of ['withdrawal', 'restart'] as const) {
  it(`fences admitted real execution during ${lifecycle} and joins its cleanup`, async () => {
    const f = await fixture()
    const hold = gate()
    f.control.wrapper = hold
    let work: Promise<void> | undefined
    let stopping: Promise<unknown> | undefined
    try {
      await f.grant()
      work = f.owner.attempt(f.bind(), 'edit')
      await hold.entered.promise
      {
        const fiber = [...f.ctx.registry.get(Jsonl)?.fibers ?? []][0]
        if (fiber === undefined) throw new Error('missing provider lifetime')
        stopping = Promise.resolve(lifecycle === 'restart' ? fiber.restart() : fiber.dispose())
      }
      expect(f.owner.snapshot().owner).toBeNull()
      hold.resume.resolve(undefined)
      await work; await f.owner.dispose(); await stopping
      expect(f.control.bodies).toBe(0)
      expect(f.control.cleanups).toBe(1)
    } finally { hold.resume.resolve(undefined); await Promise.allSettled([work, stopping]); await f.dispose() }
  })
}

it('excludes an independent provider while an admitted effect and cleanup retain the actual writer', async () => {
  const f = await fixture()
  const hold = gate()
  f.control.cleanup = hold
  let work: Promise<void> | undefined
  try {
    await f.grant()
    work = f.owner.attempt(f.bind(), 'edit')
    await hold.entered.promise
    const observer = await mount(f.directory)
    await expect(observer.ctx.sessionPersistence.open(f.child.session.id, 'write')).rejects.toThrow()
    hold.resume.resolve(undefined)
    await work
    await f.dispose()
    const next = await observer.ctx.sessionPersistence.open(f.child.session.id, 'write')
    await next.close()
  } finally { hold.resume.resolve(undefined); await work; await f.dispose() }
})
