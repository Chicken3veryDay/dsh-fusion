/**
 * Generated sequences of map and curator events against the real services. After every step the
 * owner's work is never left dormant, each owner has at most one run, a newer holder is never
 * released by an older run, a disposed owner leaves nothing behind, and replaying the owner's log
 * gives the live map.
 */
import fc from 'fast-check'
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ContextMapService, { ContextMapTools, DefaultContextCurator } from '../src/index.ts'
import { contextMapProjectionDefinition, type ContextMapProjectionState } from '../src/projection.ts'
import { disposeWorlds, preStep, world, type World } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

const MAX_ATTEMPTS = 2

type Op =
  | 'note' | 'step' | 'route-failure' | 'provider-failure' | 'assistant-claim' | 'abort-claim'
  | 'assistant-dispose' | 'owner-dispose' | 'curator-reload' | 'map-reload' | 'compaction'

const OPS: readonly Op[] = [
  'note', 'step', 'route-failure', 'provider-failure', 'assistant-claim', 'abort-claim',
  'assistant-dispose', 'owner-dispose', 'curator-reload', 'map-reload', 'compaction',
]

/** Test-controlled faults the scripted provider and catalog read. */
interface Faults {
  failModel: number
  failRoute: number
  /** Set while the catalog read hangs; resolved when a read enters. */
  hangRoute: PromiseWithResolvers<undefined> | undefined
}

/** One world shared by the runs of a property; each run gets fresh agents and a fresh curator. */
interface Harness {
  readonly w: World
  readonly faults: Faults
  curatorFiber: { dispose(): Promise<void> } | undefined
  /** Set by a run to land a foreign claim inside the default curator's next claim read. */
  interleave: { readonly owner: Agent; readonly holder: Agent; readonly done: () => void } | undefined
  runs: number
}

async function harness(): Promise<Harness> {
  const faults: Faults = { failModel: 0, failRoute: 0, hangRoute: undefined }
  const answer = (): ReturnType<typeof textResponse> => {
    if (faults.failModel > 0) {
      faults.failModel--
      throw new Error('provider failure')
    }
    return textResponse('done')
  }
  const w = await world({ curator: { maxAttempts: MAX_ATTEMPTS }, script: Array.from({ length: 20_000 }, () => answer) })
  const h: Harness = { w, faults, curatorFiber: w.curatorFiber, interleave: undefined, runs: 0 }
  const listModels = w.adapter.listModels.bind(w.adapter)
  vi.spyOn(w.adapter, 'listModels').mockImplementation((provider) => {
    if (faults.hangRoute !== undefined) {
      faults.hangRoute.resolve(undefined)
      return new Promise(() => {})
    }
    if (faults.failRoute > 0) {
      faults.failRoute--
      return Promise.reject(new Error('route catalog outage'))
    }
    return listModels(provider)
  })
  const original: unknown = Object.getOwnPropertyDescriptor(ContextMapService.prototype, 'claim')?.value
  if (typeof original !== 'function') throw new Error('ContextMapService.claim is missing')
  const realClaim = (service: ContextMapService, ...args: Parameters<ContextMapService['claim']>): ReturnType<ContextMapService['claim']> => (
    Reflect.apply(original, service, args) as ReturnType<ContextMapService['claim']>
  )
  // A foreign claim lands inside the default curator's final index read, before its claim commits.
  vi.spyOn(ContextMapService.prototype, 'claim').mockImplementation(async function (this: ContextMapService, caller, request, signal) {
    const armed = h.interleave
    if (armed !== undefined && request?.work !== undefined && caller === armed.owner) {
      h.interleave = undefined
      const index = w.ctx.contextIndex
      const snapshot = index.snapshot.bind(index)
      vi.spyOn(index, 'snapshot').mockImplementationOnce(async (...args) => {
        const result = await snapshot(...args)
        await realClaim(this, armed.owner, { holderId: armed.holder.id })
        armed.done()
        return result
      })
    }
    return realClaim(this, caller, request, signal)
  })
  return h
}

