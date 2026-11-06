import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamEvidenceService, {
  WorkstreamEvidenceArtifactId,
  WorkstreamEvidenceOperationId,
  WorkstreamEvidenceTools,
} from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const sessionDir = mkdtempSync(join(tmpdir(), 'workstream-r5-session-'))
  const attachmentDir = mkdtempSync(join(tmpdir(), 'workstream-r5-attach-'))
  directories.push(sessionDir, attachmentDir)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionDir, compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: attachmentDir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  await ctx.plugin(WorkstreamEvidenceService)
  await ctx.plugin(WorkstreamEvidenceTools)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Evidence' })
  return { ctx, owner }
}

describe('round-5 Workstream Evidence review', () => {
  it('R5-N2 reads an artifact by the same artifact_id the model published it under', async () => {
    const { ctx, owner } = await setup()
    const exec = { agent: owner, signal: new AbortController().signal } as ToolRunContext
    const published = await ctx.tools.get('workstream_evidence_publish')!.execute({ root_session_id: owner.id,
      operation_id: 'publish-notes', artifact_id: 'notes ', expected_version: 1, text: 'Findings' }, exec)
    expect(published).toMatchObject({ artifactId: 'notes', version: 1 })
    const read = await ctx.tools.get('workstream_evidence_read')!.execute({ root_session_id: owner.id, artifact_id: 'notes ' }, exec)
      .then(value => ({ value }), (error: unknown) => ({ error }))
    expect(read, 'publish accepted and normalized "notes " but read with the same id').toMatchObject({ value: { text: 'Findings' } })
  })

  it('R5-N3 does not publish after the caller cancelled the publish', async () => {
    const { ctx, owner } = await setup()
    const cancel = new AbortController()
    cancel.abort(new Error('tool call cancelled'))
    const outcome = await ctx.workstreamEvidence.publish(owner, owner.id, { operationId: WorkstreamEvidenceOperationId('cancelled'),
      artifactId: WorkstreamEvidenceArtifactId('report'), expectedVersion: 1, content: 'Late', signal: cancel.signal })
      .then(() => 'published', () => 'rejected')
    expect(ctx.workstreamEvidence.list(owner, owner.id), 'a cancelled publish must not append a version').toEqual([])
    expect(outcome).toBe('rejected')
  })
})
