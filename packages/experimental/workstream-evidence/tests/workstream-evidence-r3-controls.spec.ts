import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { logPath } from '../../../session/session-persistence-jsonl/src/format.ts'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
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

  await ctx.plugin(JsonlSessionPersistence, { root: sessionDir, compression: 'none' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: attachmentDir })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  const fiber = await ctx.plugin(WorkstreamEvidenceService, {
    maxBytesPerArtifact: 1024 * 1024,
    maxContextPacketBytes: 4096,
  })
  await ctx.plugin(WorkstreamEvidenceTools)

  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 25 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open-workstream'), title: 'Test Stream' })

  return { ctx, owner, fiber, sessionDir, attachmentDir }
}

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }
function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = () => { done() } })
  return { promise, resolve }
}
const evidenceRequest = (id: string) => ({ operationId: WorkstreamEvidenceOperationId(id),
  artifactId: WorkstreamEvidenceArtifactId(id), expectedVersion: 1, content: 'retained content' })

describe('round-3 Evidence review', () => {
  it('C1 shutdown drains an admitted publish and refuses new publication', async () => {
    const { ctx, owner, fiber, sessionDir } = await setup()
    const service = ctx.workstreamEvidence
    const entered = deferred(), release = deferred(), stopping = deferred()
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementationOnce(async (input) => {
      entered.resolve(); await release.promise; return save(input)
    })
    // oxlint-disable-next-line typescript/unbound-method -- called back with the real receiver by the spy below.
    const abort = AbortController.prototype.abort
    vi.spyOn(AbortController.prototype, 'abort').mockImplementation(function (this: AbortController, reason?: unknown) {
      abort.call(this, reason)
      if (reason instanceof Error && 'code' in reason && reason.code === 'WORKSTREAM_EVIDENCE_DISPOSED') stopping.resolve()
    })
    const publishing = service.publish(owner, owner.id, evidenceRequest('after-shutdown'))
    const observed = publishing.then(() => 'published', () => 'rejected')
    let disposal: Promise<void> | undefined
    try {
      await entered.promise
      disposal = fiber.dispose()
      await stopping.promise
      await expect(service.publish(owner, owner.id, evidenceRequest('new-call')))
        .rejects.toMatchObject({ code: 'WORKSTREAM_EVIDENCE_DISPOSED' })
      release.resolve()
      expect(await observed).toBe('published')
      const physical = readFileSync(logPath(sessionDir, owner.session.header.cwd, owner.id, 'none'), 'utf8')
      expect(physical).toContain('after-shutdown')
    } finally { release.resolve(); await Promise.allSettled([publishing, ...(disposal ? [disposal] : [])]) }
  })

  it('C3 concurrent member stop and Evidence shutdown cannot append a revoked version', async () => {
    const { ctx, owner, fiber } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('worker'),
      name: 'worker', description: 'Worker', provider: 'spawn', prompt: 'Work', signal })
    const caller = ctx.agents.get(member.id)!
    const service = ctx.workstreamEvidence
    const input = evidenceRequest('retained')
    await service.publish(owner, owner.id, input)
    const saved = deferred(), saveRelease = deferred(), draining = deferred(), drainRelease = deferred(), stopping = deferred()
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementationOnce(async (request) => {
      saved.resolve(); await saveRelease.promise; return save(request)
    })
    const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'drainChildren').mockImplementationOnce(async (...args) => {
      draining.resolve(); await drainRelease.promise; return drain(...args)
    })
    // oxlint-disable-next-line typescript/unbound-method -- called back with the real receiver by the spy below.
    const abort = AbortController.prototype.abort
    vi.spyOn(AbortController.prototype, 'abort').mockImplementation(function (this: AbortController, reason?: unknown) {
      abort.call(this, reason)
      if (reason instanceof Error && 'code' in reason && reason.code === 'WORKSTREAM_EVIDENCE_DISPOSED') stopping.resolve()
    })
    const publishing = service.publish(caller, owner.id, { ...input, expectedVersion: 2,
      operationId: WorkstreamEvidenceOperationId('late-version'), content: 'Must not be published' })
    const observed = publishing.then(() => 'published', () => 'rejected')
    let stop: Promise<unknown> | undefined, disposal: Promise<void> | undefined
    try {
      await saved.promise
      stop = ctx.workstreams.stop(owner, owner.id, member.id)
      await draining.promise
      expect(ctx.agents.get(member.id)).toBe(caller)
      expect(() => ctx.workstreams.requireMembership(caller, owner.id)).toThrow()
      disposal = fiber.dispose()
      await stopping.promise
      saveRelease.resolve()
      expect(await observed).toBe('rejected')
      await disposal
      await ctx.plugin(WorkstreamEvidenceService)
      expect(ctx.workstreamEvidence.get(owner, owner.id, input.artifactId).version).toBe(1)
      await expect(ctx.workstreamEvidence.readText(owner, owner.id, input.artifactId)).resolves.toMatchObject({ text: input.content })
    } finally {
      saveRelease.resolve(); drainRelease.resolve()
      await Promise.allSettled([publishing, ...(stop ? [stop] : []), ...(disposal ? [disposal] : [])])
    }
  })

})

describe('round-3 Evidence durability controls', () => {
  it('C2 a publish retry restores durability without a second append or attachment save', async () => {
    const { ctx, owner, sessionDir } = await setup()
    const save = vi.spyOn(ctx.attachments, 'saveFile')
    // oxlint-disable-next-line typescript/unbound-method -- called back with the real handle by the spy below.
    const originalDrain = JsonlSessionHandle.prototype.drainLive
    const spy = vi.spyOn(JsonlSessionHandle.prototype, 'drainLive').mockImplementation(function (this: JsonlSessionHandle) {
      if (this.id === owner.id) return Promise.reject(new Error('review-r3: disk unavailable'))
      return originalDrain.call(this)
    })
    const input = evidenceRequest('durable-once')
    try {
      await expect(ctx.workstreamEvidence.publish(owner, owner.id, input)).rejects.toThrow('disk unavailable')
      await expect(ctx.workstreamEvidence.publish(owner, owner.id, input)).rejects.toThrow('disk unavailable')
      expect(readFileSync(logPath(sessionDir, owner.session.header.cwd, owner.id, 'none'), 'utf8'))
        .not.toContain('"type":"plugin:workstream-evidence/state"')
      const before = owner.session.snapshotEvents().length
      spy.mockRestore()
      await ctx.workstreamEvidence.publish(owner, owner.id, input)
      expect(owner.session.snapshotEvents()).toHaveLength(before)
      expect(save).toHaveBeenCalledTimes(1)
      const physical = readFileSync(logPath(sessionDir, owner.session.header.cwd, owner.id, 'none'), 'utf8')
      expect(physical.split('\n').filter(line => line.includes('"type":"plugin:workstream-evidence/state"'))).toHaveLength(1)
    } finally { spy.mockRestore(); await ctx.sessions.flush(owner.session) }
  })
})
