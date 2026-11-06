/** Round-5 regressions: the complete retained record is bounded, ids normalize on read, and a cancelled publish commits nothing. */
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
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import WorkstreamEvidenceService, {
  WorkstreamEvidenceArtifactId,
  WorkstreamEvidenceOperationId,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(config: Config = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const sessionDir = mkdtempSync(join(tmpdir(), 'workstream-evidence-r5-session-'))
  const attachmentDir = mkdtempSync(join(tmpdir(), 'workstream-evidence-r5-attach-'))
  directories.push(sessionDir, attachmentDir)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionDir, compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: attachmentDir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  await ctx.plugin(WorkstreamEvidenceService, config)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 5 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Evidence' })
  return { ctx, owner }
}

function publish(ctx: Context, owner: Parameters<Context['workstreamEvidence']['publish']>[0], id: string, version: number, text = 'x',
  signal?: AbortSignal) {
  return ctx.workstreamEvidence.publish(owner, owner.id, { operationId: WorkstreamEvidenceOperationId(`op-${id}-${version}`),
    artifactId: WorkstreamEvidenceArtifactId(id), expectedVersion: version, content: text, signal })
}

/** Bytes of the complete record one publish appends, as the log stores it. */
function recordBytes(ctx: Context, owner: Parameters<Context['workstreamEvidence']['list']>[0]): number {
  const artifacts = ctx.workstreamEvidence.list(owner, owner.id)
  const revision = artifacts.reduce((sum, artifact) => sum + artifact.versions.length, 0)
  return Buffer.byteLength(JSON.stringify({ version: 1, snapshot: { ownerSessionId: owner.id, revision, artifacts } }), 'utf8')
}

describe('round-5 Workstream Evidence regressions', () => {
  it('R5-N8 refuses a publish whose complete retained record exceeds maxSnapshotBytes, and accepts one exactly at the limit', async () => {
    const reference = await setup()
    await publish(reference.ctx, reference.owner, 'report', 1)
    const exact = recordBytes(reference.ctx, reference.owner)

    const fits = await setup({ maxSnapshotBytes: exact })
    await expect(publish(fits.ctx, fits.owner, 'report', 1)).resolves.toMatchObject({ version: 1 })

    const tight = await setup({ maxSnapshotBytes: exact - 1 })
    await expect(publish(tight.ctx, tight.owner, 'report', 1)).rejects.toMatchObject({ code: 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED' })
    expect(tight.ctx.workstreamEvidence.list(tight.owner, tight.owner.id)).toEqual([])
  })

  it('R5-N8 keeps the retained record within maxSnapshotBytes across many versions, however many publishes the other limits allow', async () => {
    const limit = 4096
    const { ctx, owner } = await setup({ maxSnapshotBytes: limit })
    let accepted = 0
    let refusal: unknown
    for (let version = 1; version <= 64 && refusal === undefined; version++) {
      await publish(ctx, owner, 'log', version, `entry ${version}`).then(() => { accepted++ }, (error: unknown) => { refusal = error })
    }
    expect(refusal, 'the bound must stop the publishes before maxVersionsPerArtifact').toMatchObject({ code: 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED' })
    expect(accepted).toBeGreaterThan(1)
    expect(recordBytes(ctx, owner)).toBeLessThanOrEqual(limit)
  })

  it('R5-N8 saves no Attachment for a publish that cannot fit', async () => {
    const { ctx, owner } = await setup({ maxSnapshotBytes: 64 })
    const save = vi.spyOn(ctx.attachments, 'saveFile')
    await expect(publish(ctx, owner, 'report', 1)).rejects.toMatchObject({ code: 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED' })
    expect(save).not.toHaveBeenCalled()
  })

  it('R5-N2 rejects a read of an invalid artifact id as invalid input, not as a missing artifact', async () => {
    const { ctx, owner } = await setup()
    await publish(ctx, owner, 'notes', 1)
    expect(ctx.workstreamEvidence.get(owner, owner.id, ' notes ').version).toBe(1)
    expect(() => ctx.workstreamEvidence.get(owner, owner.id, 'a/b')).toThrow(expect.objectContaining({ code: 'WORKSTREAM_EVIDENCE_INVALID_INPUT' }))
  })

  it('R5-N3 commits nothing when the publish is cancelled while its Attachment is being saved', async () => {
    const { ctx, owner } = await setup()
    const cancel = new AbortController()
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementationOnce(async (input) => {
      const ref = await save(input)
      cancel.abort(new Error('tool call cancelled'))
      return ref
    })
    await expect(publish(ctx, owner, 'report', 1, 'Late', cancel.signal)).rejects.toThrow('tool call cancelled')
    expect(ctx.workstreamEvidence.list(owner, owner.id)).toEqual([])
    await expect(publish(ctx, owner, 'report', 1, 'Late')).resolves.toMatchObject({ version: 1 })
  })

  it('R5-N3 commits nothing for a publish cancelled while it waits behind an earlier publish', async () => {
    const { ctx, owner } = await setup()
    const cancel = new AbortController()
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementationOnce(async (input) => { await held; return save(input) })
    const first = publish(ctx, owner, 'first', 1)
    const second = publish(ctx, owner, 'second', 1, 'x', cancel.signal)
    const settled = second.then(() => 'published', () => 'rejected')
    cancel.abort(new Error('tool call cancelled'))
    release()
    await first
    expect(await settled).toBe('rejected')
    expect(ctx.workstreamEvidence.list(owner, owner.id).map(artifact => artifact.artifactId)).toEqual(['first'])
  })
})
