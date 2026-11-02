/** Acquisition withdrawal through real Loader composition and exact JSONL writers. */
import { expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { mount } from './harness.ts'

for (const phase of ['root-created', 'participant-created', 'root-first-flush', 'participant-first-flush', 'roster-flush'] as const) {
  it(`joins ${phase} withdrawal without admitting dependent preparation`, async () => {
    const { ctx, adapter } = await mount(undefined, 'none', false, true)
    const detachers = new Map<Session, () => Promise<void>>()
    const enter = ctx.sessions.enter.bind(ctx.sessions)
    function observe(session: Session): () => void
    function observe(session: Session, options: { withdraw: () => Promise<void>; release?: () => Promise<void> }): () => Promise<void>
    function observe(session: Session, options?: { withdraw: () => Promise<void>; release?: () => Promise<void> }) {
      if (options === undefined) return enter(session)
      const detach = enter(session, options)
      detachers.set(session, detach)
      return detach
    }
    vi.spyOn(ctx.sessions, 'enter').mockImplementation(observe)
    let root: Session | undefined
    let withdrawal: Promise<void> | undefined
    let stable: Promise<void> | undefined
    const created: Session[] = []
    const withdraw = () => {
      if (withdrawal !== undefined || root === undefined) return
      const detach = detachers.get(root)!
      withdrawal = detach()
      stable = detach()
      expect(ctx.sessions.get(root.id)).toBe(root)
    }
    ctx.on('session/created', (session) => {
      root ??= session
      created.push(session)
      if (phase === 'root-created' && session === root || phase === 'participant-created' && session !== root) withdraw()
    })
    const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
    let rootFlushes = 0
    vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
      if (session === root) rootFlushes++
      if (phase === 'root-first-flush' && session === root && rootFlushes === 1
        || phase === 'participant-first-flush' && session !== root
        || phase === 'roster-flush' && session === root && rootFlushes === 2) withdraw()
      return flush(session)
    })
    try {
      await expect(ctx.fusionParticipants.prepare('single-test')).rejects.toThrow('preparation blocked')
      expect(root).toBeDefined()
      expect(withdrawal).toBeDefined()
      expect(stable).toBe(withdrawal)
      await withdrawal
      expect(ctx.sessions.list()).toHaveLength(0)
      expect(adapter.requests).toHaveLength(0)
      for (const session of created) {
        expect(session.ownEvents().some(event => event.type === 'fusion/execution-opened')).toBe(false)
        const contender = await ctx.sessionPersistence.open(session.id, 'write')
        await contender.close()
      }
    } finally { vi.restoreAllMocks() }
  })
}

it.each(['before-create', 'after-create'] as const)('joins cancellation %s without publishing a Session', async (phase) => {
  const { ctx, adapter } = await mount(undefined, 'none', false, true)
  const abort = new AbortController()
  const cause = new Error(phase)
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  let identity: Parameters<typeof create>[0] | undefined
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    identity = args[0]
    if (phase === 'before-create') abort.abort(cause)
    const writer = await create(...args)
    if (phase === 'after-create') abort.abort(cause)
    return writer
  })
  try {
    await expect(ctx.fusionParticipants.prepare('single-test', abort.signal)).rejects.toThrow('preparation blocked')
    expect(ctx.sessions.list()).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    expect(identity).toBeDefined()
    if (phase === 'after-create' && identity !== undefined) {
      expect(await ctx.sessionPersistence.stat(identity.id)).toBeUndefined()
      const contender = await ctx.sessionPersistence.create(identity)
      await contender.close()
    }
  } finally { vi.restoreAllMocks() }
})
