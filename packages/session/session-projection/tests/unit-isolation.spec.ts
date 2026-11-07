/**
 * SessionProjectionRegistry per-unit failure containment: a unit whose `init`
 * or `apply` throws for one Session fails only for that unit and Session. Later
 * units keep their eager drive and notifications, reads of the failed key throw
 * a typed error naming the unit and Session, the failure is logged once,
 * checkpoints omit the failed row, and a replacement registration recovers it.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry, { SessionProjectionUnitError } from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/isolation-fragile': { marks: number }
    'test/isolation-marks': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/isolation-mark': { mark: string }
    'test/isolation-break': Record<string, never>
  }
}

type WireDefinition<K extends 'test/isolation-fragile' | 'test/isolation-marks', S> =
  Omit<ProjectionDefinition<K, S>, 'wire'> & { wire: NonNullable<ProjectionDefinition<K, S>['wire']> }

const fragileViewSchema = z.object({ marks: z.number().int().nonnegative() })

/** Counts marks; throws on a break event unless `tolerant`, or in `init` when `failInit`. */
const fragileUnit = (options: { tolerant?: boolean; failInit?: boolean } = {}): WireDefinition<'test/isolation-fragile', number> => ({
  key: 'test/isolation-fragile',
  stateSchema: z.number().int().nonnegative(),
  init: () => {
    if (options.failInit === true) throw new Error('fragile init broke')
    return 0
  },
  apply: (state, event) => {
    if (event.type === 'test/isolation-break' && options.tolerant !== true) throw new Error('fragile apply broke')
    return event.type === 'test/isolation-mark' ? state + 1 : state
  },
  wire: {
    viewSchema: fragileViewSchema,
    view: state => ({ marks: state }),
  },
  stateVersion: 1,
})

const marksViewSchema = z.object({ marks: z.array(z.string()) })

/** Registered after the fragile unit; collects every mark. */
const marksUnit = (): WireDefinition<'test/isolation-marks', { marks: string[] }> => ({
  key: 'test/isolation-marks',
  stateSchema: marksViewSchema,
  init: () => ({ marks: [] }),
  apply: (state, event) => (event.type === 'test/isolation-mark' ? { marks: [...state.marks, event.data.mark] } : state),
  wire: {
    viewSchema: marksViewSchema,
    view: state => state,
  },
  stateVersion: 1,
})

/** Host-only unit that throws on a break event. */
const fragileHostUnit = (): ProjectionDefinition<'test/isolation-host', number> => ({
  key: 'test/isolation-host',
  stateSchema: z.number().int().nonnegative(),
  init: () => 0,
  apply: (state, event) => {
    if (event.type === 'test/isolation-break') throw new Error('host apply broke')
    return state + 1
  },
  stateVersion: 1,
})

async function harness(): Promise<{ ctx: Context; broken: Session; healthy: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, broken: ctx.sessions.create(), healthy: ctx.sessions.create() }
}

const mark = (session: Session, value: string): void => {
  session.append('test/isolation-mark', { mark: value })
}

/** Run `read` and return the SessionProjectionUnitError it throws. */
function unitErrorOf(read: () => unknown): SessionProjectionUnitError {
  try {
    read()
  } catch (error) {
    if (error instanceof SessionProjectionUnitError) return error
    throw error
  }
  throw new Error('expected a SessionProjectionUnitError')
}

