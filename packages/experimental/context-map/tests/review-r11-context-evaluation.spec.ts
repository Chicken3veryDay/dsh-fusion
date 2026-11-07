/** Review controls for evaluation withdrawal, shared index reads, and exact-owner replacement. */
import { afterEach, expect, it, vi } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ContextMapService, { DefaultContextCurator } from '../src/index.ts'
import { disposeWorlds, preStep, world } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
}, 120_000)

it('R11 disposing an evaluating owner leaves another caller of the shared refresh usable', async () => {
  const w = await world()
  await w.ctx.contextMap.claim(w.owner)
  const owner = await w.spawnRoot('shared-evaluation')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const joined = Promise.withResolvers<undefined>()
  const stat = w.ctx.fs.stat.bind(w.ctx.fs)
  let readSignal: AbortSignal | undefined
  let active = false
  vi.spyOn(w.ctx.fs, 'stat').mockImplementationOnce(async (target, signal) => {
    readSignal = signal
    active = true
    entered.resolve(undefined)
    try {
      await release.promise
      return await stat(target, signal)
    } finally { active = false }
  })
  const read = w.ctx.contextIndex.snapshot({ workingDirectory: w.project })
  let fiber: Awaited<ReturnType<typeof w.ctx.plugin>> | undefined
  try {
    await entered.promise
    const snapshot = w.ctx.contextIndex.snapshot.bind(w.ctx.contextIndex)
    vi.spyOn(w.ctx.contextIndex, 'snapshot').mockImplementation((scope, signal) => {
      const result = snapshot(scope, signal)
      if (signal !== undefined) joined.resolve(undefined)
      return result
    })
    fiber = await w.ctx.plugin(DefaultContextCurator)
    await joined.promise
    await w.disposeRoot(owner)
    await w.ctx.contextCurator.idle(owner.id)
    expect(active).toBe(true)
    expect(readSignal?.aborted, 'the independent waiter still owns this refresh').toBe(false)
    expect(w.adapter.requests).toHaveLength(0)
    release.resolve(undefined)
    expect((await read).sections.length).toBeGreaterThan(0)
    expect(active).toBe(false)
  } finally {
    release.resolve(undefined)
    await read
    await fiber?.dispose()
  }
})

it.each(['curator', 'map provider'] as const)('R11 %s disposal waits for an evaluating dependency to finish cancellation', async (provider) => {
  const w = await world()
  await w.ctx.contextMap.claim(w.owner)
  const owner = await w.spawnRoot('withdrawing-evaluation')
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const ensure = w.ctx.workingDirectory.ensure.bind(w.ctx.workingDirectory)
  let finished = false
  vi.spyOn(w.ctx.workingDirectory, 'ensure').mockImplementationOnce(async (agent, signal) => {
    const cancellation = Promise.withResolvers<never>()
    const onAbort = (): void => {
      aborted.resolve(undefined)
      cancellation.reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    entered.resolve(undefined)
    try {
      if (signal?.aborted) onAbort()
      await cancellation.promise
      return await ensure(agent, signal)
    } finally {
      await release.promise
      signal?.removeEventListener('abort', onAbort)
      finished = true
    }
  })
  const curator = await w.ctx.plugin(DefaultContextCurator)
  let disposal: Promise<void> | undefined
  try {
    await entered.promise
    const fiber = provider === 'curator' ? curator : [...w.ctx.registry.get(ContextMapService)!.fibers][0]!
    let disposed = false
    disposal = fiber.dispose().then(() => { disposed = true })
    await aborted.promise
    expect(finished).toBe(false)
    expect(disposed, 'service disposal must retain its evaluating task until cancellation settles').toBe(false)
    release.resolve(undefined)
    await disposal
    expect(finished).toBe(true)
    expect(w.adapter.requests).toHaveLength(0)
    if (provider === 'curator') {
      await w.ctx.plugin(DefaultContextCurator)
      await w.ctx.contextCurator.idle(owner.id)
      expect(w.adapter.requests).toHaveLength(1)
    }
  } finally {
    release.resolve(undefined)
    await disposal
    await curator.dispose()
  }
})

it('R11 a replacement owner announced during withdrawal gets its own run after the old evaluation settles', async () => {
  const w = await world({ script: [textResponse('curated')] })
  await w.ctx.contextMap.claim(w.owner)
  const old = await w.spawnRoot('replacement-evaluation')
  await w.ctx.contextMap.note(old, { text: 'Resume this pending work.', cites: ['ref:package.json'] })
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const ensure = w.ctx.workingDirectory.ensure.bind(w.ctx.workingDirectory)
  vi.spyOn(w.ctx.workingDirectory, 'ensure').mockImplementationOnce(async (agent, signal) => {
    const cancellation = Promise.withResolvers<never>()
    const onAbort = (): void => {
      aborted.resolve(undefined)
      cancellation.reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    entered.resolve(undefined)
    try {
      if (signal?.aborted) onAbort()
      await cancellation.promise
      return await ensure(agent, signal)
    } finally {
      await release.promise
      signal?.removeEventListener('abort', onAbort)
    }
  })
  const fiber = await w.ctx.plugin(DefaultContextCurator)
  let replacement: Awaited<ReturnType<typeof w.ctx.agents.resume>> | undefined
  try {
    await entered.promise
    await w.disposeRoot(old)
    await aborted.promise
    replacement = await w.ctx.agents.resume({ resumeSessionId: old.id, agentOptions: { provider: 'mock', model: 'big' } })
    expect(replacement.agent).not.toBe(old)
    await preStep(w.ctx, replacement.agent)
    expect(w.adapter.requests).toHaveLength(0)
    release.resolve(undefined)
    await w.ctx.contextCurator.idle(old.id)
    expect(w.adapter.requests).toHaveLength(1)
    expect(w.ctx.contextMap.snapshotOf(replacement.agent)).toMatchObject({ curatorId: null })
    const claims = replacement.agent.session.snapshotEvents().filter(event => event.type === 'context-map/state' && event.data.op.kind === 'claim')
    expect(claims).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    await fiber.dispose()
    await replacement?.dispose()
  }
})
