/** Opt-in withdrawal holds exact publication until every fenced producer joins. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '../src/index.ts'

let ctx: Context
beforeEach(async () => { ctx = new Context(); await ctx.plugin(Sessions) })
afterEach(async () => { await ctx.fiber.dispose() })

it('fences all producers synchronously, publishes a stable reentrant join and retains ordinary publication', async () => {
  const session = ctx.sessions.prepare(SessionId('withdraw'))
  const terminal = Promise.withResolvers<undefined>()
  const calls: string[] = []
  let reentrant: Promise<void> | undefined
  const detach = ctx.sessions.enter(session, { withdraw: () => {
    calls.push('retained')
    reentrant = detach()
    return terminal.promise
  } })
  ctx.sessions.announce(session)
  ctx.sessions.registerWithdrawal(session, () => { calls.push('execution'); return Promise.resolve() })
  let disposed = 0
  ctx.on('session/disposed', (target) => {
    expect(target).toBe(session)
    expect(() => target.append('turn/start', { turn: 2 })).toThrow('outside a SessionStore')
    disposed++
  })
  const join = detach()
  expect(calls).toEqual(['retained', 'execution'])
  expect(reentrant).toBe(join)
  expect(detach()).toBe(join)
  expect(ctx.sessions.get(session.id)).toBe(session)
  expect(() => ctx.sessions.enter(ctx.sessions.prepare(session.id))).toThrow('already exists')
  expect(() => ctx.sessions.registerWithdrawal(session, () => Promise.resolve())).toThrow('cannot register')
  session.append('turn/start', { turn: 1 })
  expect(disposed).toBe(0)
  terminal.resolve(undefined)
  await join
  expect(ctx.sessions.get(session.id)).toBeUndefined()
  expect(disposed).toBe(1)
  await detach()
  expect(disposed).toBe(1)
})

it('invokes every stop despite synchronous throws and retains all original failures without retry', async () => {
  const first = new Error('producer stop failed'), second = { reason: 'join unknown' }
  const session = ctx.sessions.prepare(SessionId('failed'))
  let stops = 0
  const detach = ctx.sessions.enter(session, { withdraw: () => { stops++; throw first } })
  ctx.sessions.announce(session)
  ctx.sessions.registerWithdrawal(session, () => { stops++; return Promise.reject(second) })
  const last = Promise.withResolvers<undefined>()
  ctx.sessions.registerWithdrawal(session, () => { stops++; return last.promise })
  const join = detach()
  const observed = join.catch((error: unknown) => error)
  expect(stops).toBe(3)
  expect(ctx.sessions.get(session.id)).toBe(session)
  last.resolve(undefined)
  const failure = await observed
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error('missing aggregate')
  expect(failure.errors).toEqual([first, second])
  expect(failure.errors[0]).toBe(first)
  expect(failure.errors[1]).toBe(second)
  expect(await detach().catch((error: unknown) => error)).toBe(failure)
  expect(ctx.sessions.get(session.id)).toBe(session)
  expect(stops).toBe(3)
})

it('retains captured joins after unregistration and excludes removed producers before capture', async () => {
  const session = ctx.sessions.prepare(SessionId('capture'))
  const pending = Promise.withResolvers<undefined>()
  const detach = ctx.sessions.enter(session, { withdraw: () => pending.promise })
  ctx.sessions.announce(session)
  const calls: string[] = []
  const removed = ctx.sessions.registerWithdrawal(session, () => { calls.push('removed'); return Promise.resolve() })
  removed()
  const active = ctx.sessions.registerWithdrawal(session, () => { calls.push('active'); return pending.promise })
  const join = detach()
  active()
  expect(calls).toEqual(['active'])
  expect(ctx.sessions.get(session.id)).toBe(session)
  pending.resolve(undefined)
  await join
  expect(ctx.sessions.get(session.id)).toBeUndefined()
})

it.each(['created', 'append'] as const)('keeps %s dispatch semantics while starting opted-in withdrawal', async (phase) => {
  const session = ctx.sessions.prepare(SessionId(phase))
  const terminal = Promise.withResolvers<undefined>()
  let stopped = false
  const detach = ctx.sessions.enter(session, { withdraw: () => { stopped = true; return terminal.promise } })
  let join: Promise<void> | undefined
  ctx.on(phase === 'created' ? 'session/created' : 'session/event', () => {
    join = detach()
    expect(stopped).toBe(true)
    expect(ctx.sessions.get(session.id)).toBe(session)
    expect(() => session.append('turn/start', { turn: 2 })).toThrow()
  })
  ctx.sessions.announce(session)
  if (phase === 'append') session.append('turn/start', { turn: 1 })
  expect(join).toBe(detach())
  terminal.resolve(undefined)
  await join
  expect(ctx.sessions.get(session.id)).toBeUndefined()
})

it('requires an opted-in exact entry for producer registration and keeps stock detach synchronous', () => {
  const session = ctx.sessions.prepare(SessionId('stock'))
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  expect(() => ctx.sessions.registerWithdrawal(session, () => Promise.resolve())).toThrow('cannot register')
  expect(detach()).toBeUndefined()
  expect(ctx.sessions.get(session.id)).toBeUndefined()
  expect(detach()).toBeUndefined()
  expect(() => ctx.sessions.registerWithdrawal(session, () => Promise.resolve())).toThrow('not live')
})
