/**
 * The default curator under races and failures: an owner that changes while its run starts, yields,
 * or settles; subagent starts, results, and disposals that fail; and a service disposed mid-run.
 * Each race is held open with a barrier on the call it happens around, never with a timer.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { DefaultContextCurator } from '../src/index.ts'
import { MODELS, disposeWorlds, preStep, requestsOf, SIGNAL, world, type World } from './fixture.ts'

afterEach(async () => {
  try { await disposeWorlds() } finally { vi.restoreAllMocks() }
})

/** A point a test holds a call at until it lets go. */
function barrier() {
  const entered = Promise.withResolvers<undefined>()
  const open = Promise.withResolvers<undefined>()
  return {
    entered: entered.promise,
    enter: () => { entered.resolve(undefined); return open.promise },
    open: () => { open.resolve(undefined) },
  }
}

/**
 * Hold the commit that releases the curator role, after it is appended and before it is flushed, until the
 * returned barrier opens; the run stays settling meanwhile.
 */
function holdRelease(w: World) {
  const held = barrier()
  const flush = w.ctx.sessions.flush.bind(w.ctx.sessions)
  let taken = false
  vi.spyOn(w.ctx.sessions, 'flush').mockImplementation(async (session) => {
    const last = session.snapshotEvents().at(-1)
    if (!taken && last?.type === 'context-map/state' && last.data.op.kind === 'release') {
      taken = true
      await held.enter()
    }
    return flush(session)
  })
  return held
}

const quietLog = (w: World) => ({
  warn: vi.spyOn(w.ctx.logger, 'warn').mockImplementation(() => undefined),
  error: vi.spyOn(w.ctx.logger, 'error').mockImplementation(() => undefined),
})

const mapOps = (w: World) => w.owner.session.snapshotEvents().flatMap(event => event.type === 'context-map/state' ? [event.data.op.kind] : [])

/** Wrap every subagent start so a test can change the activation it returns. */
function wrapActivations(
  w: World,
  wrap: (activation: Awaited<ReturnType<World['ctx']['subagents']['startActivation']>>) => ReturnType<World['ctx']['subagents']['startActivation']>,
): void {
  const start = w.ctx.subagents.startActivation.bind(w.ctx.subagents)
  vi.spyOn(w.ctx.subagents, 'startActivation').mockImplementation(async spec => wrap(await start(spec)))
}

/**
 * Hold the disposal of the first curator subagent until the returned barrier opens. A run settles by disposing its
 * subagent, so it stays settling meanwhile.
 */
function holdDispose(w: World) {
  const held = barrier()
  let wrapped = false
  wrapActivations(w, (activation) => {
    if (wrapped) return Promise.resolve(activation)
    wrapped = true
    const dispose = activation.dispose.bind(activation)
    return Promise.resolve({ ...activation, dispose: async () => { await held.enter(); await dispose() } })
  })
  return held
}

it('stays out of the way of an owner without a model route and says so', async () => {
  const w = await world({ curator: {}, script: [] })
  quietLog(w)
  const routeless = (await w.ctx.agents.create({ sessionId: SessionId('routeless') })).agent
  await w.ctx.contextMap.note(routeless, { text: 'Check this.' })
  await vi.waitFor(() => { expect(w.ctx.contextCurator.failureOf(routeless.id)).toMatchObject({ code: 'CONTEXT_MAP_NO_CHEAP_ROUTE' }) })
  await w.ctx.contextCurator.idle(routeless.id)
  expect(w.adapter.requests).toHaveLength(0)
  expect(w.ctx.contextMap.curatorOf(routeless)).toBeNull()
})

