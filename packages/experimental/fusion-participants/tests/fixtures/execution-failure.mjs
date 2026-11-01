/** Process-owned sticky pins: the OS is the only release after an uncertain outcome. */
import assert from 'node:assert/strict'
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
const recovering = mode === 'recover' || mode === 'reconcile'
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
  issuer, name: 'fake-process', revision: '1', classify: () => 'mutation',
  async reconcile() { observations++; return 'completed' },
  async prepare() {
    return {
      async run(fence) {
        if (mode === 'detach') detaches.get(child.session)()
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
owner = new TaskExecutionOwner({ ctx, root: root.session, participants: new Map([[child.session.id, child.session]]),
  state: new Map([root.session, child.session].map(session => [session, projection.readerFor(session)])),
  signal: new AbortController().signal, adapters: [adapter], drain: async () => {},
})
await owner.open()
if (recovering) {
  assert.equal(bodies, 0)
  assert.equal(owner.snapshot().owner, null)
  assert.equal(owner.snapshot().unknown.length, 1)
  const entry = projection.stateOf(child.session).entries[0]
  assert.equal(entry.settlement, null)
  await assert.rejects(owner.grant(owner.controllerCapability(), child.session.id))
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
await assert.rejects(owner.attempt(owner.bindRun(issuer, resident.agent, new AbortController().signal), 'fake-edit'))
assert.equal(owner.snapshot().phase, 'blocked')
assert.equal(owner.snapshot().unknown.length, 1)
assert.equal(bodies, mode === 'start' || mode === 'detach' ? 0 : 1)
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
