/** Public withdrawal fences retained host credentials while actual held cleanup remains pending. */
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import { publicFixture } from './execution-public-harness.ts'
import { gate } from './execution-harness.ts'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'

for (const route of ['host', 'task', 'enclosing'] as const) {
  for (const phase of ['register', 'held', 'prepare', 'start', 'body', 'cleanup', 'result'] as const) {
    it(`withdraws ${route} at ${phase} without releasing retained writers before cleanup and result`, async () => {
      let scope: ReturnType<typeof createScope> | undefined
      let declaring: Context | undefined
      const f = await publicFixture((ctx, task, provider) => {
        scope = createScope(ctx, {})
        declaring = scope.ctx
        return scope.ctx.get('fusionParticipants')!.registerExecutionHost(task, provider)
      })
      const hold = gate(), cleanup = gate()
      if (phase !== 'result') f.control.cleanup = cleanup
      if (phase === 'prepare' || phase === 'body') f.control[phase] = hold
      // oxlint-disable-next-line typescript/unbound-method -- called with the exact writer receiver.
      const flush = JsonlSessionHandle.prototype.flushRetained
      let intercepted = false
      if (phase === 'start' || phase === 'result') {
        vi.spyOn(JsonlSessionHandle.prototype, 'flushRetained').mockImplementation(async function (this: JsonlSessionHandle, session, seq) {
          if (!intercepted && this.id === f.adopted.agent.session.id
            && session.ownEvents().some(e => e.type === (phase === 'start' ? 'fusion/effect-started' : 'fusion/effect-settled'))) {
            intercepted = true; hold.entered.resolve(undefined); await hold.resume.promise
          }
          return flush.call(this, session, seq)
        })
      }
      const sessions = f.ctx.sessions
      const participant = f.adopted.agent.session
      const root = sessions.get(f.task.roster.rootSessionId)!
      const persistence = f.ctx.sessionPersistence
      const initial = await persistence.flushSessionDurably(participant)
      expect(initial.kind).toBe('durable')
      let disposal: Promise<void> | undefined, work: ReturnType<typeof f.host.release> | undefined
      let disposed = false
      const withdraw = () => {
        disposal = (route === 'host' ? f.host.dispose() : route === 'task' ? f.task.dispose()
          : scope!.dispose()).then(() => { disposed = true })
      }
      try {
        await f.grant()
        const run = f.bind(), attempt = f.host.reserve(run, 'edit')
        if (phase === 'register') f.control.onRegister = withdraw
        const registration = f.host.register(attempt)
        if (phase === 'register') await expect(registration).rejects.toThrow()
        else {
          await registration
          if (phase !== 'held') {
            work = f.host.release(attempt)
            await (phase === 'cleanup' ? cleanup : hold).entered.promise
          }
          withdraw()
        }
        expect(() => f.host.reserve(run, 'edit')).toThrow()
        await expect(declaring!.get('fusionParticipants')!.registerExecutionHost(f.task, f.provider)).rejects.toThrow()
        hold.resume.resolve(undefined)
        if (phase !== 'result') await cleanup.entered.promise
        await setImmediate()
        expect(disposed).toBe(false)
        expect(sessions.get(root.id)).toBe(root)
        expect(sessions.get(participant.id)).toBe(participant)
        expect(f.control.identities.has(attempt)).toBe(phase !== 'result')
        // The same real writer remains owned and can still flush its admitted result.
        await sessions.flush(participant)
        cleanup.resume.resolve(undefined)
        await work
        await disposal
        expect([f.control.cleanups, f.model.requests.length]).toEqual([1, 0])
        expect(f.control.bodies).toBe(['body', 'cleanup', 'result'].includes(phase) ? 1 : 0)
      } finally {
        hold.resume.resolve(undefined); cleanup.resume.resolve(undefined)
        await f.host.dispose()
        await Promise.allSettled([work, disposal])
        await f.dispose()
      }
    })
  }
}
