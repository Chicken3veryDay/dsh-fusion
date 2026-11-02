/** Retained Session ownership; adoption borrows the live Session without reopening its writer. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, RetainedAgentSession, RetainAgentSessionOptions } from '@deepseek-ai/dsh-agent'
import { interruptedTurnClosers, SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const markerSchema = z.strictObject({ rootSessionId: z.string().min(1) })

/** Required ownership marker projection; invalid or duplicate markers refuse activation. */
export const runtimeOwnerProjection = {
  key: 'runtimeOwner',
  stateVersion: 1,
  stateSchema: z.object({ rootSessionId: z.string().nullable() }),
  init: () => ({ rootSessionId: null }),
  apply(state, event) {
    if (event.type !== 'agent/runtime-owner') return state
    if (state.rootSessionId !== null) throw new Error('duplicate runtime owner')
    return markerSchema.parse(event.data)
  },
} satisfies ProjectionDefinition<'runtimeOwner', { rootSessionId: string | null }>

/** Factory-private capability evidence; neither IDs nor structural lookalikes authorize a participant. */
export interface RetainedAuthority {
  readonly rootSessionId: ReturnType<typeof SessionId>
  readonly signal: AbortSignal
  readonly root: boolean
  readonly children: Set<{ stop(): Promise<void>; dispose(): Promise<void> }>
}

/**
 * Acquire and publish a Session before any Agent exists. All continuations share one owner.
 * @param runtime - factory context supplying Session storage and routing.
 * @param owner - caller context owning the retained lifetime.
 * @param options - explicit provisioning mode, identity and composition.
 * @param factorySignal - factory shutdown cancellation.
 * @param initialize - existing Agent factory initialization with borrowed Session ownership.
 * @param track - register factory-owned cleanup and return its unregistration.
 * @param authorities - factory-private registry of exact retained capabilities.
 * @param storeSuffix - persist Session restoration events through its acquired writer.
 * @returns a capability after routing and the same-writer durability barrier succeed.
 * @throws durability refusals with their original cause, aggregated with any acquisition cleanup failure.
 */
