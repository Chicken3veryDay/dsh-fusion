/**
 * Review r1 M1: plugin disposal awaits in-flight preflights, but a preflight can be waiting in
 * `agentPresets.resolve()`, whose audit of a preset with a pending row awaits `loader.await()`.
 * `loader.await()` waits for every entry's lifecycle task, including Fusion's own unload, so the
 * unload and the preflight wait on each other. The registry documents this constraint: callers must
 * not run inside a Host row's own activation.
 */
import { afterEach, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { configuration, harness } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A preset row that waits for a Host service no entry provides: a supported "pending" preset state. */
const waiter = { name: 'review-waiter', inject: ['reviewNeverProvided'], apply(_ctx: Context) {} }

async function settles(promise: Promise<unknown>, rounds: number): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  // Observation window, not a pass/fail timeout: the control settles within the first rounds.
  for (let round = 0; round < rounds && !settled; round++) await new Promise(resolve => setTimeout(resolve, 100))
  return settled
}

async function scenario(pendingRow: boolean, trigger: 'reload' | 'dispose' | 'shutdown') {
  const config = configuration('http://127.0.0.1:1')
  config.selections[0]!.agentPreset = 'waiting'
  const app = await harness(config)
  Object.assign(app.ctx.loader.builtins, { waiter })
  await app.ctx.loader.create({ name: 'cordis:preset', config: { id: 'waiting', plugins: pendingRow ? [{ name: 'cordis:waiter' }] : [] } })
  await app.ctx.loader.await()
  // With an idle Loader the registry reports the pending row instead of waiting forever.
  const preset = await app.ctx.agentPresets.resolve('waiting')
  expect(preset.broken === undefined).toBe(!pendingRow)
  const loader = app.ctx.loader
  const fiber = loader.resolve('fusion').fiber!
  const preflight = app.ctx.fusionConfig.preflight('test-pair')
  const unload = trigger === 'shutdown' ? app.ctx.fiber.dispose() : trigger === 'reload'
    // Loader-owned configuration replacement of the same entry (config editor / HMR path).
    ? app.ctx.loader.update('fusion', { config: { document: configuration('http://127.0.0.1:1') } })
    : fiber.dispose()
  const unloaded = await settles(unload, 50)
  const finished = await settles(preflight, 1)
  // The only Loader task left is Fusion's own unload, which awaits the preflight that awaits the Loader.
  // A completed root shutdown removes the Loader service; it then has no tasks.
  const tasks = unloaded && trigger === 'shutdown' ? [] : loader.getTasks()
  return { app, unloaded, finished, tasks: tasks.length, ownUnloadPending: fiber.inertia !== undefined && tasks.includes(fiber.inertia) }
}

it.each(['reload', 'dispose', 'shutdown'] as const)('control: %s unload completes while a preflight audits a preset without pending rows', async (trigger) => {
  const { app, unloaded, finished } = await scenario(false, trigger)
  if (trigger !== 'shutdown') cleanups.push(() => app.dispose())
  expect(unloaded).toBe(true)
  expect(finished).toBe(true)
}, 30_000)

it.each(['reload', 'dispose', 'shutdown'] as const)('%s unload completes while a preflight audits a preset with a pending row', async (trigger) => {
  const { app, unloaded, finished, tasks, ownUnloadPending } = await scenario(true, trigger)
  // A deadlocked root cannot be disposed; only clean up when the unload completed.
  if (unloaded && trigger !== 'shutdown') cleanups.push(() => app.dispose())
  expect({ unloaded, finished, pendingLoaderTasks: tasks, ownUnloadPending })
    .toEqual({ unloaded: true, finished: true, pendingLoaderTasks: 0, ownUnloadPending: false })
}, 30_000)