it('curates the maps of root agents only, also for subagents alive when it loads', async () => {
  const w = await world({ script: ['hang'] })
  const request = requestsOf(w)
  await w.ctx.contextMap.claim(w.owner)
  const child = await w.ctx.subagents.startActivation({
    provider: 'spawn', label: 'Member', delivery: 'caller', signal: SIGNAL,
    request: { parent: w.owner, prompt: [{ type: 'text', text: 'Work.' }], agentOptions: { provider: 'mock', model: 'big' } },
  })
  await request(1)
  const member = w.ctx.agents.get(child.childId)!
  expect(member.session.header.parentSession).toBe(w.owner.id)

  await w.ctx.plugin(DefaultContextCurator, {})
  await w.ctx.contextCurator.idle(member.id)
  expect(w.ctx.contextCurator.isRunning(member.id)).toBe(false)
  expect(w.ctx.contextMap.curatorOf(member)).toBeNull()
  expect(w.adapter.requests, 'the member\'s own request only').toHaveLength(1)
  await child.dispose()
})

it('ignores a change that commits after its owner was disposed', async () => {
  const w = await world({ curator: {}, script: [] })
  const warn = quietLog(w).warn
  const root = await w.spawnRoot('root')
  const flush = w.ctx.sessions.flush.bind(w.ctx.sessions)
  const held = barrier()
  vi.spyOn(w.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
    await held.enter()
    return flush(session)
  })
  const filing = w.ctx.contextMap.note(root, { text: 'Check this.' })
  await held.entered
  await w.disposeRoot(root)
  held.open()
  await Promise.allSettled([filing])
  expect(w.ctx.contextCurator.isRunning(root.id)).toBe(false)
  expect(w.ctx.contextCurator.failureOf(root.id)).toBeUndefined()
  expect(warn).not.toHaveBeenCalled()
})

it('ignores work announced for an owner that was disposed while its step read the index', async () => {
  const w = await world({ curator: {}, script: [] })
  const warn = quietLog(w).warn
  const root = await w.spawnRoot('root')
  // The tree's catalog check resolves the directory first; the map's observation resolves it second.
  const ensure = w.ctx.workingDirectory.ensure.bind(w.ctx.workingDirectory)
  const held = barrier()
  let calls = 0
  vi.spyOn(w.ctx.workingDirectory, 'ensure').mockImplementation(async (...args) => {
    calls++
    if (calls === 2) await held.enter()
    return ensure(...args)
  })
  const step = preStep(w.ctx, root)
  await held.entered
  await w.disposeRoot(root)
  held.open()
  await step
  expect(w.ctx.contextCurator.isRunning(root.id)).toBe(false)
  expect(w.ctx.contextCurator.failureOf(root.id)).toBeUndefined()
  expect(warn).not.toHaveBeenCalled()
})

it('stops a record that is withdrawing from an evaluation when the service is disposed too', async () => {
  const w = await world({ curator: {}, script: [] })
  const warn = quietLog(w).warn
  const root = await w.spawnRoot('root')
  // The note resolves the directory first; the curator's evaluation of the work resolves it second.
  const ensure = w.ctx.workingDirectory.ensure.bind(w.ctx.workingDirectory)
  const held = barrier()
  let calls = 0
  vi.spyOn(w.ctx.workingDirectory, 'ensure').mockImplementation(async (...args) => {
    calls++
    if (calls === 2) await held.enter()
    return ensure(...args)
  })
  await w.ctx.contextMap.note(root, { text: 'Check this.' })
  await held.entered
  await w.disposeRoot(root)
  const disposing = w.curatorFiber!.dispose()
  held.open()
  await disposing
  expect(w.adapter.requests).toHaveLength(0)
  expect(warn).not.toHaveBeenCalled()
})

it('starts nothing for the replacement of an owner whose run settles while the service is disposed', async () => {
  const w = await world({ curator: {}, script: ['hang'] })
  quietLog(w)
  const request = requestsOf(w)
  const root = await w.spawnRoot('root')
  const settling = holdDispose(w)
  await w.ctx.contextMap.note(root, { text: 'First thing.' })
  await request(1)
  await w.disposeRoot(root)
  await settling.entered
  const replacement = (await w.ctx.agents.resume({
    resumeSessionId: root.id, agentOptions: { provider: 'mock', model: 'big' },
  })).agent
  await w.ctx.contextMap.note(replacement, { text: 'Second thing.' })
  const disposing = w.curatorFiber!.dispose()
  settling.open()
  await disposing
  expect(w.adapter.requests).toHaveLength(1)
  expect(w.ctx.contextMap.snapshotOf(replacement)).toMatchObject({ curatorId: null, pending: [{}, {}] })
})

