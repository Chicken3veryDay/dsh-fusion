import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { logPath } from '../../../session/session-persistence-jsonl/src/format.ts'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
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

  await ctx.plugin(JsonlSessionPersistence, { root: sessionDir, compression: 'none' })
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

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }
function deferred(): Deferred {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => { resolve = () => { done() } })
  return { promise, resolve }
}
const evidenceRequest = (id: string) => ({ operationId: WorkstreamEvidenceOperationId(id),
  artifactId: WorkstreamEvidenceArtifactId(id), expectedVersion: 1, content: 'retained content' })

describe('round-2 Evidence review', () => {
  it('F3 publishes a readable immutable version when the caller reuses its input byte buffer during I/O', async () => {
    const { ctx, owner } = await setup()
    const entered = deferred(), release = deferred()
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementationOnce(async (input) => {
      entered.resolve(); await release.promise; return save(input)
    })
    const content = new Uint8Array([65, 66, 67])
    const publishing = ctx.workstreamEvidence.publish(owner, owner.id,
      { ...evidenceRequest('mutable-buffer'), content })
    try {
      await entered.promise
      content.fill(90)
      release.resolve()
      const published = await publishing
      expect(published.version).toBe(1)
      await expect(ctx.workstreamEvidence.read(owner, owner.id, 'mutable-buffer')).resolves.toMatchObject(
        { data: new Uint8Array([65, 66, 67]) })
    } finally { release.resolve(); await Promise.allSettled([publishing]) }
  })

  it('F3 keeps the bytes selected at entry when the caller reuses its buffer while the publish waits in the queue', async () => {
    const { ctx, owner } = await setup()
    const entered = deferred(), release = deferred()
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementationOnce(async (input) => {
      entered.resolve(); await release.promise; return save(input)
    })
    const blocker = ctx.workstreamEvidence.publish(owner, owner.id, evidenceRequest('blocker'))
    const content = new Uint8Array([65, 66, 67])
    const queued = ctx.workstreamEvidence.publish(owner, owner.id, { ...evidenceRequest('queued-buffer'), content })
    try {
      await entered.promise
      content.fill(90)
      release.resolve()
      await Promise.all([blocker, queued])
      await expect(ctx.workstreamEvidence.read(owner, owner.id, 'queued-buffer')).resolves.toMatchObject(
        { data: new Uint8Array([65, 66, 67]) })
    } finally { release.resolve(); await Promise.allSettled([blocker, queued]) }
  })

  it('F4 never reports a retry as published while the first record remains unpersisted after a drain failure', async () => {
    const { ctx, owner, sessionDir } = await setup()
    // oxlint-disable-next-line typescript/unbound-method -- called back with the real handle by the spy below.
    const drain = JsonlSessionHandle.prototype.drainLive
    const failure = new Error('review: disk drain unavailable')
    const spy = vi.spyOn(JsonlSessionHandle.prototype, 'drainLive').mockImplementation(function (this: JsonlSessionHandle) {
      if (this.id === owner.id) return Promise.reject(failure)
      return drain.call(this)
    })
    const input = evidenceRequest('failed-durability')
    try {
      await expect(ctx.workstreamEvidence.publish(owner, owner.id, input)).rejects.toThrow('disk drain unavailable')
      const file = logPath(sessionDir, owner.session.header.cwd, owner.id, 'none')
      // While the storage failure continues, a retry must report it instead of the unpersisted version.
      await expect(ctx.workstreamEvidence.publish(owner, owner.id, input)).rejects.toThrow('disk drain unavailable')
      expect(readFileSync(file, 'utf8').includes('"type":"plugin:workstream-evidence/state"')).toBe(false)
      spy.mockRestore()
      const retried = await ctx.workstreamEvidence.publish(owner, owner.id, input)
      expect(retried.version).toBe(1)
      expect(readFileSync(file, 'utf8').includes('"type":"plugin:workstream-evidence/state"'),
        'a successful publish retry must have a physically retained version record').toBe(true)
    } finally { spy.mockRestore(); await ctx.sessions.flush(owner.session) }
  })

  it('C4 reports stopped and stopping member change requests, deduplicating shared URLs', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('pr-member'),
      name: 'worker', description: 'Worker', provider: 'spawn', prompt: 'Work', signal })
    const url = 'https://github.com/example/repo/pull/1'
    const fake: Pick<ForgeSessionService, 'changeRequests'> = { changeRequests: (_session: Session) =>
      [{ url, origin: 'created', ref: null, update: null }] }
    ctx.provide('forgeSession'); ctx.set('forgeSession', fake)
    const entered = deferred(), release = deferred()
    const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'drainChildren').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return drain(...args)
    })
    const stopping = ctx.workstreams.stop(owner, owner.id, member.id)
    try {
      await entered.promise
      const during = ctx.workstreamEvidence.aggregateChangeRequests(owner, owner.id)
      expect(during).toMatchObject({ complete: true, diagnostics: [] })
      expect(during.changeRequests).toHaveLength(1)
      expect(during.changeRequests[0]?.contributions.map(c => c.sessionId)).toEqual([owner.id, member.id])
      release.resolve()
      await stopping
      const after = ctx.workstreamEvidence.aggregateChangeRequests(owner, owner.id)
      expect(after.changeRequests).toHaveLength(1)
      expect(after.changeRequests[0]?.contributions.some(c => c.sessionId === member.id)
        || (!after.complete && after.diagnostics.some(d => d.includes(member.id)))).toBe(true)
    } finally { release.resolve(); await Promise.allSettled([stopping]) }
  })

  it('C5 does not append a revoked member version after attachment I/O and keeps the existing version intact', async () => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, { operationId: WorkstreamOperationId('member'),
      name: 'worker', description: 'Worker', provider: 'spawn', prompt: 'Work', signal })
    const caller = ctx.agents.get(member.id)!
    const initial = evidenceRequest('race-version')
    await ctx.workstreamEvidence.publish(owner, owner.id, initial)
    const entered = deferred(), release = deferred()
    const save = ctx.attachments.saveFile.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'saveFile').mockImplementationOnce(async (input) => {
      entered.resolve(); await release.promise; return save(input)
    })
    const next = { ...initial, expectedVersion: 2, operationId: WorkstreamEvidenceOperationId('next'), content: 'late bytes' }
    const publishing = ctx.workstreamEvidence.publish(caller, owner.id, next)
    const observed = publishing.then(() => 'published', () => 'rejected')
    try {
      await entered.promise
      await ctx.workstreams.stop(owner, owner.id, member.id)
      release.resolve()
      expect(await observed).toBe('rejected')
      expect(ctx.workstreamEvidence.get(owner, owner.id, initial.artifactId)).toMatchObject({ version: 1 })
      await expect(ctx.workstreamEvidence.readText(owner, owner.id, initial.artifactId)).resolves.toMatchObject(
        { text: initial.content })
    } finally { release.resolve(); await Promise.allSettled([publishing]) }
  })
})
