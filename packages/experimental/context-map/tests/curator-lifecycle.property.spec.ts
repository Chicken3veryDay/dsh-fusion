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

// Disposal waits for every curator run in the shared world; on a loaded machine that takes longer than the default hook bound.
afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
}, 120_000)

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
  /** Catalog reads for this provider hang; `entered` resolves when one starts. */
  hangRoute: { readonly provider: string; readonly entered: PromiseWithResolvers<undefined> } | undefined
}

/**
 * Provider of the temporary owner whose run is disposed during route selection. Only its catalog
 * reads hang, so a run of another root, such as an assistant's own map, never stands in for it.
 */
const ROUTE_HANG_PROVIDER = 'route-hang'

/** One world shared by the runs of a property; each run gets fresh agents and a fresh curator. */
interface Harness {
  readonly w: World
  readonly faults: Faults
  curatorFiber: { dispose(): Promise<void> } | undefined
  /** Set by a run to land a foreign claim inside the default curator's next claim read. */
  interleave: { readonly owner: Agent; readonly holder: Agent; readonly done: () => void } | undefined
  runs: number
  /** Session events appended anywhere in the world; waits treat them as progress. */
  events: number
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
  w.ctx.llm.registerAdapter([ROUTE_HANG_PROVIDER], w.adapter)
  const h: Harness = { w, faults, curatorFiber: w.curatorFiber, interleave: undefined, runs: 0, events: 0 }
  w.ctx.on('session/event', () => { h.events++ })
  const listModels = w.adapter.listModels.bind(w.adapter)
  vi.spyOn(w.adapter, 'listModels').mockImplementation((provider) => {
    if (faults.hangRoute?.provider === provider) {
      faults.hangRoute.entered.resolve(undefined)
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

/**
 * Stall bound for awaited lifecycle steps: a wait fails only after this long with no progress in the
 * world, so a loaded machine that is still working is not reported as a hang.
 */
const HANG_MS = 20_000

/** Any session event, model request, or committed index refresh counts as progress. */
function progressOf(h: Harness): number {
  return h.events + h.w.adapter.requests.length + h.w.ctx.contextIndex.refreshes()
}

/** Whether `promise` settles before the world stalls for {@link HANG_MS}. */
async function settles(h: Harness, promise: Promise<unknown>): Promise<boolean> {
  const done = promise.then(() => true)
  for (;;) {
    const seen = progressOf(h)
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      done,
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, HANG_MS) }),
    ]).finally(() => { clearTimeout(timer) })
    if (settled) return true
    if (progressOf(h) === seen) return false
  }
}

/** Wait until no evaluation or run for the given owners is in progress; a stall fails instead of hanging. */
async function quiesce(h: Harness, owners: readonly Agent[]): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const settled = await settles(h, Promise.all(owners.map(owner => h.w.ctx.contextCurator.idle(owner.id))))
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
  /** Every root this run creates; each step waits for all their curator runs, not only the owner's. */
  const roots: Agent[] = [owner]
  let assistant: Agent | undefined
  /** The assistant's claim is the newest grant until it is disposed. */
  let assistantHolds = false
  const map = (): ContextMapService => w.ctx.contextMap
  const spawnAssistant = async (): Promise<Agent> => {
    const created = await w.spawnRoot(`assistant-${String(run)}`)
    roots.push(created)
    return created
  }
  try {
    await body()
  } finally {
    h.interleave = undefined
    faults.failModel = 0
    faults.failRoute = 0
    faults.hangRoute = undefined
    if (assistant !== undefined) await w.disposeRoot(assistant)
    await w.disposeRoot(owner)
    await quiesce(h, roots)
    for (const root of roots) expectNothingFor(w, root)
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
          assistant ??= await spawnAssistant()
          await map().claim(owner, { holderId: assistant.id })
          assistantHolds = true
          break
        case 'abort-claim': {
          assistant ??= await spawnAssistant()
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
          temporary.model.select({ provider: ROUTE_HANG_PROVIDER, model: 'big' })
          const entered = Promise.withResolvers<undefined>()
          faults.hangRoute = { provider: ROUTE_HANG_PROVIDER, entered }
          await map().note(temporary, { text: 'Temporary fact.', cites: ['ref:package.json'] })
          expect(await settles(h, entered.promise), 'the temporary owner\'s curator enters route selection').toBe(true)
          expect(w.ctx.contextCurator.isRunning(temporary.id)).toBe(true)
          await w.disposeRoot(temporary)
          faults.hangRoute = undefined
          expect(await settles(h, w.ctx.contextCurator.idle(temporary.id)), 'a disposed owner settles its run').toBe(true)
          expectNothingFor(w, temporary)
          break
        }
        case 'curator-reload':
          // The owner steps while no curator is loaded, then the curator comes back.
          await h.curatorFiber?.dispose()
          await preStep(w.ctx, owner)
          faults.failModel = 0
          faults.failRoute = 0
          {
            const before = claimsFor(owner)
            h.curatorFiber = await w.ctx.plugin(DefaultContextCurator, { maxAttempts: MAX_ATTEMPTS })
            await quiesce(h, roots)
            // With no further owner step, the loading curator itself must pick up waiting work.
            const waiting = await map().curationWork(owner)
            const holder = map().curatorOf(owner)
            if (waiting !== null && waiting.attempts < MAX_ATTEMPTS && (holder === null || w.ctx.agents.get(holder) === undefined)) {
              expect(claimsFor(owner), `work ${waiting.reasons.join(',')} waits after the curator loaded`).toBeGreaterThan(before)
            }
          }
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
          await quiesce(h, roots)
          owner.followup(createUserMessage({ content: [{ type: 'text', text: 'Conversation to compact.' }], source: { kind: 'user' } }))
          await owner.whenIdle()
          await quiesce(h, roots)
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
      await quiesce(h, roots)
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
      await quiesce(h, roots)
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
}, 600_000)

it.each([
  [['abort-claim', 'map-reload', 'abort-claim', 'assistant-dispose']],
] satisfies [readonly Op[]][])('keeps the curator lifecycle invariants for the recorded sequence %j', async (ops) => {
  await runSequence(await harness(), ops)
}, 600_000)