it('names no reasoning effort for a curator route whose model has none', async () => {
  const w = await world({
    curator: {}, script: [textResponse('done')], models: { big: MODELS.big!, lean: { window: 40_000, efforts: [], defaultEffort: 'none' } },
  })
  quietLog(w)
  await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
  await vi.waitFor(() => { expect(w.adapter.requests).toHaveLength(1) })
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.adapter.requests[0]).toMatchObject({ model: 'lean' })
  expect(w.adapter.requests[0]!.reasoningEffort).toBeUndefined()
})

it('starts again for the work left waiting when the owner takes the role back from a running curator', async () => {
  const w = await world({ curator: {}, script: ['hang', 'hang'] })
  const warn = quietLog(w).warn
  // The first run's result rejects once it was canceled; a canceled run is not a failure to report.
  wrapActivations(w, activation => Promise.resolve({
    ...activation, result: activation.result.then(() => { throw new Error('canceled run') }, () => { throw new Error('canceled run') }),
  }))
  const request = requestsOf(w)
  await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
  await request(1)
  const first = w.ctx.contextMap.curatorOf(w.owner)
  await w.ctx.contextMap.release(w.owner)
  await request(2)
  const second = w.ctx.contextMap.curatorOf(w.owner)
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  expect(second).not.toBe(first)
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('failed'))
})

it('reports a curator run whose result rejects and settles it', async () => {
  const w = await world({ curator: {}, script: [textResponse('done')] })
  const warn = quietLog(w).warn
  wrapActivations(w, activation => Promise.resolve({
    ...activation, result: activation.result.then(() => { throw new Error('result lost') }),
  }))
  await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
  await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining(`run for ${w.owner.id} failed: Error: result lost`)) })
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(w.ctx.contextMap.curatorOf(w.owner)).toBeNull()
  expect(mapOps(w)).toEqual(['note-pending', 'claim', 'release'])
})

it('reports a curator run it could not dispose, and the settlement that could not dispose it either', async () => {
  const w = await world({ curator: {}, script: ['hang'] })
  const warn = quietLog(w).warn
  wrapActivations(w, activation => Promise.resolve({
    ...activation,
    dispose: async () => {
      await activation.dispose()
      throw new Error('teardown failed')
    },
  }))
  const request = requestsOf(w)
  await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
  await request(1)
  await w.ctx.contextMap.claim(w.owner)
  await w.ctx.contextCurator.idle(w.owner.id)
  const messages = warn.mock.calls.map(call => String(call[0]))
  expect(messages).toContainEqual(expect.stringContaining('could not dispose the run (role moved): Error: teardown failed'))
  expect(messages).toContainEqual(expect.stringContaining('disposing the run failed: Error: teardown failed'))
  expect(w.ctx.contextMap.curatorOf(w.owner)).toBe(w.owner.id)
})

it('contains a failed read of the map while it settles a run that yielded', async () => {
  const w = await world({ curator: {}, script: ['hang'] })
  const warn = quietLog(w).warn
  const request = requestsOf(w)
  await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
  await request(1)
  const read = w.ctx.contextMap.snapshotOf.bind(w.ctx.contextMap)
  let broken = false
  const settled = Promise.withResolvers<undefined>()
  vi.spyOn(w.ctx.contextMap, 'snapshotOf').mockImplementation((agent) => {
    if (broken) throw new Error('map read failed')
    return read(agent)
  })
  warn.mockImplementation((message: unknown) => {
    if (String(message).includes('context curator: Error: map read failed')) {
      broken = false
      settled.resolve(undefined)
    }
  })
  await w.ctx.contextMap.release(w.owner)
  broken = true
  await settled.promise
  const messages = warn.mock.calls.map(call => String(call[0]))
  expect(messages).toContainEqual(expect.stringContaining('finalizing the map failed: Error: map read failed'))
  await w.ctx.contextCurator.idle(w.owner.id)
})

