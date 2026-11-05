import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ForgeSessionService, SessionChangeRequest } from '@deepseek-ai/dsh-experimental-forge-session'
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

async function setup() {
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
  })
  await ctx.plugin(WorkstreamEvidenceTools)

  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open-workstream'), title: 'Test Stream' })

  return { ctx, owner, sessionDir, attachmentDir }
}

describe('WorkstreamEvidenceService', () => {
  it('publishes immutable versions and restores them after restart', async () => {
    const { ctx, owner, sessionDir, attachmentDir } = await setup()

    const v1 = await ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-1'),
      artifactId: WorkstreamEvidenceArtifactId('spec-doc'),
      name: 'spec.md',
      expectedVersion: 1,
      content: 'version 1 content',
    })
    expect(v1.version).toBe(1)
    expect(v1.name).toBe('spec.md')
    expect(v1.bytes).toBe(17)

    const v2 = await ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-2'),
      artifactId: WorkstreamEvidenceArtifactId('spec-doc'),
      expectedVersion: 2,
      content: 'version 2 updated content',
    })
    expect(v2.version).toBe(2)
    expect(v2.bytes).toBe(25)

    const list = ctx.workstreamEvidence.list(owner, owner.id)
    expect(list).toHaveLength(1)
    expect(list[0]?.latestVersion).toBe(2)
    expect(list[0]?.versions).toHaveLength(2)

    const read1 = await ctx.workstreamEvidence.readText(owner, owner.id, 'spec-doc', 1)
    expect(read1.text).toBe('version 1 content')
    expect(read1.metadata.version).toBe(1)

    const read2 = await ctx.workstreamEvidence.readText(owner, owner.id, 'spec-doc', 2)
    expect(read2.text).toBe('version 2 updated content')
    expect(read2.metadata.version).toBe(2)

    // Dispose first context so write handle is released before restart
    await ctx.fiber.dispose()

    // Simulate restart with a new Context over the persisted directories
    const ctx2 = new Context()
    contexts.push(ctx2)
    await mountAgentLoopTestDependencies(ctx2)
    await mountWorkingDirectoryFixture(ctx2)
    await ctx2.plugin(JsonlSessionPersistence, { root: sessionDir })
    await ctx2.plugin(LocalAttachmentStore, { dshHome: attachmentDir })
    await ctx2.plugin(TestSessionQuery)
    await ctx2.plugin(AgentLoop, { agents: [] })
    await ctx2.plugin(Subagents)
    await ctx2.plugin(Spawn, { providerName: 'spawn' })
    await ctx2.plugin(TicketService)
    await ctx2.plugin(WorkstreamService)
    await ctx2.plugin(WorkstreamEvidenceService)
    ctx2.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))

    const handle = await ctx2.agents.resume({ resumeSessionId: owner.id })
    const restartedOwner = handle.agent
    const restoredList = ctx2.workstreamEvidence.list(restartedOwner, owner.id)
    expect(restoredList).toHaveLength(1)
    expect(restoredList[0]?.latestVersion).toBe(2)

    const restoredRead2 = await ctx2.workstreamEvidence.readText(restartedOwner, owner.id, 'spec-doc', 2)
    expect(restoredRead2.text).toBe('version 2 updated content')
  })

  it('deduplicates retry and rejects changed payload or stale version', async () => {
    const { ctx, owner } = await setup()

    const first = await ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-retry'),
      artifactId: WorkstreamEvidenceArtifactId('data-artifact'),
      expectedVersion: 1,
      content: 'payload A',
    })

    // Same operation retry with same payload -> returns same version record
    const retry = await ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-retry'),
      artifactId: WorkstreamEvidenceArtifactId('data-artifact'),
      expectedVersion: 1,
      content: 'payload A',
    })
    expect(retry.operationId).toBe(first.operationId)
    expect(retry.digest).toBe(first.digest)

    // Same operation retry with DIFFERENT payload -> rejects
    await expect(ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-retry'),
      artifactId: WorkstreamEvidenceArtifactId('data-artifact'),
      expectedVersion: 1,
      content: 'payload B different',
    })).rejects.toThrow(/already completed with different payload/)

    // Out of order expectedVersion (expected 2, passing 5) -> rejects
    await expect(ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-stale'),
      artifactId: WorkstreamEvidenceArtifactId('data-artifact'),
      expectedVersion: 5,
      content: 'future payload',
    })).rejects.toThrow(/does not match next version/)
  })

  it('rejects foreign or non-live callers', async () => {
    const { ctx, owner } = await setup()

    const stranger = await ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })

    await expect(ctx.workstreamEvidence.publish(stranger, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-stranger'),
      artifactId: WorkstreamEvidenceArtifactId('secret'),
      expectedVersion: 1,
      content: 'nope',
    })).rejects.toThrow(/Caller is not an active member/)

    expect(() => ctx.workstreamEvidence.list(stranger, owner.id))
      .toThrow(/Caller is not an active member/)
  })

  it('detects missing or corrupt bytes', async () => {
    const { ctx, owner } = await setup()

    const record = await ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-corrupt'),
      artifactId: WorkstreamEvidenceArtifactId('corrupt-doc'),
      expectedVersion: 1,
      content: 'exact bytes before corruption',
    })

    const attachmentStore = ctx.attachments as LocalAttachmentStore
    const hash = record.ref.replace('sha256:', '')
    const actualFilePath = join(
      attachmentStore.root,
      'files',
      hash.slice(0, 2),
      hash,
      record.name,
    )

    // Overwrite the file with corrupted data (file is read-only by default)
    chmodSync(actualFilePath, 0o666)
    writeFileSync(actualFilePath, Buffer.from('corrupted data'))

    await expect(ctx.workstreamEvidence.read(owner, owner.id, 'corrupt-doc', 1))
      .rejects.toThrow(/integrity verification|Integrity failure|Digest mismatch/)
  })

  it('enforces bounds and validates prepareContext against foreign links', async () => {
    const { ctx, owner } = await setup()

    // Exceeds maxBytesPerArtifact limit
    const huge = 'x'.repeat(1024 * 1024 + 10)
    await expect(ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-huge'),
      artifactId: WorkstreamEvidenceArtifactId('huge-doc'),
      expectedVersion: 1,
      content: huge,
    })).rejects.toThrow(/exceeds maxBytesPerArtifact/)

    // Valid publish
    const v1 = await ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('op-valid'),
      artifactId: WorkstreamEvidenceArtifactId('plan'),
      expectedVersion: 1,
      content: 'valid plan',
    })

    // prepareContext with mutable/foreign path escapes
    expect(() => ctx.workstreamEvidence.prepareContext(owner, owner.id, {
      requirements: 'req',
      decisions: ['d1'],
      cursor: 'cur',
      changes: 'chg',
      artifacts: [{ artifactId: '/etc/passwd', version: 1 }],
    })).toThrow(/Mutable or foreign link rejected/)

    // prepareContext with valid artifact version
    const packet = ctx.workstreamEvidence.prepareContext(owner, owner.id, {
      requirements: 'build feature',
      decisions: ['use attachments'],
      cursor: 'rev-1',
      changes: 'added tests',
      artifacts: [{ artifactId: 'plan', version: 1 }],
    })
    expect(packet.artifacts).toEqual([{ ref: v1.ref, digest: v1.digest }])
    expect(packet.requirements).toBe('build feature')
  })

  it('rejects text reads above maxToolTextBytes or with invalid UTF-8', async () => {
    const { ctx, owner } = await setup()
    await ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('binary'), artifactId: WorkstreamEvidenceArtifactId('binary'),
      expectedVersion: 1, content: new Uint8Array([0xff, 0xfe]),
    })
    await expect(ctx.workstreamEvidence.readText(owner, owner.id, 'binary')).rejects.toMatchObject({ code: 'WORKSTREAM_EVIDENCE_INVALID_INPUT' })
    expect((await ctx.workstreamEvidence.read(owner, owner.id, 'binary')).data).toEqual(new Uint8Array([0xff, 0xfe]))

    await ctx.workstreamEvidence.publish(owner, owner.id, {
      operationId: WorkstreamEvidenceOperationId('large'), artifactId: WorkstreamEvidenceArtifactId('large'),
      expectedVersion: 1, content: 'é'.repeat(32_769),
    })
    await expect(ctx.workstreamEvidence.readText(owner, owner.id, 'large')).rejects.toMatchObject({ code: 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED' })
  })

  it('aggregates and deduplicates change requests across members with diagnostics', async () => {
    const { ctx, owner } = await setup()

    // Add member
    const memberRequest = {
      operationId: WorkstreamOperationId('add-worker'),
      name: 'worker1',
      description: 'Worker',
      provider: 'spawn',
      prompt: 'hello',
      signal,
    }
    const member = await ctx.workstreams.addMember(owner, owner.id, memberRequest)
    const memberAgent = ctx.agents.get(member.id)!

    const binding = (url: string, origin: SessionChangeRequest['origin']): SessionChangeRequest => ({ url, origin, ref: null, update: null })
    const bindings = new Map<string, SessionChangeRequest[]>([
      [owner.id, [binding('https://github.com/org/repo/pull/10', 'created'), binding('https://github.com/org/repo/pull/11', 'tracked')]],
      [memberAgent.id, [binding('https://github.com/org/repo/pull/10', 'discovered'), binding('https://github.com/org/repo/pull/12', 'created')]],
    ])
    const fake: Pick<ForgeSessionService, 'changeRequests'> = { changeRequests: (session: Session) => bindings.get(session.id) ?? [] }
    ctx.provide('forgeSession')
    ctx.set('forgeSession', fake)

    const aggregated = ctx.workstreamEvidence.aggregateChangeRequests(owner, owner.id)
    expect(aggregated.complete).toBe(true)
    expect(aggregated.diagnostics).toEqual([])
    expect(aggregated.changeRequests.map(item => item.url)).toEqual([
      'https://github.com/org/repo/pull/10', 'https://github.com/org/repo/pull/11', 'https://github.com/org/repo/pull/12',
    ])
    expect(aggregated.changeRequests[0]?.contributions).toEqual([
      { sessionId: owner.id, origin: 'created', update: null },
      { sessionId: memberAgent.id, origin: 'discovered', update: null },
    ])
    expect(aggregated.changeRequests[2]?.contributions.map(item => item.sessionId)).toEqual([memberAgent.id])

    vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === owner.id ? owner : undefined)
    vi.spyOn(ctx.sessions, 'get').mockReturnValue(undefined)
    const partial = ctx.workstreamEvidence.aggregateChangeRequests(owner, owner.id)
    expect(partial.complete).toBe(false)
    expect(partial.diagnostics).toEqual([`Session ${memberAgent.id} is not loaded; its change requests are not included`])
    expect(partial.changeRequests.map(item => item.url)).toEqual(['https://github.com/org/repo/pull/10', 'https://github.com/org/repo/pull/11'])
  })

  it('executes model tools for publish, list, and read', async () => {
    const { ctx, owner } = await setup()
    const toolExec: ToolRunContext = {
      callId: ToolCallId('evidence-tool'), rootCallId: ToolCallId('evidence-tool'), name: 'workstream_evidence_publish',
      arguments: {}, token: Symbol('evidence-tool') as ToolExecutionToken, signal, agent: owner,
      deferContext() {}, concludeTurn() {},
    }

    const publishTool = ctx.tools.get('workstream_evidence_publish')!
    expect(publishTool).toBeDefined()

    const publishResult = await publishTool.execute({
      root_session_id: owner.id,
      operation_id: 'tool-op-1',
      artifact_id: 'tool-doc',
      expected_version: 1,
      text: 'hello from tool',
      name: 'tool.txt',
    }, toolExec) as { version: number; bytes: number }

    expect(publishResult.version).toBe(1)
    expect(publishResult.bytes).toBe(15)

    const listTool = ctx.tools.get('workstream_evidence_list')!
    const listResult = await listTool.execute({
      root_session_id: owner.id,
    }, toolExec) as unknown[]
    expect(listResult).toHaveLength(1)

    const readTool = ctx.tools.get('workstream_evidence_read')!
    const readResult = await readTool.execute({
      root_session_id: owner.id,
      artifact_id: 'tool-doc',
      version: 1,
    }, toolExec) as { text: string }
    expect(readResult.text).toBe('hello from tool')
  })
})