export async function retainSession(
  runtime: Context,
  owner: Context,
  options: RetainAgentSessionOptions,
  factorySignal: AbortSignal,
  initialize: (session: Session, signal: AbortSignal, onCleanupFailure: (dispose: () => Promise<void>) => void) => Promise<AgentHandle>,
  track: (dispose: () => Promise<void>) => () => void,
  authorities: WeakMap<RetainedAgentSession, RetainedAuthority>,
  storeSuffix: (session: Session, writer: SessionHandle, storedCount: number) => Promise<void>,
): Promise<RetainedAgentSession> {
  owner.fiber.assertActive()
  const persistence = runtime.get('sessionPersistence')
  if (persistence === undefined) throw new Error('retained sessions require session persistence')
  const parent = options.root === undefined ? undefined : authorities.get(options.root)
  if (options.root !== undefined && (parent === undefined || !parent.root || parent.signal.aborted
    || runtime.sessions.get(parent.rootSessionId) !== options.root.session)) throw new Error('invalid retained root capability')
  const rootSessionId = parent?.rootSessionId ?? options.sessionId
  const children: RetainedAuthority['children'] = new Set()
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, factorySignal,
    ...parent === undefined ? [] : [parent.signal], ...options.signal === undefined ? [] : [options.signal]])
  let writer: SessionHandle | undefined
  let detach: (() => Promise<void>) | undefined
  let resident: AgentHandle | undefined
  let adoption: Promise<AgentHandle> | undefined
  let failedCleanup: (() => Promise<void>) | undefined
  let disposal: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let disposed = false
  const acquired = Promise.withResolvers<void>()
  const stop = (): Promise<void> => {
    if (stopping !== undefined) return stopping
    const completion = Promise.withResolvers<void>()
    stopping = completion.promise
    disposed = true
    abort.abort(new Error('retained session disposed'))
    const joins: Promise<void>[] = []
    for (const child of [...children]) {
      try { joins.push(child.stop()) } catch (error: unknown) {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        joins.push(Promise.reject(error))
      }
    }
    const settled = Promise.allSettled(joins)
    void (async () => {
      await acquired.promise
      const errors: unknown[] = []
      const results = await settled
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
      if (adoption !== undefined) {
        try { await adoption } catch (error: unknown) { errors.push(error) }
      }
      try { await failedCleanup?.() } catch (error: unknown) { errors.push(error) }
      try { await resident?.dispose() } catch (error: unknown) { errors.push(error) }
      if (errors.length > 0) throw new AggregateError(errors, 'retained session producer cleanup failed')
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    const completion = Promise.withResolvers<void>()
    disposal = completion.promise
    const producers = stop()
    void (async () => {
      await producers
      if (detach === undefined) await releaseResources()
      else await detach()
      untrack()
      parent?.children.delete(lifetime)
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }
  const releaseResources = async (): Promise<void> => {
    const errors: unknown[] = []
    for (const child of [...children]) {
      try { await child.dispose() } catch (error: unknown) { errors.push(error) }
    }
    // A child with unknown cleanup still owns its parent's writer and routing.
    if (errors.length > 0) throw new AggregateError(errors, 'retained session cleanup failed')
    try { await writer?.close() } catch (error: unknown) {
      throw new AggregateError([error], 'retained session cleanup failed')
    }
  }
  const lifetime = { stop, dispose }
  signal.throwIfAborted()
  parent?.children.add(lifetime)
  const untrack = track(dispose)
  const unfollow = owner.effect(() => dispose, `agentLoop.retain(${options.sessionId})`)
  try {
    owner.fiber.assertActive()
    signal.throwIfAborted()
    let session: Session
    if (options.mode === 'create') {
      session = runtime.sessions.prepare(options.sessionId)
      writer = await persistence.create(session.header, { signal })
    } else {
      writer = await persistence.open(options.sessionId, 'write', { signal })
      const read = await writer.read(0, undefined, { signal })
      const markers = read.events.filter(event => event.type === 'agent/runtime-owner')
      if (markers.length !== 1 || markerSchema.parse(markers[0]?.data).rootSessionId !== rootSessionId) {
        throw new Error('retained session ownership does not match the root')
      }
      const closers = interruptedTurnClosers(read.events)
      if (closers.length > 0) await writer.append(closers)
      session = runtime.sessions.prepare(options.sessionId, {
        seed: [...read.events, ...closers], meta: structuredClone(writer.header),
        inheritedEventCount: writer.inheritedEventCount, eventState: read.eventState,
      })
      await storeSuffix(session, writer, read.events.length + closers.length)
    }
    signal.throwIfAborted()
    detach = runtime.sessions.enter(session, { withdraw: stop, release: releaseResources })
    runtime.sessions.announce(session)
    signal.throwIfAborted()
    if (options.mode === 'create') session.append('agent/runtime-owner', { rootSessionId: SessionId(rootSessionId) })
    const durability = await persistence.flushSessionDurably(session)
    if (durability.kind !== 'durable') throw new Error(`retained session durability refused: ${durability.reason}`,
      'cause' in durability ? { cause: durability.cause } : undefined)
    signal.throwIfAborted()
    acquired.resolve()
    const release = async (): Promise<void> => {
      const results = await Promise.allSettled([dispose(), unfollow()])
      const failures = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError([...new Set(failures)], 'retained session cleanup failed')
    }
    const capability: RetainedAgentSession = Object.freeze({
      session,
      async adopt(): Promise<AgentHandle> {
        signal.throwIfAborted()
        if (failedCleanup !== undefined) throw new Error('retained session cleanup remains unknown')
        if (disposed || resident !== undefined || adoption !== undefined) throw new Error('retained session cannot be adopted twice')
        adoption = (async () => {
          const durability = await persistence.flushSessionDurably(session)
          if (durability.kind !== 'durable') throw new Error(`retained adoption durability refused: ${durability.reason}`,
            'cause' in durability ? { cause: durability.cause } : undefined)
          signal.throwIfAborted()
          const handle = await initialize(session, signal, (cleanup) => { failedCleanup = cleanup })
          resident = handle
          signal.throwIfAborted()
          let detached: Promise<void> | undefined
          return {
            agent: handle.agent,
            dispose: () => detached ??= (async () => {
              await handle.dispose()
              resident = undefined
            })(),
          }
        })()
        const current = adoption
        void current.finally(() => { adoption = undefined }).catch(() => undefined)
        return current
      },
      dispose: release,
    })
    authorities.set(capability, { rootSessionId, signal, root: parent === undefined, children })
    return capability
  } catch (error: unknown) {
    acquired.resolve()
    try { await dispose() } catch (cleanup: unknown) {
      try { await unfollow() } catch (_sameFailure: unknown) { /* The memoized disposer already supplied this failure. */ }
      throw new AggregateError([error, cleanup], 'retained session acquisition and cleanup failed')
    }
    await unfollow()
    throw error
  }
}
