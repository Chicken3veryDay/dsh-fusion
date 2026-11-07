import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
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
const directories: string[] = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One activation slot per root, so a single running member fills the pool. */
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'workstream-capacity-'))
  directories.push(dir)
  await ctx.plugin(JsonlSessionPersistence, { root: dir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents, { maxActiveSubagents: 1 })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Build work' })
  return { ctx, owner }
}

function request(name: string) {
  return { operationId: WorkstreamOperationId(`create-${name}`), name, description: `${name} responsibility`, provider:
    'spawn', prompt: `${name} initial`, signal }
}

describe('Subagent activation limit', () => {
  it('refuses a member definitely, records nothing, and provisions it on a retry of the same operation once a slot frees', async () => {
    const { ctx, owner } = await setup()
    const first = await ctx.workstreams.addMember(owner, owner.id, request('first'))
    const before = ctx.workstreams.get(owner, owner.id)

    const refused = async (): Promise<void> => {
      const attempt = ctx.workstreams.addMember(owner, owner.id, request('second'))
      await expect(attempt).rejects.toMatchObject({ code: 'WORKSTREAM_CAPACITY' })
      await expect(attempt).rejects.toThrow(
        /^Member "second" was not added: subagent limit reached \(active child limit: 1\).*retry the same operation$/)
    }
    await refused()
    const after = ctx.workstreams.get(owner, owner.id)
    expect(after.members).toEqual(before.members)
    expect(after.revision).toBe(before.revision + 2)
    // While the pool stays full, the same operation returns the same typed refusal and still records nothing.
    await refused()
    expect(ctx.workstreams.get(owner, owner.id).members.map(member => member.name)).toEqual(['owner', 'first'])

    expect((await ctx.workstreams.stop(owner, owner.id, first.id)).phase).toBe('stopped')
    const second = await ctx.workstreams.addMember(owner, owner.id, request('second'))
    expect(second).toMatchObject({ name: 'second', phase: 'active', diagnostic: null })
    expect(ctx.workstreams.get(owner, owner.id).members.filter(member => member.phase === 'provisioning')).toEqual([])
  })
})
