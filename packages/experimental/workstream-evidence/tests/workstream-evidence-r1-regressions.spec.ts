import { mkdtempSync, rmSync } from 'node:fs'
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
import type { ForgeSessionService } from '@deepseek-ai/dsh-experimental-forge-session'
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

type Outcome = { status: 'published'; value: unknown } | { status: 'rejected'; error: unknown }
interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }
function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = () => { done() } })
  return { promise, resolve }
}
const evidenceRequest = (id: string) => ({ operationId: WorkstreamEvidenceOperationId(id),
  artifactId: WorkstreamEvidenceArtifactId(id), expectedVersion: 1, content: 'retained content' })

describe('round-1 review regressions', () => {
  it('R1 reads an artifact published with a display name normalized by attachments', async () => {
    const { ctx, owner } = await setup()
    await ctx.workstreamEvidence.publish(owner, owner.id, { ...evidenceRequest('filename'), name: 'notes/spec.md' })
    await expect(ctx.workstreamEvidence.readText(owner, owner.id, 'filename')).resolves.toMatchObject({ text: 'retained content' })
  })

  it('R2 revalidates active membership when a queued publish starts', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('member'),
      name: 'worker', description: 'Worker', provider: 'spawn', prompt: 'Work', signal })
    const child = ctx.agents.get(member.id)!
    const saveEntered = deferred(), saveRelease = deferred(), drainEntered = deferred(), drainRelease = deferred()
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementationOnce(async (input) => {
      saveEntered.resolve(); await saveRelease.promise; return save(input)
    })
    const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'drainChildren').mockImplementationOnce(async (...args) => {
      drainEntered.resolve(); await drainRelease.promise; return drain(...args)
    })
    const first = ctx.workstreamEvidence.publish(owner, owner.id, evidenceRequest('blocking'))
    await saveEntered.promise
    const queued = ctx.workstreamEvidence.publish(child, owner.id, evidenceRequest('after-revocation'))
    const observed = queued.then((value): Outcome => ({ status: 'published', value }), (error: unknown): Outcome => ({ status: 'rejected', error }))
    const stop = ctx.workstreams.stop(owner, owner.id, child.id)
    try {
      await drainEntered.promise
      expect(ctx.workstreams.get(owner, owner.id).members.find(m => m.id === child.id)?.phase).toBe('stopping')
      expect(ctx.agents.get(child.id)).toBe(child)
      expect(() => ctx.workstreams.requireMembership(child, owner.id)).toThrow()
      saveRelease.resolve()
      await first
      expect(await observed).toMatchObject({ status: 'rejected' })
    } finally {
      saveRelease.resolve(); drainRelease.resolve()
      await Promise.allSettled([first, queued, stop])
    }
  })

  it('R3 includes stopped member PRs or reports their omission as incomplete', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('pr-member'),
      name: 'worker', description: 'Worker', provider: 'spawn', prompt: 'Work', signal })
    const fake: Pick<ForgeSessionService, 'changeRequests'> = { changeRequests: (session: Session) => session.id === member.id
      ? [{ url: 'https://github.com/example/repo/pull/1', origin: 'created', ref: null, update: null }] : [] }
    ctx.provide('forgeSession'); ctx.set('forgeSession', fake)
    expect(ctx.workstreamEvidence.aggregateChangeRequests(owner, owner.id).changeRequests).toHaveLength(1)
    await ctx.workstreams.stop(owner, owner.id, member.id)
    const result = ctx.workstreamEvidence.aggregateChangeRequests(owner, owner.id)
    expect(result.complete && result.changeRequests.length === 0).toBe(false)
    expect(result.changeRequests.length === 1 || result.diagnostics.some(line => line.includes(member.id))).toBe(true)
  })

  it('R2 rejects a publish whose membership is revoked while its attachment save is in flight', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('member-inflight'),
      name: 'worker', description: 'Worker', provider: 'spawn', prompt: 'Work', signal })
    const child = ctx.agents.get(member.id)!
    const saveEntered = deferred(), saveRelease = deferred(), drainEntered = deferred(), drainRelease = deferred()
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementationOnce(async (input) => {
      saveEntered.resolve(); await saveRelease.promise; return save(input)
    })
    const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'drainChildren').mockImplementationOnce(async (...args) => {
      drainEntered.resolve(); await drainRelease.promise; return drain(...args)
    })
    const publish = ctx.workstreamEvidence.publish(child, owner.id, evidenceRequest('in-flight'))
    const observed = publish.then((value): Outcome => ({ status: 'published', value }), (error: unknown): Outcome => ({ status: 'rejected', error }))
    const stop = ctx.workstreams.stop(owner, owner.id, child.id)
    try {
      await saveEntered.promise
      await drainEntered.promise
      saveRelease.resolve()
      expect(await observed).toMatchObject({ status: 'rejected' })
      expect(ctx.workstreamEvidence.list(owner, owner.id)).toEqual([])
    } finally {
      saveRelease.resolve(); drainRelease.resolve()
      await Promise.allSettled([publish, stop])
    }
  })

  it('C1 saves attachments before appending the evidence record and permits retry after save failure', async () => {
    const { ctx, owner } = await setup()
    const request = evidenceRequest('save-failure')
    vi.spyOn(ctx.attachments, 'saveFile').mockRejectedValueOnce(new Error('store unavailable'))
    await expect(ctx.workstreamEvidence.publish(owner, owner.id, request)).rejects.toThrow('store unavailable')
    expect(ctx.workstreamEvidence.list(owner, owner.id)).toEqual([])
    await expect(ctx.workstreamEvidence.publish(owner, owner.id, request)).resolves.toMatchObject({ version: 1 })
  })

  it('C2 bounds the complete multibyte context packet and rejects unretained references', async () => {
    const { ctx, owner } = await setup()
    const packet = { requirements: 'é'.repeat(2048), decisions: [], cursor: '', changes: '', artifacts: [] }
    expect(() => ctx.workstreamEvidence.prepareContext(owner, owner.id, packet))
      .toThrow(expect.objectContaining({ code: 'WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED' }))
    expect(() => ctx.workstreamEvidence.prepareContext(owner, owner.id, { ...packet, requirements: '', artifacts: [
      { artifactId: 'unretained', version: 1 },
    ] })).toThrow(expect.objectContaining({ code: 'WORKSTREAM_EVIDENCE_NOT_FOUND' }))
  })

})
