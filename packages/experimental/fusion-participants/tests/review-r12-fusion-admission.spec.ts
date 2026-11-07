/** Independent admission probes at the synchronous Cordis unload status edge. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { ExecutionSettlement } from '../src/index.ts'
import { publicFixture } from './execution-public-harness.ts'

it.each(['bind', 'reserve', 'register', 'release'] as const)(
  'refuses %s through an existing capability before the declaring reload fence observer runs', async (route) => {
    let scope: ReturnType<typeof createScope> | undefined
    let atUnload: (() => void) | undefined
    let remove: (() => void) | undefined
    const f = await publicFixture((ctx, task, provider) => {
      scope = createScope(ctx, {})
      remove = ctx.root.on('internal/status', (fiber) => {
        if (fiber === scope!.ctx.fiber && fiber.state === FiberState.UNLOADING) atUnload?.()
      })
      return scope.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
    })
    await f.grant()
    const run = f.bind()
    const attempt = f.host.reserve(run, 'edit')
    if (route === 'release') await f.host.register(attempt)
    let refused = false
    let pending: Promise<unknown> | undefined
    let settlement: ExecutionSettlement | undefined
    atUnload = () => {
      try {
        if (route === 'bind') f.bind()
        if (route === 'reserve') f.host.reserve(run, 'edit')
        if (route === 'register') pending = f.host.register(attempt).catch(() => { refused = true })
        if (route === 'release') pending = f.host.release(attempt).then((value) => { settlement = value })
      } catch (_error: unknown) { refused = true }
    }
    try {
      await scope!.ctx.fiber.restart()
      await pending
      if (route !== 'release') expect(refused).toBe(true)
      else expect(settlement).toMatchObject({ kind: 'settled', outcome: 'not-dispatched' })
      expect(f.control.registrations).toBe(route === 'release' ? 1 : 0)
      expect(f.control.preparations).toBe(0)
      expect(f.control.bodies).toBe(0)
    } finally {
      atUnload = undefined
      remove?.()
      await scope!.dispose()
      await f.dispose()
    }
  },
)

it.each(['declaring', 'enclosing'] as const)(
  'fences the declaring lifetime and drains any earlier allocation at the %s scope reload edge', async (route) => {
    let parent: ReturnType<typeof createScope> | undefined
    let declaring: ReturnType<typeof createScope> | undefined
    let atUnload: (() => void) | undefined
    let remove: (() => void) | undefined
    const f = await publicFixture((ctx, task, provider) => {
      parent = createScope(ctx, {})
      declaring = createScope(parent.ctx, {})
      const watched = route === 'declaring' ? declaring : parent
      remove = ctx.root.on('internal/status', (fiber) => {
        if (fiber === watched.ctx.fiber && fiber.state === FiberState.UNLOADING) atUnload?.()
      })
      return declaring.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
    })
    await f.grant()
    let refused = false
    let declaringState: FiberState | undefined
    let registration: Promise<void> | undefined
    atUnload = () => {
      declaringState = declaring!.ctx.fiber.state
      try {
        const attempt = f.host.reserve(f.bind(), 'edit')
        registration = f.host.register(attempt).catch(() => { refused = true })
      } catch (_error: unknown) { refused = true }
    }
    try {
      await (route === 'declaring' ? declaring! : parent!).ctx.fiber.restart()
      await registration
      expect(f.control.bodies).toBe(0)
      expect(declaringState).toBe(route === 'declaring' ? FiberState.UNLOADING : FiberState.ACTIVE)
      // The declaring chain, including an enclosing scope, belongs to the task admission lifetime.
      expect({ refused, registrations: f.control.registrations, cleanups: f.control.cleanups })
        .toEqual({ refused: true, registrations: 0, cleanups: 0 })
      expect(f.control.identities.size).toBe(0)
    } finally {
      atUnload = undefined
      remove?.()
      await parent!.dispose()
      await f.dispose()
    }
  },
)
