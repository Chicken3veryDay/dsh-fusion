import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { resolveCuratorConfig } from '../src/config.ts'
import { selectCuratorRoute, type RouteParent } from '../src/route.ts'
import { CatalogAdapter, MODELS, disposeWorlds, logged, preStep, world, type World } from './fixture.ts'

afterEach(disposeWorlds)

const RULES = 'Instructions/Project/rules'
const config = resolveCuratorConfig({})

const parentOn = (model: string, effort?: string): RouteParent => ({
  model: { current: () => ({ provider: 'mock', model, ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) } }) },
})

describe('cheap route selection', () => {
  const adapter = new CatalogAdapter([])
  const llm = {
    listModels: (provider: string) => adapter.listModels(provider),
    resolveModelInfo: (provider: string, model: string) => adapter.resolveModel(provider, model),
  }

  it('picks the smallest adequate window at its least effort within the parent\'s provider', async () => {
    const choice = await selectCuratorRoute(llm, parentOn('big'), config)
    expect(choice.route).toEqual({ provider: 'mock', model: 'small', reasoningEffort: 'low' })
    expect(choice.contextWindow).toBe(40_000)
  })

  it('accepts the parent\'s own model when it runs above its least effort', async () => {
    const choice = await selectCuratorRoute(llm, parentOn('small', 'high'), config)
    expect(choice.route).toMatchObject({ model: 'small', reasoningEffort: 'low' })
  })

  it('fails loudly when nothing undercuts the parent\'s route', async () => {
    await expect(selectCuratorRoute(llm, parentOn('small', 'low'), config)).rejects.toMatchObject({ code: 'CONTEXT_MAP_NO_CHEAP_ROUTE' })
  })

  it('fails loudly when no model has enough context, naming what it inspected', async () => {
    const only = new CatalogAdapter([], { tiny: MODELS.tiny! })
    const tiny = { listModels: (p: string) => only.listModels(p), resolveModelInfo: (p: string, m: string) => only.resolveModel(p, m) }
    await expect(selectCuratorRoute(tiny, parentOn('tiny'), config)).rejects.toThrow(/1 mock models inspected/)
  })

  it('fails loudly when the parent has no route and bounds how many models it inspects', async () => {
    await expect(selectCuratorRoute(llm, { model: { current: () => undefined } }, config))
      .rejects.toMatchObject({ code: 'CONTEXT_MAP_NO_CHEAP_ROUTE' })
    const first = await selectCuratorRoute(llm, parentOn('big'), resolveCuratorConfig({ maxRoutesInspected: 1 }))
    expect(first.inspected).toBe(1)
    expect(first.route.model).toBe('big')
  })
})

describe('configuration', () => {
  it('has a working default and refuses unusable values', () => {
    expect(resolveCuratorConfig({})).toEqual({ provider: 'spawn', maxSteps: 24, maxTokens: 4096, minContextTokens: 32_768, maxRoutesInspected: 16 })
    expect(() => resolveCuratorConfig({ maxSteps: 0 })).toThrow(/maxSteps/)
    expect(() => resolveCuratorConfig({ provider: '' })).toThrow(/provider/)
  })
})

/** Build a world whose scripted models can read the live map. */
async function scripted(
  entries: (w: () => World) => ConstructorParameters<typeof CatalogAdapter>[0],
  options: Omit<Parameters<typeof world>[0] & object, 'script'> = {},
) {
  const ref: { w?: World } = {}
  const w = await world({ curator: {}, ...options, script: entries(() => ref.w!) })
  ref.w = w
  return w
}

const revisionOf = (w: World) => w.ctx.contextMap.snapshotOf(w.owner).revision