function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, ms) }),
  ]).finally(() => { clearTimeout(timer) })
}

/** Wait until no evaluation or run for the given owners is in progress, bounded so a leak fails instead of hanging. */
async function quiesce(w: World, owners: readonly Agent[]): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const settled = await within(Promise.all(owners.map(owner => w.ctx.contextCurator.idle(owner.id))), 2000)
    expect(settled, 'curator runs settle').toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** A disposed owner leaves no run, curator record, child agent, or per-owner cache. */
function expectNothingFor(w: World, owner: Agent): void {
  expect(w.ctx.contextCurator.isRunning(owner.id), 'a disposed owner has no run').toBe(false)
  for (const field of ['hashes', 'spaceRefusals', 'spaceSeen', 'spaceAtClaim']) {
    const cache: unknown = Reflect.get(w.ctx.contextMap, field)
    expect(cache instanceof Map && cache.has(owner.id), `${field} keeps nothing for a disposed owner`).toBe(false)
  }
  const records: unknown = Reflect.get(w.ctx.contextCurator, 'records')
  expect(records instanceof Map && records.has(owner.id), 'the curator keeps nothing for a disposed owner').toBe(false)
  expect(w.ctx.agents.list().filter(agent => agent.session.header.parentSession === owner.id)).toEqual([])
}

function claimsFor(owner: Agent): number {
  return owner.session.snapshotEvents().filter(event => event.type === 'context-map/state' && event.data.op.kind === 'claim').length
}

function replay(owner: Agent): ContextMapProjectionState {
  return owner.session.snapshotEvents().reduce<ContextMapProjectionState>(
    contextMapProjectionDefinition.apply, contextMapProjectionDefinition.init(owner.session.header),
  )
}

