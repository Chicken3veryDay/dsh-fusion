/** Exact-writer lifetime through real retained Sessions and the final tool pipeline check. */
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHandle, SessionWriterReservation } from '@deepseek-ai/dsh-session-persistence'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
import { JobId } from '../../../jobs/jobs/src/brand.ts'
import { mount } from './harness.ts'

// oxlint-disable-next-line typescript/unbound-method -- the observer invokes the method with its exact receiver.
const observedRetainedFlush = JsonlSessionHandle.prototype.flushRetained
async function bounded<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() =>{  reject(new Error(`probe deadline: ${name}`)) }, 2500) })]) }
  finally { clearTimeout(timer) }
}

for (const mode of ['live', 'close', 'replace', 'in-flight', 'settlement-flush', 'provider-withdrawal', 'provider-restart', 'reentrant'] as const) {
  it(mode, async () => {
    const { ctx, root, adapter } = await mount()
    const provider = ctx.sessionPersistence
    const handles: SessionHandle[] = []
    const create = provider.create.bind(provider)
    vi.spyOn(provider, 'create').mockImplementation(async (...args) => {
      const handle = await create(...args); handles.push(handle); return handle
    })
    const task = await ctx.fusionParticipants.prepare('single-test')
    const resident = await task.adopt('participant')
    const agent = resident.agent, session = agent.session
    const writer = handles.find(handle => handle.id === session.id)
    if (writer === undefined) throw new Error('missing captured public handle')
    // This is the Consumer contract: registration is synchronous, before any await.
    const reserved = provider.reserveSessionWriter(session)
    expect(reserved.kind).toBe('reserved')
    if (reserved.kind !== 'reserved') throw new Error(`reservation refused: ${reserved.reason}`)
    const pin: SessionWriterReservation = reserved.reservation
    const held = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
    const settlementEntered = Promise.withResolvers<undefined>(), settlementResume = Promise.withResolvers<undefined>()
    const firstClose = Promise.withResolvers<undefined>()
    let bodies = 0, checks = 0, closeDone = false, releaseDone = false, holdingSettlement = false
    let closed: Promise<void> | undefined, withdrawal: Promise<void> | undefined
    let dispatch: ReturnType<ToolExecutionPipeline['dispatch']> | undefined
    let reenteredClose: Promise<void> | undefined
    const rawClose = writer.close.bind(writer)
    vi.spyOn(writer, 'close').mockImplementation(() => { firstClose.resolve(undefined); return rawClose() })
    const rawRetainedFlush = observedRetainedFlush
    vi.spyOn(JsonlSessionHandle.prototype, 'flushRetained').mockImplementation(async function (this: JsonlSessionHandle, exact, boundary) {
      if (this.id === session.id && holdingSettlement) {
        settlementEntered.resolve(undefined); await settlementResume.promise
      }
      return rawRetainedFlush.call(this, exact, boundary)
    })
    const remove = ctx.tools.register(defineTool({
      name: 'lifetime_counter', description: 'Fake counter; no external effect.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        bodies++
        if (mode === 'in-flight' || mode === 'settlement-flush') { held.resolve(undefined); await resume.promise }
        return 'counted'
      },
    }))
    const unhold = ctx.on('tools/execute', async (_exec, next) => {
      if (mode !== 'in-flight' && mode !== 'settlement-flush') { held.resolve(undefined); await resume.promise }
      return next()
    })
    const pipeline = new ToolExecutionPipeline(ctx, {
      reject() { checks++; const refusal = pin.checkDispatch(); return refusal === undefined ? undefined : new Error(`writer lifetime: ${refusal.reason}`) },
    })
    const cancel = new AbortController()
    const tools = await ctx.tools.resolve({ agent, signal: cancel.signal, modelSelection: { provider: 'omniroute-openai', model: 'fake' } })
    const record = (label: string) => session.append('job/registered', {
      jobId: JobId(`lifetime-${mode}-${label}`), owner: agent.id, kind: 'pure-probe', label, startedAt: 1,
    })
    let observer: Awaited<ReturnType<typeof mount>> | undefined
    let released: ReturnType<SessionWriterReservation['release']> | undefined
    try {
      record('start-stand-in')
      expect(await pin.flushDurably()).toMatchObject({ kind: 'durable', boundary: session.seq })
      const prepared = await pipeline.prepare({ name: 'lifetime_counter', arguments: {}, agent, toolSet: tools,
        callId: ToolCallId(`lifetime-${mode}`), signal: cancel.signal })
      if (prepared.kind !== 'dispatch') throw new Error('prepare refused')
      dispatch = pipeline.dispatch(prepared.exec)
      await bounded(Promise.race([held.promise, dispatch.then(() => { throw new Error('dispatch settled before hold') })]), 'tool hold')
      const beforeCloseSeq = session.seq
      if (mode === 'reentrant') pin.signal.addEventListener('abort', () => { reenteredClose = writer.close() }, { once: true })
      if (mode === 'provider-withdrawal' || mode === 'provider-restart') {
        const fiber = [...ctx.registry.get(Jsonl)!.fibers][0]!
        withdrawal = Promise.resolve(mode === 'provider-restart' ? fiber.restart() : fiber.dispose())
        expect(pin.signal.aborted, 'withdrawal signals synchronously').toBe(true)
        await bounded(firstClose.promise, 'first provider close')
      } else if (mode !== 'live') {
        closed = writer.close().then(() => { closeDone = true })
        expect(pin.signal.aborted, 'first close synchronously fences').toBe(true)
      }
      if (mode !== 'live') {
        await setImmediate()
        expect(closeDone, 'close must join registered operation').toBe(false)
        expect(provider.reserveSessionWriter(session).kind).toBe('refused')
        // Same-provider open checks its claim. A distinct real provider checks the real kernel lock.
        await expect(provider.open(session.id, 'write')).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
        observer = await mount(root)
        await expect(observer.ctx.sessionPersistence.open(session.id, 'write')).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
      }
      resume.resolve(undefined)
      const result = await bounded(dispatch, 'tool drain')
      await pipeline.complete(prepared.exec, result)
      expect(bodies, 'exact current writer at final dispatch').toBe(['live', 'in-flight', 'settlement-flush'].includes(mode) ? 1 : 0)
      if (mode === 'replace') expect(bodies).toBe(0)
      record('settlement-stand-in')
      const finalBoundary = session.seq
      holdingSettlement = mode === 'settlement-flush'
      released = pin.release().then((result) => { releaseDone = true; return result })
      expect(pin.release()).toBe(pin.release())
      if (holdingSettlement) {
        await bounded(Promise.race([settlementEntered.promise, released.then(() => { throw new Error('release settled before flush hold') })]), 'settlement hold')
        await setImmediate()
        expect(releaseDone).toBe(false); expect(closeDone).toBe(false)
        await expect(observer!.ctx.sessionPersistence.open(session.id, 'write')).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
        settlementResume.resolve(undefined)
      }
      const releaseResult = await bounded(released, 'reservation release')
      expect(releaseResult).toMatchObject({ kind: 'durable', boundary: finalBoundary })
      expect(pin.checkDispatch()).toMatchObject({ kind: 'refused' })
      if (mode === 'live') closed = writer.close().then(() => { closeDone = true })
      await bounded(closed ?? withdrawal!, 'actual close/release')
      if (mode === 'reentrant') expect(reenteredClose).toBe(writer.close())
      await reenteredClose
      if (observer === undefined) observer = await mount(root)
      const successor = await observer.ctx.sessionPersistence.open(session.id, 'write')
      try {
        const durable = await successor.read()
        expect(durable.events.length).toBeGreaterThanOrEqual(finalBoundary)
        expect(durable.events[finalBoundary - 1]).toMatchObject({ type: 'job/registered', data: { label: 'settlement-stand-in' } })
      } finally { await successor.close() }
      expect(adapter.requests).toHaveLength(0)
      expect(checks).toBeGreaterThan(0)
      expect(finalBoundary).toBeGreaterThan(beforeCloseSeq)

    } finally {
      resume.resolve(undefined); settlementResume.resolve(undefined)
      await dispatch?.catch(() => {})
      await bounded(pin.release(), 'finally release')
      tools.dispose(); unhold(); remove()
      await bounded(Promise.all([closed, withdrawal, task.dispose()]), 'finally owners')
    }
  })
}

