/** Required execution facts fold deterministically and never invoke adapters. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { executionProjection, openedSchema, grantedSchema, revokedSchema, startedSchema, settledSchema, reconciledSchema } from '../src/execution-state.ts'
import { fixture } from './execution-harness.ts'
import { read } from './harness.ts'

it('restores execution checkpoints and full required histories without adapter work or model requests', async () => {
  const f = await fixture()
  try {
    await f.grant()
    const prefix = f.ctx.sessionProjections.checkpoint(f.child.session)
    const offset = f.child.session.seq
    await f.owner.attempt(f.bind(), 'edit')
    const full = f.ctx.sessionProjections.checkpoint(f.child.session)
    const events = await read(f.ctx, f.child.session.id)
    const restored = f.ctx.sessionProjections.restore(prefix, events.slice(offset), offset,
      f.child.session.header, f.child.session.inheritedEventCount)
    const replay = f.ctx.sessionProjections.restore({}, events, SessionLogOffset(0),
      f.child.session.header, f.child.session.inheritedEventCount)
    expect(restored.checkpoint.fusionExecutionTest).toEqual(full.fusionExecutionTest)
    expect(replay.checkpoint.fusionExecutionTest).toEqual(full.fusionExecutionTest)
    expect(events.filter(row => row.type.startsWith('fusion/effect-')).every(row => row.ignorable !== true)).toBe(true)
    expect(f.control.bodies).toBe(1)
    expect(f.control.cleanups).toBe(1)
    expect(f.model.requests).toHaveLength(0)
  } finally { await f.dispose() }
})

it('rejects duplicate, orphan, mismatched and reconciled producer facts', async () => {
  const f = await fixture()
  try {
    await f.grant()
    await f.owner.attempt(f.bind(), 'edit')
    const events = await read(f.ctx, f.child.session.id)
    const start = events.find((event): event is SessionEvent<'fusion/effect-started'> => event.type === 'fusion/effect-started')
    const result = events.find((event): event is SessionEvent<'fusion/effect-settled'> => event.type === 'fusion/effect-settled')
    if (start === undefined || result === undefined) throw new Error('missing durable effect facts')
    const empty = executionProjection.init(f.child.session.header)
    const unrelatedStart = { ...start, data: { ...start.data, attemptId: startedSchema.shape.attemptId.parse(randomUUID()) } }
    const pending = executionProjection.apply(executionProjection.apply(empty, unrelatedStart), start)
    const settled = executionProjection.apply(pending, result)
    expect(() => executionProjection.apply(pending, start)).toThrow('invalid effect start')
    expect(() => executionProjection.apply(empty, result)).toThrow('invalid effect settlement')
    expect(() => executionProjection.apply(settled, result)).toThrow('invalid effect settlement')
    const wrongRun = { ...result, data: { ...result.data, runId: startedSchema.shape.runId.parse(randomUUID()) } }
    expect(() => executionProjection.apply(pending, wrongRun)).toThrow()
    const reconciliation: SessionEvent<'fusion/effect-reconciled'> = { seq: SessionSeq(0), time: 1, type: 'fusion/effect-reconciled', data: {
      ...start.data, evidenceId: randomUUID(), source: start.data.adapter, disposition: 'not-executed',
    } }
    // Persisted reconciliation has exact fields; start-only fields are deliberately rejected.
    expect(() => executionProjection.apply(pending, reconciliation)).toThrow()
    const { rootSessionId, participantId, incarnation, runId, attemptId, generation } = start.data
    const evidence: SessionEvent<'fusion/effect-reconciled'> = { ...reconciliation, data: {
      rootSessionId, participantId, incarnation, runId, attemptId, generation,
      evidenceId: randomUUID(), source: start.data.adapter, disposition: 'not-executed',
    } }
    expect(() => executionProjection.apply(empty, evidence)).toThrow()
    expect(() => executionProjection.apply(settled, evidence)).toThrow()
    expect(() => executionProjection.apply(pending, { ...evidence, data: { ...evidence.data, source: 'another-adapter' } })).toThrow()
    const reconciled = executionProjection.apply(pending, evidence)
    expect(reconciled.entries[0]?.settlement).toBeNull()
    expect(() => executionProjection.apply(reconciled, evidence)).toThrow()
    expect(() => executionProjection.apply(reconciled, result)).toThrow()
    const unrelated: SessionEvent<'session/end-seed'> = { type: 'session/end-seed', seq: SessionSeq(0), time: 1, data: {} }
    expect(executionProjection.apply(reconciled, unrelated)).toBe(reconciled)
    expect(executionProjection.stateSchema.safeParse(reconciled).success).toBe(true)
    const duplicate = { ...reconciled, entries: [...reconciled.entries, ...reconciled.entries] }
    expect(executionProjection.stateSchema.safeParse(duplicate).success).toBe(false)
    const conflict = { ...settled, entries: reconciled.entries.map(row => ({ ...row, settlement: result.data })) }
    expect(executionProjection.stateSchema.safeParse(conflict).success).toBe(false)
    const uncertain = { ...reconciled, entries: reconciled.entries.map(row => row.start.attemptId === result.data.attemptId
      ? { ...row, settlement: { ...result.data, outcome: 'uncertain' as const } } : row) }
    expect(executionProjection.stateSchema.safeParse(uncertain).success).toBe(true)
  } finally { await f.dispose() }
})

it('rejects conflicting root chains, grants and revokes including forged checkpoint authority', async () => {
  const f = await fixture()
  try {
    await f.grant()
    await f.owner.revoke('handoff')
    await f.grant()
    const events = await read(f.ctx, f.root.session.id)
    const opened = events.find((event): event is SessionEvent<'fusion/execution-opened'> => event.type === 'fusion/execution-opened')
    const grant = events.find((event): event is SessionEvent<'fusion/execution-granted'> => event.type === 'fusion/execution-granted')
    const revoke = events.find((event): event is SessionEvent<'fusion/execution-revoked'> => event.type === 'fusion/execution-revoked')
    if (opened === undefined || grant === undefined || revoke === undefined) throw new Error('missing root history')
    const empty = executionProjection.init(f.root.session.header)
    const closed = executionProjection.apply(empty, opened)
    const granted = executionProjection.apply(closed, grant)
    expect(() => executionProjection.apply(empty, grant)).toThrow()
    expect(() => executionProjection.apply(closed, opened)).toThrow()
    expect(() => executionProjection.apply(granted, grant)).toThrow()
    expect(() => executionProjection.apply(closed, revoke)).toThrow()
    expect(() => executionProjection.apply(granted, { ...revoke, data: { ...revoke.data, stopped: true } })).toThrow()
    const stopped = executionProjection.apply(granted, { ...revoke, data: { ...revoke.data, reason: 'stop', stopped: true } })
    expect(() => executionProjection.apply(stopped, revoke)).toThrow()
    expect(() => executionProjection.apply(stopped, grant)).toThrow()
    const state = f.projection.stateOf(f.root.session)
    expect(executionProjection.stateSchema.safeParse(state).success).toBe(true)
    for (const changed of [
      { ...state, lastGeneration: null }, { ...state, opened: null }, { ...state, grant: null },
      { ...state, history: state.history.filter(row => row.type !== 'revoked') },
      { ...state, history: [...state.history, ...state.history] },
    ]) expect(executionProjection.stateSchema.safeParse(changed).success).toBe(false)
  } finally { await f.dispose() }
})

it('requires exact record fields and rejects unsafe generation and version values', () => {
  for (const schema of [openedSchema, grantedSchema, revokedSchema, startedSchema, settledSchema, reconciledSchema]) {
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ version: 999, generation: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
  }
})

it('keeps dormant facts out of model request prefixes and preserves them through compaction and replay', async () => {
  const { mount, message } = await import('./harness.ts')
  const { ctx, adapter } = await mount()
  const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'omniroute-openai', model: 'fake' } })
  const session = handle.agent.session
  const projection = await ctx.sessionProjections.register({ ...executionProjection, key: 'executionCompaction' })
  try {
    handle.agent.followup(message('before dormant facts'))
    await handle.agent.whenIdle()
    const incarnation = randomUUID()
    session.append('fusion/execution-opened', openedSchema.parse({ version: 1, rootSessionId: session.id,
      incarnation, openingId: randomUUID(), previous: null }))
    const start = startedSchema.parse({ rootSessionId: session.id, participantId: session.id, incarnation,
      runId: randomUUID(), attemptId: randomUUID(), generation: null, adapter: 'recorded-only', revision: '1',
      classification: 'read', requestHash: 'b'.repeat(64) })
    session.append('fusion/effect-started', start)
    const { rootSessionId, participantId, runId, attemptId, generation } = start
    session.append('fusion/effect-settled', { rootSessionId, participantId, incarnation: start.incarnation,
      runId, attemptId, generation, outcome: 'not-dispatched' })
    const authority = projection.stateOf(session)
    handle.agent.followup(message('after dormant facts'))
    await handle.agent.whenIdle()
    const previous = adapter.requests[0]!, current = adapter.requests[1]!
    expect(adapter.requests).toHaveLength(2)
    expect(current.messages.slice(0, previous.messages.length)).toEqual([...previous.messages])
    expect(current.tools).toEqual(previous.tools)
    const nodes = session.surface.nodes
    session.append('user/message', message('compacted ordinary conversation'), {
      surfaceOp: { op: 'replace', startSeq: nodes[1]!, endSeq: nodes[2]! },
      sourceEventSeqs: [nodes[1]!, nodes[2]!],
    })
    expect(projection.stateOf(session)).toEqual(authority)
    await ctx.sessions.flush(session)
    const events = await read(ctx, session.id)
    const restored = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(restored.checkpoint.executionCompaction).toEqual(ctx.sessionProjections.checkpoint(session).executionCompaction)
    expect(events.filter(event => event.type.startsWith('fusion/'))).toHaveLength(3)
  } finally { await handle.dispose() }
})
