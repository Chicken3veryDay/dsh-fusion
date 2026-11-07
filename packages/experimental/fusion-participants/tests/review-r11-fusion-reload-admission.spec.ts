/** A reload retains the declaring fiber uid while publishing UNLOADING. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { publicFixture } from './execution-public-harness.ts'

it.each(['restart', 'dispose'] as const)(
  'refuses fresh held allocation from an earlier status observer during declaring-fiber %s', async (route) => {
    let scope: ReturnType<typeof createScope> | undefined
    let onUnload: (() => void) | undefined
    let remove: (() => void) | undefined
    const f = await publicFixture((ctx, task, provider) => {
      scope = createScope(ctx, {})
      remove = ctx.root.on('internal/status', (fiber) => {
        if (fiber === scope!.ctx.fiber && fiber.state === FiberState.UNLOADING) onUnload?.()
      })
      return scope.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
    })
    let admission: 'not-observed' | 'accepted' | 'refused' = 'not-observed'
    let registration: Promise<void> | undefined
    let uidAtWithdrawal: number | null | undefined
    await f.grant()
    onUnload = () => {
      uidAtWithdrawal = scope!.ctx.fiber.uid
      try {
        const attempt = f.host.reserve(f.bind(), 'edit')
        registration = f.host.register(attempt)
        admission = 'accepted'
      } catch (_error: unknown) { admission = 'refused' }
    }
    try {
      await (route === 'restart' ? scope!.ctx.fiber.restart() : scope!.dispose())
      await registration
      expect(uidAtWithdrawal === null).toBe(route === 'dispose')
      expect(f.control.bodies).toBe(0)
      expect({ admission, registrations: f.control.registrations }).toEqual({ admission: 'refused', registrations: 0 })
    } finally {
      onUnload = undefined
      remove?.()
      await scope!.dispose()
      await f.dispose()
    }
  },
)