describe('SessionProjectionRegistry unit failure isolation', () => {
  it('keeps later units driving eagerly after an earlier unit throws in apply for one Session', async () => {
    const { ctx, broken, healthy } = await harness()
    const errorLog = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const fragile = await ctx.sessionProjections.register(fragileUnit())
    const marks = await ctx.sessionProjections.register(marksUnit())
    const changes: string[] = []
    ctx.sessionProjections.onChanged((session, key, value) => {
      changes.push(`${session === broken ? 'broken' : 'healthy'}:${key}:${JSON.stringify(value)}`)
    })

    mark(broken, 'a')
    const breakEvent = broken.append('test/isolation-break', {})
    mark(broken, 'b')
    mark(healthy, 'c')

    expect(changes).toEqual([
      'broken:test/isolation-fragile:{"marks":1}',
      'broken:test/isolation-marks:{"marks":["a"]}',
      'broken:test/isolation-marks:{"marks":["a","b"]}',
      'healthy:test/isolation-fragile:{"marks":1}',
      'healthy:test/isolation-marks:{"marks":["c"]}',
    ])
    expect(marks.stateOf(broken)).toEqual({ marks: ['a', 'b'] })
    expect(ctx.sessionProjections.snapshot(broken, ['test/isolation-marks'])).toEqual({
      asOfSeq: broken.seq - 1,
      values: { 'test/isolation-marks': { marks: ['a', 'b'] } },
    })
    // The failing unit's own state is only discarded for the failed Session.
    expect(fragile.stateOf(healthy)).toBe(1)

    const failure = unitErrorOf(() => fragile.stateOf(broken))
    expect(failure).toMatchObject({
      name: 'SessionProjectionUnitError',
      key: 'test/isolation-fragile',
      sessionId: broken.id,
      phase: 'apply',
      seq: breakEvent.seq,
    })
    expect(failure.cause).toEqual(new Error('fragile apply broke'))
    expect(unitErrorOf(() => ctx.sessionProjections.snapshot(broken))).toBe(failure)
    expect(unitErrorOf(() => ctx.sessionProjections.snapshot(broken, ['test/isolation-fragile']))).toBe(failure)
    expect(ctx.sessionProjections.cachedSnapshot(broken)?.values).toEqual({ 'test/isolation-marks': { marks: ['a', 'b'] } })
    expect(ctx.sessionProjections.snapshot(healthy).values).toEqual({
      'test/isolation-fragile': { marks: 1 },
      'test/isolation-marks': { marks: ['c'] },
    })

    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog.mock.calls[0]?.[0]).toEqual(expect.stringContaining(`session projection "test/isolation-fragile" failed for Session "${broken.id}" in apply at seq ${String(breakEvent.seq)}: fragile apply broke`))
  })

  it('reports an init failure for a lazily built cell without blocking other keys', async () => {
    const { ctx, broken } = await harness()
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    mark(broken, 'before')
    const fragile = await ctx.sessionProjections.register(fragileUnit({ failInit: true }))
    await ctx.sessionProjections.register(marksUnit())
    mark(broken, 'after')

    expect(unitErrorOf(() => fragile.stateOf(broken))).toMatchObject({ key: 'test/isolation-fragile', phase: 'init', seq: -1 })
    expect(ctx.sessionProjections.snapshot(broken, ['test/isolation-marks']).values).toEqual({
      'test/isolation-marks': { marks: ['before', 'after'] },
    })
  })

  it('leaves full snapshots readable when only a host-only unit failed', async () => {
    const { ctx, broken } = await harness()
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const host = await ctx.sessionProjections.register(fragileHostUnit())
    await ctx.sessionProjections.register(marksUnit())
    mark(broken, 'a')
    broken.append('test/isolation-break', {})
    mark(broken, 'b')

    expect(ctx.sessionProjections.snapshot(broken).values).toEqual({ 'test/isolation-marks': { marks: ['a', 'b'] } })
    expect(unitErrorOf(() => host.stateOf(broken))).toMatchObject({ key: 'test/isolation-host', phase: 'apply' })
  })

  it('omits the failed unit from checkpoints and keeps the other rows current', async () => {
    const { ctx, broken, healthy } = await harness()
    vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await ctx.sessionProjections.register(fragileUnit())
    await ctx.sessionProjections.register(marksUnit())
    mark(broken, 'a')
    broken.append('test/isolation-break', {})
    mark(broken, 'b')
    mark(healthy, 'c')

    expect(ctx.sessionProjections.checkpoint(broken)).toEqual({
      'test/isolation-marks': { ver: 1, seq: broken.seq - 1, val: { marks: ['a', 'b'] } },
    })
    expect(ctx.sessionProjections.checkpoint(healthy)).toEqual({
      'test/isolation-fragile': { ver: 1, seq: healthy.seq - 1, val: 1 },
      'test/isolation-marks': { ver: 1, seq: healthy.seq - 1, val: { marks: ['c'] } },
    })
  })

  it('recovers the failed key when a replacement registration folds the Session successfully', async () => {
    const { ctx, broken } = await harness()
    const errorLog = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    let failedHandle: { stateOf(session: Session): number } | undefined
    const failing = await ctx.plugin(Object.assign(async (inner: Context) => {
      failedHandle = await inner.sessionProjections.register(fragileUnit())
    }, { inject: ['sessionProjections'] }))
    await ctx.sessionProjections.register(marksUnit())
    mark(broken, 'a')
    broken.append('test/isolation-break', {})
    expect(() => ctx.sessionProjections.snapshot(broken)).toThrow(SessionProjectionUnitError)
    expect(ctx.sessionProjections.checkpoint(broken)['test/isolation-fragile']).toBeUndefined()

    await failing.dispose()
    const changes: string[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      changes.push(`${key}:${JSON.stringify(value)}`)
    })
    const replacement = await ctx.sessionProjections.register(fragileUnit({ tolerant: true }))
    expect(replacement.stateOf(broken)).toBe(1)
    mark(broken, 'b')

    // The replacement registers after the marks unit, so it now drives second.
    expect(changes).toEqual(['test/isolation-marks:{"marks":["a","b"]}', 'test/isolation-fragile:{"marks":2}'])
    expect(ctx.sessionProjections.snapshot(broken).values).toEqual({
      'test/isolation-fragile': { marks: 2 },
      'test/isolation-marks': { marks: ['a', 'b'] },
    })
    expect(ctx.sessionProjections.checkpoint(broken)['test/isolation-fragile']).toEqual({ ver: 1, seq: broken.seq - 1, val: 2 })
    // A retained handle keeps reading its original unit, so it keeps the failure.
    expect(unitErrorOf(() => failedHandle?.stateOf(broken))).toMatchObject({ key: 'test/isolation-fragile', phase: 'apply' })
    expect(errorLog).toHaveBeenCalledTimes(1)
  })
})
