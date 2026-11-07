import { z } from 'zod'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
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
const signal = new AbortController().signal

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(config: ConstructorParameters<typeof WorkstreamEvidenceService>[1] = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)

  const sessionDir = mkdtempSync(join(tmpdir(), 'workstream-session-'))
  directories.push(sessionDir)
  const attachmentDir = mkdtempSync(join(tmpdir(), 'workstream-attach-'))
  directories.push(attachmentDir)

  await ctx.plugin(JsonlSessionPersistence, { root: sessionDir })
  await ctx.plugin(LocalAttachmentStore, { dshHome: attachmentDir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  await ctx.plugin(WorkstreamEvidenceService, {
    maxBytesPerArtifact: 1024 * 1024,
    maxContextPacketBytes: 4096,
    ...config,
  })
  await ctx.plugin(WorkstreamEvidenceTools)

  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open-workstream'), title: 'Test Stream' })

  return { ctx, owner, sessionDir, attachmentDir }
}

describe('evidence limits and tool presentation', () => {
  it.each([
    { maxArtifacts: 1 }, { maxVersionsPerArtifact: 1 }, { maxTotalBytes: 1 },
  ])('rejects publication exceeding configured limits %j without changing retained history', async (config) => {
    const { ctx, owner } = await setup(config)
    const request = { operationId: WorkstreamEvidenceOperationId('first'), artifactId: WorkstreamEvidenceArtifactId('first'),
      expectedVersion: 1, content: 'x' }
    await ctx.workstreamEvidence.publish(owner, owner.id, request)
    const before = ctx.workstreamEvidence.list(owner, owner.id)
    await expect(ctx.workstreamEvidence.publish(owner, owner.id, { ...request,
      operationId: WorkstreamEvidenceOperationId('second'),
      artifactId: WorkstreamEvidenceArtifactId(config.maxVersionsPerArtifact ? 'first' : 'second'),
      expectedVersion: config.maxVersionsPerArtifact ? 2 : 1,
    })).rejects.toMatchObject({ code: 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED' })
    expect(ctx.workstreamEvidence.list(owner, owner.id)).toEqual(before)
  })

  it('rejects invalid and missing versions, and updates one artifact without replacing its peers', async () => {
    const { ctx, owner } = await setup()
    expect(() => ctx.workstreamEvidence.get(owner, owner.id, 'missing')).toThrow('not found')
    const request = { operationId: WorkstreamEvidenceOperationId('first'), artifactId: WorkstreamEvidenceArtifactId('first'),
      expectedVersion: 1, content: 'x' }
    for (const expectedVersion of [0, -1, 1.5]) {
      await expect(ctx.workstreamEvidence.publish(owner, owner.id, { ...request, expectedVersion }))
        .rejects.toMatchObject({ code: 'WORKSTREAM_EVIDENCE_INVALID_INPUT' })
    }
    await expect(ctx.workstreamEvidence.publish(owner, owner.id, { ...request, expectedVersion: 2 }))
      .rejects.toMatchObject({ code: 'WORKSTREAM_EVIDENCE_STALE_VERSION' })
    await ctx.workstreamEvidence.publish(owner, owner.id, request)
    expect(() => ctx.workstreamEvidence.get(owner, owner.id, 'missing')).toThrow('not found')
    expect(() => ctx.workstreamEvidence.get(owner, owner.id, 'first', 2)).toThrow('not found')
    await ctx.workstreamEvidence.publish(owner, owner.id, { ...request, operationId: WorkstreamEvidenceOperationId('peer'),
      artifactId: WorkstreamEvidenceArtifactId('peer') })
    await ctx.workstreamEvidence.publish(owner, owner.id, { ...request, operationId: WorkstreamEvidenceOperationId('update'),
      expectedVersion: 2, content: 'updated' })
    expect(ctx.workstreamEvidence.list(owner, owner.id).map(artifact => [artifact.artifactId, artifact.latestVersion]))
      .toEqual([['first', 2], ['peer', 1]])
  })

  it('reports oversized streams, truncated bytes, digest mismatches and non-Error reader failures', async () => {
    const { ctx, owner } = await setup({ maxBytesPerArtifact: 4 })
    await ctx.workstreamEvidence.publish(owner, owner.id, { operationId: WorkstreamEvidenceOperationId('first'),
      artifactId: WorkstreamEvidenceArtifactId('first'), expectedVersion: 1, content: 'data' })
    for (const [bytes, code] of [[new Uint8Array(5), 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED'],
      [new Uint8Array(3), 'WORKSTREAM_EVIDENCE_CORRUPT'], [new Uint8Array(4), 'WORKSTREAM_EVIDENCE_CORRUPT']] as const) {
      vi.spyOn(ctx.attachments, 'readFileStream').mockImplementationOnce(async function* () { yield bytes })
      await expect(ctx.workstreamEvidence.read(owner, owner.id, 'first')).rejects.toMatchObject({ code })
    }
    vi.spyOn(ctx.attachments, 'readFileStream').mockImplementationOnce(async function* () { throw 'reader unavailable' })
    await expect(ctx.workstreamEvidence.read(owner, owner.id, 'first')).rejects.toThrow('reader unavailable')
  })

  it('renders JSON tool results and refuses execution without a live calling Agent', async () => {
    const { ctx, owner } = await setup()
    const exec: ToolRunContext = { callId: ToolCallId('coverage'), rootCallId: ToolCallId('coverage'),
      name: 'workstream_evidence_aggregate_prs', arguments: {}, token: Symbol('coverage') as ToolExecutionToken,
      signal, agent: owner, deferContext() {}, concludeTurn() {} }
    const tool = ctx.tools.get('workstream_evidence_aggregate_prs')!
    const result = await tool.execute({ root_session_id: owner.id }, exec)
    expect(result).toMatchObject({ complete: false, changeRequests: [] })
    expect(tool.output.render({ root_session_id: owner.id }, z.json().parse(result))).toEqual([{ type: 'text', text: JSON.stringify(result) }])
    const { agent: _agent, ...withoutAgent } = exec
    await expect(tool.execute({ root_session_id: owner.id }, withoutAgent)).rejects.toThrow('require a live calling Agent')
  })
})

it('rejects unsafe numeric configuration before loading the evidence service', () => {
  const ctx = new Context()
  contexts.push(ctx)
  expect(() => new WorkstreamEvidenceService(ctx, { maxArtifacts: Number.MAX_SAFE_INTEGER + 1 })).toThrow('positive safe integer')
})