async function plain(id: string) {
  const mounted = await mount()
  const { ctx } = mounted
  const session = ctx.sessions.prepare()
  const writer = await ctx.sessionPersistence.create(session.header)
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const value = ctx.sessionPersistence.reserveSessionWriter(session)
  if (value.kind !== 'reserved') throw new Error(`plain ${id}: ${value.reason}`)
  return { ...mounted, session, writer, detach, pin: value.reservation }
}

it('detaching the exact Session fences synchronously and retains its known prefix for release', async () => {
  const { ctx, session, writer, pin, detach } = await plain('detach')
  try {
    expect(await pin.flushDurably()).toMatchObject({ kind: 'durable' })
    detach()
    expect(ctx.sessions.get(session.id)).toBeUndefined()
    expect(pin.signal.aborted).toBe(true)
    expect(pin.checkDispatch()).toMatchObject({ kind: 'refused' })
    expect(ctx.sessionPersistence.reserveSessionWriter(session)).toMatchObject({ kind: 'refused', reason: 'not-live' })
  } finally { await pin.release(); await writer.close() }
})

it('release publishes its stable join before a synchronous abort callback reenters it', async () => {
  const { writer, pin, detach } = await plain('reentrant-release')
  let nested: ReturnType<SessionWriterReservation['release']> | undefined
  try {
    pin.signal.addEventListener('abort', () => { nested = pin.release() }, { once: true })
    const first = pin.release()
    expect(nested).toBe(first)
    expect(pin.release()).toBe(first)
    expect(await bounded(first, 'reentrant release')).toMatchObject({ kind: 'durable' })
  } finally { await pin.release(); await writer.close(); detach() }
})