async function runSequence(h: Harness, ops: readonly Op[]): Promise<void> {
  const { w, faults } = h
  const run = ++h.runs
  const owner = await w.spawnRoot(`owner-${String(run)}`)
  let assistant: Agent | undefined
  /** The assistant's claim is the newest grant until it is disposed. */
  let assistantHolds = false
  const map = (): ContextMapService => w.ctx.contextMap
  try {
    await body()
  } finally {
    h.interleave = undefined
    faults.failModel = 0
    faults.failRoute = 0
    faults.hangRoute = undefined
    if (assistant !== undefined) await w.disposeRoot(assistant)
    await w.disposeRoot(owner)
    await quiesce(w, [owner])
    expectNothingFor(w, owner)
  }

  async function body(): Promise<void> {
    for (const op of ops) {
      switch (op) {
        case 'note':
          await map().note(owner, { text: `Fact ${String(Math.random()).slice(2, 8)}.`, cites: ['ref:package.json'] }).catch(() => {})
          break
        case 'step':
          await preStep(w.ctx, owner)
          break
        case 'route-failure':
          faults.failRoute = 1
          await preStep(w.ctx, owner)
          break
        case 'provider-failure':
          faults.failModel = 1
          await preStep(w.ctx, owner)
          break
        case 'assistant-claim':
          assistant ??= await w.spawnRoot(`assistant-${String(run)}`)
          await map().claim(owner, { holderId: assistant.id })
          assistantHolds = true
          break
        case 'abort-claim': {
          assistant ??= await w.spawnRoot(`assistant-${String(run)}`)
          if (map().curatorOf(owner) === assistant.id) break
          h.interleave = { owner, holder: assistant, done: () => { assistantHolds = true } }
          await map().note(owner, { text: 'Interleaved fact.', cites: ['ref:package.json'] }).catch(() => {})
          break
        }
        case 'assistant-dispose':
          if (assistant !== undefined) await w.disposeRoot(assistant)
          assistant = undefined
          assistantHolds = false
          h.interleave = undefined
          break
        case 'owner-dispose': {
          const temporary = await w.spawnRoot(`temporary-${String(run)}-${String(Math.random()).slice(2, 8)}`)
          const entered = Promise.withResolvers<undefined>()
          faults.hangRoute = entered
          await map().note(temporary, { text: 'Temporary fact.', cites: ['ref:package.json'] })
          expect(await within(entered.promise, 2000), 'the temporary owner\'s curator enters route selection').toBe(true)
          expect(w.ctx.contextCurator.isRunning(temporary.id)).toBe(true)
          await w.disposeRoot(temporary)
          faults.hangRoute = undefined
          expect(await within(w.ctx.contextCurator.idle(temporary.id), 1000), 'a disposed owner settles its run').toBe(true)
          expectNothingFor(w, temporary)
          break
        }
        case 'curator-reload':
          // The owner steps while no curator is loaded, then the curator comes back.
          await h.curatorFiber?.dispose()
          await preStep(w.ctx, owner)
          h.curatorFiber = await w.ctx.plugin(DefaultContextCurator, { maxAttempts: MAX_ATTEMPTS })
          break
        case 'map-reload':
          await h.curatorFiber?.dispose()
          await [...w.ctx.registry.get(ContextMapTools)!.fibers][0]!.dispose()
          await [...w.ctx.registry.get(ContextMapService)!.fibers][0]!.dispose()
          await w.ctx.plugin(ContextMapService)
          await w.ctx.plugin(ContextMapTools)
          h.curatorFiber = await w.ctx.plugin(DefaultContextCurator, { maxAttempts: MAX_ATTEMPTS })
          break
        case 'compaction': {
          await quiesce(w, [owner])
          owner.followup(createUserMessage({ content: [{ type: 'text', text: 'Conversation to compact.' }], source: { kind: 'user' } }))
          await owner.whenIdle()
          await quiesce(w, [owner])
          const nodes = owner.session.surface.nodes
          const start = nodes.at(1)
          const end = nodes.at(-1)
          if (start === undefined || end === undefined || start === end) break
          const turn = owner.session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
          owner.session.append('turn/start', { turn })
          await w.ctx.compaction.compactRegion(start, end, owner, new AbortController().signal).catch(() => {})
          owner.session.append('turn/end', { turn, reason: { kind: 'completed' } })
          break
        }
        default: {
          const unknown: never = op
          throw new Error(`unknown op ${String(unknown)}`)
        }
      }
      await quiesce(w, [owner])
      const children = w.ctx.agents.list().filter(agent => agent.session.header.parentSession === owner.id)
      expect(children.length, 'at most one curator run per owner').toBeLessThanOrEqual(1)
      if (assistantHolds && assistant !== undefined) {
        expect(map().curatorOf(owner), 'an older run never replaces or releases a newer holder').toBe(assistant.id)
      }
      const replayed = replay(owner)
      expect(map().snapshotOf(owner), 'the replayed map equals the live map').toEqual(replayed.snapshot ?? map().snapshotOf(owner))
      const work = await map().curationWork(owner)
      expect(work?.attempts ?? 0).toBe(work !== null && replayed.attempts?.work === work.signature ? replayed.attempts.count : 0)
    }

    // No dormant work: with a healthy route and provider, owner steps must start a run for waiting
    // work unless its attempts are used up or a live holder has the role.
    faults.failModel = 0
    faults.failRoute = 0
    const before = claimsFor(owner)
    for (let step = 0; step < 2; step++) {
      await preStep(w.ctx, owner)
      await quiesce(w, [owner])
    }
    const work = await map().curationWork(owner)
    const holder = map().curatorOf(owner)
    const liveHolder = holder !== null && w.ctx.agents.get(holder) !== undefined
    if (work !== null && work.attempts < MAX_ATTEMPTS && !liveHolder) {
      expect(claimsFor(owner), `accepted work ${work.reasons.join(',')} stays dormant`).toBeGreaterThan(before)
    }
  }
}

it('keeps the curator lifecycle invariants over generated event sequences', async () => {
  const h = await harness()
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom(...OPS), { minLength: 1, maxLength: 6 }), async (ops) => {
      await runSequence(h, ops)
    }),
    { numRuns: 200, seed: 20261106, endOnFailure: true },
  )
}, 120_000)
