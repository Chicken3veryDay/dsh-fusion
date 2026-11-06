/** Authoritative projection rereads bypass ready caches and supersede older requests. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionManager } from '../src/client/sessions/manager.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'

const root = SessionId('root')
type Read = SessionRemotes['session']['projections']
const baseline = (title: string, asOfSeq: number): Awaited<ReturnType<Read>> => ({
  ok: true, value: { kind: 'sequenced', asOfSeq, values: { title } },
})

it('rereads a ready projection cache and preserves a newer control frame', async () => {
  const response = Promise.withResolvers<Awaited<ReturnType<Read>>>()
  const projections = vi.fn<Read>().mockResolvedValueOnce(baseline('old', 1)).mockReturnValueOnce(response.promise)
  const manager = new SessionManager({ session: { projections } } as never)
  try {
    await manager.refreshProjections(root)
    const refresh = manager.refreshProjections(root, true)
    expect(projections).toHaveBeenCalledTimes(2)
    manager.handleControlFrame({ type: 'projection', sessionId: root, key: 'title', value: 'newer frame', seq: 3 })
    response.resolve(baseline('reread', 2))
    await refresh
    expect(manager.projectionValues(root)?.title).toBe('newer frame')
  } finally {
    response.resolve(baseline('cleanup', 0))
    await manager.dispose()
  }
})

it('a forced reread cannot reuse or be overwritten by a pre-conflict read', async () => {
  const old = Promise.withResolvers<Awaited<ReturnType<Read>>>()
  const projections = vi.fn<Read>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(baseline('current', 2))
  const manager = new SessionManager({ session: { projections } } as never)
  try {
    const pending = manager.refreshProjections(root)
    const reread = manager.refreshProjections(root, true)
    expect(projections).toHaveBeenCalledTimes(2)
    await reread
    expect(projections.mock.calls[0]?.[1]?.aborted).toBe(true)
    old.resolve(baseline('outdated', 1))
    await pending
    expect(manager.projectionValues(root)?.title).toBe('current')
  } finally {
    old.resolve(baseline('cleanup', 0))
    await manager.dispose()
  }
})

it('a forced reread rejects transport failures while keeping the last successful values', async () => {
  const failure = new RemoteError('gateway/internal', 'offline', {})
  const projections = vi.fn<Read>().mockResolvedValueOnce(baseline('retained', 1)).mockResolvedValueOnce({ ok: false, error: failure })
  const manager = new SessionManager({ session: { projections } } as never)
  try {
    await manager.refreshProjections(root)
    await expect(manager.refreshProjections(root, true)).rejects.toBe(failure)
    expect(manager.projectionValues(root)?.title).toBe('retained')
  } finally { await manager.dispose() }
})

it.each([null, { kind: 'migration-required' as const, values: { title: 'cached' } }])(
  'a forced reread rejects a non-authoritative result %j', async (value) => {
    const projections = vi.fn<Read>().mockResolvedValue({ ok: true, value })
    const manager = new SessionManager({ session: { projections } } as never)
    try {
      await expect(manager.refreshProjections(root, true)).rejects.toThrow('baseline is unavailable')
    } finally { await manager.dispose() }
  },
)

it('a superseded authoritative reread rejects instead of claiming recovery', async () => {
  const old = Promise.withResolvers<Awaited<ReturnType<Read>>>()
  const projections = vi.fn<Read>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(baseline('current', 2))
  const manager = new SessionManager({ session: { projections } } as never)
  try {
    const pending = manager.refreshProjections(root, true)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'session/projections-unavailable' })
    await manager.refreshProjections(root, true)
    old.resolve(baseline('outdated', 1))
    await rejected
    expect(manager.projectionValues(root)?.title).toBe('current')
  } finally {
    old.resolve(baseline('cleanup', 0))
    await manager.dispose()
  }
})

it('disposal waits for a cancelled authoritative reread without treating cancellation as a teardown failure', async () => {
  const response = Promise.withResolvers<Awaited<ReturnType<Read>>>()
  const projections = vi.fn<Read>().mockReturnValue(response.promise)
  const manager = new SessionManager({ session: { projections } } as never)
  try {
    const pending = manager.refreshProjections(root, true)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'session/projections-unavailable' })
    const disposed = manager.dispose()
    expect(projections.mock.calls[0]?.[1]?.aborted).toBe(true)
    response.resolve(baseline('cancelled', 1))
    await rejected
    await disposed
  } finally {
    response.resolve(baseline('cleanup', 0))
    await manager.dispose()
  }
})

it('an ordinary caller joining a forced reread keeps expected failures in projection state', async () => {
  const response = Promise.withResolvers<Awaited<ReturnType<Read>>>()
  const projections = vi.fn<Read>().mockReturnValue(response.promise)
  const manager = new SessionManager({ session: { projections } } as never)
  try {
    const forced = manager.refreshProjections(root, true)
    const rejected = expect(forced).rejects.toMatchObject({ code: 'gateway/internal' })
    const ordinary = manager.refreshProjections(root)
    const ordinarySettled = expect(ordinary).resolves.toBeUndefined()
    response.resolve({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
    await rejected
    await ordinarySettled
    expect(projections).toHaveBeenCalledOnce()
  } finally {
    response.resolve(baseline('cleanup', 0))
    await manager.dispose()
  }
})
