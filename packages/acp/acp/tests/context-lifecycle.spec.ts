import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACP_CONTEXT_PROJECTION_KEY } from '../src/context.ts'
import { TestCleanup, settleRejections } from './cleanup.ts'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

const cleanup = new TestCleanup()
afterEach(async () => { vi.restoreAllMocks(); await cleanup.run() })

/** A projection under ACP's key at another state version, so ACP's own registration conflicts with it. */
function occupyContextKey(ctx: Context): Promise<unknown> {
  return ctx.sessionProjections.register({
    key: ACP_CONTEXT_PROJECTION_KEY, stateVersion: 2, stateSchema: z.null(), init: () => null, apply: state => state,
  })
}

describe('ACP context setup lifetime', () => {
  it('fails activation with the registration conflict instead of leaving a detached rejection', async () => {
    const unhandled = cleanup.trackUnhandledRejections()
    let activated = false
    const failure = await makeBridgeHarness({ beforeAcp: async (ctx) => { await occupyContextKey(ctx) } })
      .then((harness) => { activated = true; cleanup.adopt(harness); return undefined }, (error: unknown) => error)
    await settleRejections()

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('already registered at stateVersion 2')
    expect(activated).toBe(false)
    expect(unhandled).toEqual([])
  })

  it('settles setup without a detached rejection when ACP unloads before the first session', async () => {
    const unhandled = cleanup.trackUnhandledRejections()
    const holding = cleanup.barrier()
    const harness = cleanup.adopt(await makeBridgeHarness({
      deferActivation: true,
      beforeAcp: (ctx) => {
        // Forward the caller's `this`: the registration effect belongs to whichever plugin called it.
        // oxlint-disable-next-line typescript/unbound-method -- invoked below with the caller's `this`.
        const register = ctx.sessionProjections.register
        vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async function (this: typeof ctx.sessionProjections, definition) {
          const handle = await register.call(this, definition)
          if (definition.key === ACP_CONTEXT_PROJECTION_KEY) {
            holding.reach()
            await holding.released
          }
          return handle
        })
        return Promise.resolve()
      },
    }))
    const errors = vi.spyOn(harness.ctx.logger, 'error').mockImplementation(() => undefined)
    await holding.reached
    const unloading = harness.acpFiber.dispose()
    holding.release()
    await unloading
    await harness.acpActivation.catch(() => undefined)
    await settleRejections()

    expect(unhandled).toEqual([])
    // Whatever the unload reports reaches the owner's logger; nothing is left to the process.
    expect(errors.mock.calls.every(([error]) => error instanceof Error)).toBe(true)
    // The unloaded plugin released its registration: the key accepts another owner.
    await expect(occupyContextKey(harness.ctx)).resolves.toBeDefined()
  })
})

describe('failure-safe test cleanup', () => {
  it('observes an early tracked rejection while preserving its original outcome', async () => {
    const scope = new TestCleanup()
    cleanup.defer(() => scope.run())
    const unhandled = scope.trackUnhandledRejections()
    const failure = new Error('tracked early failure')
    const original = Promise.reject(failure)
    const pending = scope.track(original)

    await settleRejections()
    expect(unhandled).toEqual([])
    expect(pending).toBe(original)
    await expect(pending).rejects.toBe(failure)
    await scope.run()
    expect(unhandled).toEqual([])
  })

  it('quiesces a held request and a mounted bridge when an assertion fails while both are held', async () => {
    const failing = new TestCleanup()
    let prompting: Promise<unknown> | undefined
    let owned: BridgeHarness | undefined
    const outcome = await (async () => {
      owned = failing.adopt(await makeBridgeHarness({ script: [textResponse('never dispatched')] }))
      const hold = failing.barrier()
      owned.ctx.on('system-prompt/request-context', async (_context, _pending, next) => {
        const added = await next()
        hold.reach()
        await hold.released
        return added
      })
      await owned.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const { sessionId } = await owned.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      prompting = owned.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'held' }] })
      await hold.reached
      throw new Error('injected assertion failure')
    })().catch((error: unknown) => error)
    expect((outcome as Error).message).toBe('injected assertion failure')

    await failing.run()
    await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' })
    expect(owned!.adapter.requests).toEqual([])
    expect(owned!.ctx.get('agents')).toBeUndefined()
  })

  it('runs every registered task and reports each failure', async () => {
    const scope = new TestCleanup()
    const order: string[] = []
    scope.defer(() => { order.push('first') })
    scope.defer(() => { throw new Error('release failed') })
    scope.defer(() => { order.push('last registered') })
    const failure = await scope.run().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(order).toEqual(['last registered', 'first'])
  })
})