it('queued retained flushes capture boundaries before waiting and finish before release', async () => {
  const { writer, pin, detach, session } = await plain('queued-flush')
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const raw = observedRetainedFlush
  let calls = 0, done = false
  vi.spyOn(JsonlSessionHandle.prototype, 'flushRetained').mockImplementation(async function (this: JsonlSessionHandle, exact, boundary) {
    if (this.id === session.id && ++calls === 1) { entered.resolve(undefined); await resume.promise }
    return raw.call(this, exact, boundary)
  })
  try {
    const first = pin.flushDurably(), second = pin.flushDurably()
    await bounded(entered.promise, 'queued flush')
    session.append('turn/start', { turn: 1 })
    const close = writer.close()
    const release = pin.release().then((result) => { done = true; return result })
    await expect(pin.flushDurably()).resolves.toMatchObject({ kind: 'refused' })
    await setImmediate(); expect(done).toBe(false)
    resume.resolve(undefined)
    expect(await first).toMatchObject({ kind: 'durable', boundary: 0 })
    expect(await second).toMatchObject({ kind: 'durable', boundary: 0 })
    expect(await release).toMatchObject({ kind: 'durable', boundary: 1 })
    await bounded(close, 'queued flush close')
    expect(calls).toBe(3)
  } finally { resume.resolve(undefined); await pin.release(); await writer.close(); detach() }
})

it('two independent registered operations retain one exact writer until both release', async () => {
  const { ctx, writer, pin, detach, session } = await plain('two-pins')
  const next = ctx.sessionPersistence.reserveSessionWriter(session)
  if (next.kind !== 'reserved') throw new Error('second reservation refused')
  let done = false
  try {
    await pin.flushDurably()
    const close = writer.close().then(() => { done = true })
    await pin.release()
    await setImmediate(); expect(done).toBe(false)
    expect(next.reservation.signal.aborted).toBe(true)
    await next.reservation.release()
    await bounded(close, 'two-pins close')
  } finally { await pin.release(); await next.reservation.release(); await writer.close(); detach() }
})
