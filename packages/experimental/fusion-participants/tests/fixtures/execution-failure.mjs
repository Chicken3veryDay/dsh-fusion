/** Process-owned sticky pins: the OS is the only release after an uncertain outcome. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

const [mode, rootDirectory, plane] = process.argv.slice(2)
const leaf = plane === 'src' ? 'src' : 'lib/types'
const { TaskExecutionOwner } = await import(`../../${leaf}/execution.${plane === 'src' ? 'ts' : 'js'}`)
const { executionProjection } = await import(`../../${leaf}/execution-state.${plane === 'src' ? 'ts' : 'js'}`)
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(Loop, { agents: [] })
await ctx.plugin(Jsonl, { root: rootDirectory, compression: 'none' })
const projection = await ctx.sessionProjections.register(executionProjection)
const recovering = ['recover', 'reconcile', 'reconcile-failure', 'reconcile-mismatch', 'reconcile-durability'].includes(mode)
const detaches = new Map()
const enter = ctx.sessions.enter.bind(ctx.sessions)
ctx.sessions.enter = (...args) => {
  const detach = enter(...args); detaches.set(args[0], detach); return detach
}
const root = await ctx.agents.retain({ sessionId: SessionId('failure-root'), mode: recovering ? 'resume' : 'create', agentOptions: {} })
const child = await ctx.agents.retain({ sessionId: SessionId('failure-child'), mode: recovering ? 'resume' : 'create', root, agentOptions: {} })
const resident = await child.adopt()
const issuer = Object.freeze({})
let bodies = 0, observations = 0
let owner
const adapter = {
  issuer, name: 'fake-process', revision: mode === 'reconcile-mismatch' ? 'wrong-revision' : '1', classify: () => mode === 'setup-release' ? undefined : 'mutation',
  async reconcile() { observations++; if (mode === 'reconcile-failure') throw new Error('independent observation failed'); return 'completed' },
  async prepare() {
    return {
      async run(fence) {
        if (mode === 'detach') void detaches.get(child.session)().catch(() => {})
        if (fence() !== undefined) return 'failed'
        bodies++
        if (mode === 'crash-effect') {
          process.stdout.write(JSON.stringify({ bodies, phase: 'after-effect', settlement: null }) + '\n')
          process.exit(0)
        }
        return 'completed'
      },
      async cleanup() { if (mode === 'cleanup') throw new Error('uncertain external cleanup') },
    }
  },
}
const participants = new Map([[child.session.id, child.session]])
if (mode.startsWith('history-')) {
  const incarnation = randomUUID(), runId = randomUUID(), attemptId = randomUUID()
  root.session.append('fusion/execution-opened', { version: 1, rootSessionId: root.session.id, incarnation,
    openingId: randomUUID(), previous: null })
  if (mode === 'history-grant') root.session.append('fusion/execution-granted', {
    rootSessionId: root.session.id, incarnation, generation: 1, participantId: 'absent-participant', previousRevoke: null,
  })
  else if (mode === 'history-participant') child.session.append('fusion/execution-opened', {
    version: 1, rootSessionId: child.session.id, incarnation, openingId: randomUUID(), previous: null,
  })
  else {
    const start = { rootSessionId: mode === 'history-root' ? 'foreign-root' : root.session.id,
      incarnation, runId, attemptId, participantId: child.session.id, generation: mode === 'history-missing-grant' ? 1 : null,
      classification: mode === 'history-missing-grant' ? 'mutation' : 'read', adapter: 'fake-process', revision: '1', requestHash: 'a'.repeat(64) }
    child.session.append('fusion/effect-started', start)
    if (mode === 'history-run' || mode === 'history-attempt') {
      const sibling = await ctx.agents.retain({ sessionId: SessionId('failure-sibling'), mode: 'create', root, agentOptions: {} })
      participants.set(sibling.session.id, sibling.session)
      sibling.session.append('fusion/effect-started', { ...start, participantId: sibling.session.id,
        runId: mode === 'history-run' ? runId : randomUUID(), attemptId: mode === 'history-attempt' ? attemptId : randomUUID() })
    }
  }
}
owner = new TaskExecutionOwner({ ctx, root: root.session, participants,
  state: new Map([root.session, ...participants.values()].map(session => [session, projection.readerFor(session)])),
  signal: new AbortController().signal, adapters: [adapter], drain: async () => { if (mode === 'drain') throw new Error('transport drain failed') },
})
if (mode.startsWith('history-')) {
  await assert.rejects(owner.open(), /conflicting-task-history/)
  await assert.rejects(owner.dispose())
  const other = new Context()
  await mountAgentLoopTestDependencies(other)
  await other.plugin(Jsonl, { root: rootDirectory, compression: 'none' })
  await assert.rejects(other.sessionPersistence.open(child.session.id, 'write'))
  assert.equal(bodies, 0)
  process.stdout.write(JSON.stringify({ bodies, blocked: true, independentWriter: 'denied' }) + '\n')
  process.exit(0)
}
await owner.open()
if (recovering) {
  assert.equal(bodies, 0)
  assert.equal(owner.snapshot().owner, null)
  assert.equal(owner.snapshot().unknown.length, 1)
  const entry = projection.stateOf(child.session).entries[0]
  assert.equal(entry.settlement, null)
  await assert.rejects(owner.grant(owner.controllerCapability(), child.session.id))
  if (mode.startsWith('reconcile-')) {
    if (mode === 'reconcile-durability') child.session.matchesDurabilityPrefix = async () => false
    const failed = owner.reconcile(owner.controllerCapability(), issuer, entry.start.attemptId)
    await assert.rejects(failed)
    assert.equal(owner.reconcile(owner.controllerCapability(), issuer, entry.start.attemptId), failed)
    assert.equal(owner.snapshot().unknown.length, 1)
    assert.equal(projection.stateOf(child.session).entries[0].settlement, null)
    await assert.rejects(owner.dispose())
    const other = new Context()
    await mountAgentLoopTestDependencies(other)
    await other.plugin(Jsonl, { root: rootDirectory, compression: 'none' })
    await assert.rejects(other.sessionPersistence.open(child.session.id, 'write'))
    process.stdout.write(JSON.stringify({ bodies, observations, unknown: 1, producer: null, independentWriter: 'denied' }) + '\n')
    process.exit(0)
  }
  if (mode === 'reconcile') {
    await owner.reconcile(owner.controllerCapability(), issuer, entry.start.attemptId)
    assert.equal(observations, 1)
    assert.equal(projection.stateOf(child.session).entries[0].settlement, null)
    assert.equal(owner.snapshot().unknown.length, 0)
    await owner.grant(owner.controllerCapability(), child.session.id)
    await owner.dispose()
    await resident.dispose(); await child.dispose(); await root.dispose(); await ctx.fiber.dispose()
  } else await assert.rejects(owner.dispose())
  process.stdout.write(JSON.stringify({ bodies, observations, unknown: owner.snapshot().unknown.length, producer: null }) + '\n')
  process.exit(0)
}
await owner.grant(owner.controllerCapability(), child.session.id)
if (mode === 'start' || mode === 'result') {
  const matches = child.session.matchesDurabilityPrefix.bind(child.session)
  child.session.matchesDurabilityPrefix = async (...args) => {
    const entry = projection.stateOf(child.session).entries[0]
    if (entry !== undefined && (mode === 'start' || entry.settlement !== null)) return false
    return matches(...args)
  }
}
if (mode === 'setup-release') {
  const reserve = ctx.sessionPersistence.reserveSessionWriter.bind(ctx.sessionPersistence)
  ctx.sessionPersistence.reserveSessionWriter = session => {
    const result = reserve(session)
    if (result.kind === 'reserved') result.reservation.release = async () => { throw new Error('setup release failed') }
    return result
  }
}
if (mode === 'drain') {
  await owner.attempt(owner.bindRun(issuer, resident.agent, new AbortController().signal), 'fake-edit')
  await assert.rejects(owner.dispose())
  assert.equal(owner.snapshot().phase, 'blocked')
  const other = new Context()
  await mountAgentLoopTestDependencies(other)
  await other.plugin(Jsonl, { root: rootDirectory, compression: 'none' })
  await assert.rejects(other.sessionPersistence.open(child.session.id, 'write'))
  process.stdout.write(JSON.stringify({ bodies, unknown: 0, blocked: true, independentWriter: 'denied' }) + '\n')
  process.exit(0)
}
await assert.rejects(owner.attempt(owner.bindRun(issuer, resident.agent, new AbortController().signal), 'fake-edit'))
assert.equal(owner.snapshot().phase, 'blocked')
assert.equal(owner.snapshot().unknown.length, 1)
assert.equal(bodies, ['start', 'detach', 'setup-release'].includes(mode) ? 0 : 1)
await assert.rejects(owner.dispose())
await assert.rejects(owner.grant(owner.controllerCapability(), child.session.id))
const other = new Context()
await mountAgentLoopTestDependencies(other)
await other.plugin(Jsonl, { root: rootDirectory, compression: 'none' })
await assert.rejects(other.sessionPersistence.open(child.session.id, 'write'))
let closed = false
void ctx.sessionPersistence.open(child.session.id, 'read').then(async handle => { await handle.close() })
// Close cannot become successful while this process retains the uncertain operation.
const writerClose = child.dispose().then(() => { closed = true })
void writerClose.catch(() => {})
await new Promise(resolve => setImmediate(resolve))
assert.equal(closed, false)
process.stdout.write(JSON.stringify({ bodies, unknown: 1, blocked: true, independentWriter: 'denied', close: 'pending' }) + '\n')
process.exit(0)
