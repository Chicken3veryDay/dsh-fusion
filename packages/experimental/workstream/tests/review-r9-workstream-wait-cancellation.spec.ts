/** Round-9 cancellation at the immediate-return paths of the public Workstream wait API. */
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
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '../src/index.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it.each(['unchanged', 'workstream-change', 'ticket-change'] as const)(
  'R9 canceled wait rejects even when the read already sees %s', async (change) => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    const dir = mkdtempSync(join(tmpdir(), 'review-r9-wait-cancel-'))
    directories.push(dir)
    await ctx.plugin(JsonlSessionPersistence, { root: dir })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    await ctx.plugin(TicketService)
    await ctx.plugin(WorkstreamService)
    const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
    const snapshot = await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Cancellation' })
    const cursor = ctx.workstreams.cursor(owner, owner.id)
    if (change === 'workstream-change') await ctx.workstreams.handoff(owner, owner.id, {
      expectedRevision: snapshot.revision, coordinatorId: owner.id,
    })
    if (change === 'ticket-change') await ctx.workstreams.createTicket(owner, owner.id, { subject: 'New work', description: '' })
    const cancelled = new Error('review-r9 caller canceled the wait')
    const controller = new AbortController()
    controller.abort(cancelled)
    await expect(ctx.workstreams.waitForChange(owner, owner.id, {
      afterRevision: snapshot.revision,
      afterCursor: cursor, timeoutMs: 60_000, signal: controller.signal,
    })).rejects.toBe(cancelled)
  },
)
