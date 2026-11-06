/** R5-N5: the profile's direct `ticket_assign` obeys the active-member rule that `workstream_assign_ticket` enforces. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import TicketTools from '../src/ticket-tools.ts'

const contexts: Context[] = []
const directories: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-profile-assign-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  await ctx.plugin(TicketTools)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Assign' })
  const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('create-worker'),
    name: 'worker', description: 'worker responsibility', provider: 'spawn', prompt: 'Work', signal })
  const ticket = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Work for the team', description: '' })
  const assign = (ownerId: string) => executeToolFixture(ctx, { agent: owner, name: 'ticket_assign', callId: ToolCallId(`assign-${ownerId}`), signal,
    arguments: { root_session_id: 'owner', ticket_id: ticket.id, expected_revision: ticket.revision, owner_id: ownerId, subject: 'Do it' } })
  return { ctx, owner, member, ticket, assign }
}

describe('profile ticket_assign', () => {
  it('R5-N5 refuses a stopped member that workstream_assign_ticket also refuses', async () => {
    const { ctx, owner, member, assign } = await setup()
    await ctx.workstreams.stop(owner, owner.id, member.id)
    const result = await assign(member.id)
    expect(result.isError, 'a stopped member must not receive Workstream Ticket work through the alternate path').toBe(true)
    expect(JSON.stringify(result)).toContain('not an active member')
  })

  it('R5-N5 refuses an agent that is not a member of the Workstream', async () => {
    const { ctx, assign } = await setup()
    const stranger = await ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })
    const result = await assign(stranger.id)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('not an active member')
  })

  it('R5-N5 still assigns an active member', async () => {
    const { member, assign } = await setup()
    const result = await assign(member.id)
    expect(result.isError).toBe(false)
  })
})