describe('the default curator', () => {
  it('files a note and builds a group on a cheap route, releasing the role and keeping its transcript out of the owner', async () => {
    const w = await scripted(get => [
      toolCallResponse('c1', 'map_view', {}),
      () => toolCallResponse('c2', 'map_group', {
        action: 'set', expected_revision: revisionOf(get()), path: RULES, title: 'Project rules', summary: 'Use before changing code.',
        sections: get().ctx.contextMap.snapshotOf(get().owner).pending[0]!.cites.map(cite => (cite as { id: string }).id),
      }),
      () => toolCallResponse('c3', 'map_note', {
        action: 'file', expected_revision: revisionOf(get()),
        pending_id: get().ctx.contextMap.snapshotOf(get().owner).pending[0]!.id,
        group_id: get().ctx.contextMap.snapshotOf(get().owner).groups[0]!.id,
      }),
      textResponse('done'),
    ])
    const testing = (await w.sections()).find(section => section.headingPath.includes('Testing'))!
    const filed = Promise.withResolvers<undefined>()
    const unwatch = w.ctx.contextMap.watch(() => {
      if (w.ctx.contextMap.snapshotOf(w.owner).groups[0]?.notes.length === 1) filed.resolve(undefined)
    })
    try {
      await w.ctx.contextMap.note(w.owner, { text: 'Tests run with vitest.', cites: [testing.id] })
      await filed.promise
    } finally { unwatch() }
    await w.ctx.contextCurator.idle(w.owner.id)
    expect(w.ctx.contextMap.snapshotOf(w.owner).groups[0]?.notes).toHaveLength(1)
    const map = w.ctx.contextMap.snapshotOf(w.owner)
    expect(map.pending).toEqual([])
    expect(map.curatorId).toBeNull()
    expect(map.groups[0]).toMatchObject({ path: RULES, notes: [{ text: 'Tests run with vitest.' }] })
    expect(w.adapter.requests.map(request => [request.model, request.reasoningEffort])).toEqual(Array(4).fill(['small', 'low']))

    const prompt = w.adapter.requests[0]!.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).find(text => text.startsWith('You are the project map curator.'))
    if (prompt === undefined) throw new Error('Curator prompt missing from its first request')
    await expect(prompt + '\n').toMatchFileSnapshot('./expected/curator-prompt.txt')
    const events = await logged(w.ctx, w.owner.id)
    const ops = events.filter(event => event.type === 'context-map/state').map(event => (event.data as { op: { kind: string } }).op.kind)
    expect(ops).toEqual(['note-pending', 'claim', 'group-set', 'note-file', 'release'])
    expect(events.filter(event => /^(assistant|user|turn|step|developer)\//.test(event.type))).toEqual([])
    expect(w.ctx.agents.list().map(agent => agent.id)).toEqual([w.owner.id])
  })

  it('starts when the index changes, not on every step', async () => {
    const w = await scripted(() => [textResponse('nothing to change')])
    await preStep(w.ctx, w.owner)
    await vi.waitFor(() => { expect(w.adapter.requests).toHaveLength(1) })
    await w.ctx.contextCurator.idle(w.owner.id)
    const settled = w.ctx.contextMap.snapshotOf(w.owner)
    expect(settled.curatorId).toBeNull()
    expect(settled.indexDigest).not.toBeNull()

    await preStep(w.ctx, w.owner, 1, 3)
    await preStep(w.ctx, w.owner, 1, 4)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(w.adapter.requests).toHaveLength(1)
    expect(w.ctx.contextCurator.isRunning(w.owner.id)).toBe(false)
  })

  it('stops a run at its step bound and releases the role', async () => {
    const w = await scripted(() => Array.from({ length: 12 }, (_, index) => () => toolCallResponse(`v${index}`, 'map_view', {})), {
      curator: { maxSteps: 2 },
    })
    await w.ctx.contextMap.note(w.owner, { text: 'Anything to check.' })
    await vi.waitFor(() => { expect(w.adapter.requests.length).toBeGreaterThan(0) })
    await vi.waitFor(() => { expect(w.ctx.contextCurator.isRunning(w.owner.id)).toBe(false) })
    await new Promise(resolve => setTimeout(resolve, 100))
    // Two admitted steps, and the finished run does not restart for the note it left pending.
    expect(w.adapter.requests).toHaveLength(2)
    expect(w.ctx.contextCurator.isRunning(w.owner.id)).toBe(false)
    expect(w.ctx.contextMap.snapshotOf(w.owner).curatorId).toBeNull()
    expect(w.ctx.agents.list().map(agent => agent.id)).toEqual([w.owner.id])
  })

  it('cancels a running curator when the service is disposed and settles before returning', async () => {
    const w = await scripted(() => ['hang'])
    const curator = w.ctx.contextCurator
    const entered = Promise.withResolvers<undefined>()
    const original = w.adapter.stream.bind(w.adapter)
    const stream = vi.spyOn(w.adapter, 'stream').mockImplementation(async function* (options) {
      for await (const chunk of original(options)) {
        entered.resolve(undefined)
        yield chunk
      }
    })
    try {
      await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
      await entered.promise
      expect(w.adapter.requests).toHaveLength(1)
      expect(curator.isRunning(w.owner.id)).toBe(true)
      expect(w.ctx.contextMap.snapshotOf(w.owner).curatorId).not.toBeNull()

      await w.curatorFiber!.dispose()
      expect(curator.isRunning(w.owner.id)).toBe(false)
      expect(w.ctx.contextMap.snapshotOf(w.owner).curatorId).toBeNull()
      expect(w.ctx.agents.list().map(agent => agent.id)).toEqual([w.owner.id])
    } finally { stream.mockRestore() }
  })

  it('yields to another holder that claims the role and resumes when that holder is disposed', async () => {
    const w = await scripted(() => ['hang', 'hang'])
    const requests = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    const original = w.adapter.stream.bind(w.adapter)
    const stream = vi.spyOn(w.adapter, 'stream').mockImplementation(async function* (options) {
      for await (const chunk of original(options)) {
        requests[w.adapter.requests.length - 1]?.resolve(undefined)
        yield chunk
      }
    })
    try {
      await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
      await requests[0]!.promise
      expect(w.adapter.requests).toHaveLength(1)
      const first = w.ctx.contextMap.snapshotOf(w.owner).curatorId

      const assistant = await w.spawnRoot('assistant')
      await w.ctx.contextMap.claim(w.owner, { holderId: assistant.id })
      await w.ctx.contextCurator.idle(w.owner.id)
      expect(w.ctx.contextMap.snapshotOf(w.owner).curatorId).toBe(assistant.id)
      expect(w.ctx.contextCurator.isRunning(w.owner.id)).toBe(false)
      expect(w.ctx.agents.get(first!)).toBeUndefined()

      await w.ctx.contextMap.note(w.owner, { text: 'Another thing.' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(w.adapter.requests).toHaveLength(1)
      expect(w.ctx.contextMap.snapshotOf(w.owner).curatorId).toBe(assistant.id)

      await w.disposeRoot(assistant)
      await requests[1]!.promise
      expect(w.adapter.requests).toHaveLength(2)
      const resumed = w.ctx.contextMap.snapshotOf(w.owner).curatorId
      expect(resumed).not.toBeNull()
      expect(resumed).not.toBe(assistant.id)
      expect(resumed).not.toBe(first)
    } finally { stream.mockRestore() }
  })

  it('reports that no route is cheap instead of running on an expensive one', async () => {
    const w = await scripted(() => [textResponse('never runs')], { ownerModel: 'tiny', models: { tiny: MODELS.tiny! } })
    await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
    await vi.waitFor(() => { expect(w.ctx.contextCurator.failureOf(w.owner.id)).toMatchObject({ code: 'CONTEXT_MAP_NO_CHEAP_ROUTE' }) })
    await vi.waitFor(() => { expect(w.ctx.contextCurator.isRunning(w.owner.id)).toBe(false) })
    expect(w.adapter.requests).toHaveLength(0)
    expect(w.ctx.contextMap.snapshotOf(w.owner).curatorId).toBeNull()
  })

  it('leaves the role to the owner\'s own claim and never starts beside a live holder', async () => {
    const w = await scripted(() => [textResponse('never runs')])
    await w.ctx.contextMap.claim(w.owner)
    await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(w.adapter.requests).toHaveLength(0)
    expect(w.ctx.contextMap.snapshotOf(w.owner).curatorId).toBe(w.owner.id)
  })
})