it('yields at once to a role taken while its subagent is starting, and disposes the subagent that then starts', async () => {
  const w = await world({ curator: {}, script: ['hang'] })
  quietLog(w)
  const start = w.ctx.subagents.startActivation.bind(w.ctx.subagents)
  const starting = barrier()
  vi.spyOn(w.ctx.subagents, 'startActivation').mockImplementationOnce(async (spec) => {
    await starting.enter()
    // The subagent starts although its run was canceled meanwhile, as when cancellation arrives after admission.
    return start({ ...spec, signal: SIGNAL })
  })
  const assistant = await w.spawnRoot('assistant')
  await w.ctx.contextMap.note(w.owner, { text: 'Check this.' })
  await starting.entered
  await w.ctx.contextMap.claim(w.owner, { holderId: assistant.id })
  // News during the yield, and a disposal of the service, change nothing about the yielding run.
  await w.ctx.contextMap.note(w.owner, { text: 'Another thing.' })
  const curator = w.ctx.contextCurator
  const disposing = w.curatorFiber!.dispose()
  starting.open()
  await disposing
  expect(curator.isRunning(w.owner.id)).toBe(false)
  expect(w.ctx.agents.list().map(agent => agent.id).toSorted()).toEqual([assistant.id, w.owner.id].toSorted())
  expect(w.ctx.contextMap.curatorOf(w.owner)).toBe(assistant.id)
})

it('keeps news that arrives while a run settles and starts the next run for it', async () => {
  const w = await world({ curator: {}, script: [textResponse('first done'), textResponse('second done')] })
  quietLog(w)
  const settling = holdDispose(w)
  await w.ctx.contextMap.note(w.owner, { text: 'First thing.' })
  await settling.entered
  await w.ctx.contextMap.note(w.owner, { text: 'Second thing.' })
  settling.open()
  await vi.waitFor(() => { expect(w.adapter.requests).toHaveLength(2) })
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(mapOps(w).filter(kind => kind === 'claim')).toHaveLength(2)
})

it('retries a start refused for capacity when news arrives while the refusal settles', async () => {
  const w = await world({ curator: { maxAttempts: 1 }, maxActiveSubagents: 1, script: ['hang'] })
  quietLog(w)
  const request = requestsOf(w)
  const occupier = await w.ctx.subagents.startActivation({
    provider: 'spawn', label: 'Occupier', delivery: 'caller', signal: SIGNAL,
    request: { parent: w.owner, prompt: [{ type: 'text', text: 'Hold the slot.' }], agentOptions: { provider: 'mock', model: 'big' } },
  })
  await request(1)
  const settling = holdRelease(w)
  await w.ctx.contextMap.note(w.owner, { text: 'First thing.' })
  await settling.entered
  await w.ctx.contextMap.note(w.owner, { text: 'Second thing.' })
  settling.open()
  await vi.waitFor(() => { expect(mapOps(w).filter(kind => kind === 'claim')).toHaveLength(2) })
  await w.ctx.contextCurator.idle(w.owner.id)
  expect(mapOps(w).filter(kind => kind === 'release')).toHaveLength(2)
  expect(w.adapter.requests).toHaveLength(1)
  await occupier.dispose()
})

it('starts nothing for a note filed while the service is being disposed', async () => {
  const w = await world({ curator: {}, script: ['hang'] })
  quietLog(w)
  const request = requestsOf(w)
  const settling = holdRelease(w)
  await w.ctx.contextMap.note(w.owner, { text: 'First thing.' })
  await request(1)
  const disposing = w.curatorFiber!.dispose()
  await settling.entered
  await w.ctx.contextMap.note(w.owner, { text: 'Second thing.' })
  settling.open()
  await disposing
  expect(w.adapter.requests).toHaveLength(1)
  expect(w.ctx.contextMap.snapshotOf(w.owner)).toMatchObject({ curatorId: null, pending: [{}, {}] })
})
