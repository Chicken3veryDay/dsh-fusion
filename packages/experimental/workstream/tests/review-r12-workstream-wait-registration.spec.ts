/** Listener-registration hooks can cancel a wait before its abort listener is installed. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'review-r12-wait-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  const handle = await ctx.agents.create({ sessionId: SessionId('owner'), agentOptions: { provider: 'mock', model: 'mock' } })
  const owner = handle.agent
  const snapshot = await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Wait registration' })
  return { ctx, owner, snapshot }
}

for (const duringRegistration of [false, true]) {
  it(`rejects cancellation ${duringRegistration ? 'inside' : 'after'} event listener registration`, async () => {
    const { ctx, owner, snapshot } = await setup()
    const cancel = new AbortController()
    const reason = new Error('caller cancelled while observing the subscription')
    let registrations = 0
    const remove = ctx.on('internal/listener', (name) => {
      if (name !== 'session/event') return
      registrations++
      if (duringRegistration) cancel.abort(reason)
    })
    const outcome = ctx.workstreams.waitForChange(owner, owner.id, {
      afterRevision: snapshot.revision, afterCursor: owner.session.seq, timeoutMs: 60_000, signal: cancel.signal,
    }).then(value => ({ kind: 'resolved' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }))
    try {
      expect(registrations).toBe(1)
      if (!duringRegistration) cancel.abort(reason)
      expect(cancel.signal.aborted).toBe(true)
      // A real concerning event releases even a defective wait; no deadline or elapsed-time assertion is used.
      await ctx.workstreams.createTicket(owner, owner.id, { subject: 'After cancellation', description: 'Must not wake a cancelled wait' })
      expect(await outcome).toEqual({ kind: 'rejected', error: reason })
    } finally { remove(); cancel.abort(reason); await outcome }
  })
}
