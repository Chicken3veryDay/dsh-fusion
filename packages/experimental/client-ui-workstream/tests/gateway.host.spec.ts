/** Gateway authorization and displayed-Session identity for Workstream panel commands. */
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TicketService from '@deepseek-ai/dsh-experimental-ticket'
import type { TicketView } from '@deepseek-ai/dsh-experimental-ticket'
import WorkstreamService, { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import WorkstreamEvidenceService from '@deepseek-ai/dsh-experimental-workstream-evidence'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestSessionQuery } from '../../agent-team/tests/test-session-query.ts'
import { ticketActor } from '../../ticket/tests/ticket-actor.ts'
import WorkstreamPanelController from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', prefix))
  directories.push(dir)
  return dir
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: scratch('workstream-panel-sessions-') })
  await ctx.plugin(LocalAttachmentStore, { dshHome: scratch('workstream-panel-attachments-') })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(TicketService)
  await ctx.plugin(WorkstreamService)
  await ctx.plugin(WorkstreamEvidenceService)
  await ctx.plugin(WorkstreamPanelController)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 4 }, () => 'hang' as const)))
  const owner = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })
  await ctx.workstreams.open(owner, { operationId: WorkstreamOperationId('open'), title: 'Release' })
  const created = await ctx.workstreams.createTicket(owner, owner.id, { subject: 'Ship', description: 'Ship the release' })
  const asked = await ticketActor(ctx, owner.id, () => ctx.tickets.ask(owner.session, {
    ticketId: created.id, expectedRevision: created.revision, actorId: owner.id, question: 'Which branch?',
  }))
  const ticket = await ticketActor(ctx, owner.id, () => ctx.tickets.attention(owner.session, {
    ticketId: asked.id, expectedRevision: asked.revision, actorId: owner.id, kind: 'decision', message: 'Pick a date',
  }))
  return { ctx, owner, ticket, question: ticket.questions[0]!.id, attention: ticket.attentions[0]!.id }
}

function current(ctx: Context, ticket: TicketView): TicketView {
  return ctx.tickets.get(ctx.agents.get(SessionId('owner'))!.session, ticket.id)
}


it('the actual gateway resolves the displayed live Agent and ignores alternate actor/root request fields', async () => {
  const { ctx, owner, ticket, question } = await setup()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  await ctx.typertGateway.invoke({ peer, namespace: 'workstreamPanel', method: 'answerQuestion', args: {
    agentId: owner.id, request: { ticketId: ticket.id, questionId: question, expectedRevision: ticket.revision,
      answer: 'main', actorId: 'someone-else', rootSessionId: 'someone-else' },
  } })
  expect(current(ctx, ticket).questions[0]).toMatchObject({ answer: 'main', answeredBy: owner.id })
})

it('a live member cannot answer as the coordinator by adding an actor field', async () => {
  const { ctx, owner, ticket, question } = await setup()
  const member = await ctx.workstreams.addMember(owner, owner.id, {
    operationId: WorkstreamOperationId('child'), name: 'child', description: 'worker',
    provider: 'spawn', prompt: 'Work', signal: new AbortController().signal,
  })
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  await expect(ctx.typertGateway.invoke({ peer, namespace: 'workstreamPanel', method: 'answerQuestion', args: {
    agentId: member.id, request: { ticketId: ticket.id, questionId: question, expectedRevision: ticket.revision,
      answer: 'main', actorId: owner.id, rootSessionId: owner.id },
  } })).rejects.toMatchObject({ code: 'workstreamPanel/denied' })
  expect(current(ctx, ticket)).toEqual(ticket)
})

it('invalid wire revisions leave the durable Ticket unchanged through the source gateway', async () => {
  const { ctx, owner, ticket, question } = await setup()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  for (const expectedRevision of [0, -1, 1.5, '4', null]) {
    await expect(ctx.typertGateway.invoke({ peer, namespace: 'workstreamPanel', method: 'closeQuestion', args: {
      agentId: owner.id, request: { ticketId: ticket.id, questionId: question, expectedRevision },
    } })).rejects.toMatchObject({ code: 'workstreamPanel/rejected' })
    expect(current(ctx, ticket)).toEqual(ticket)
  }
})

it('a member can close its own question on the root log, and stopped membership is refused', async () => {
  const { ctx, owner, ticket } = await setup()
  const member = await ctx.workstreams.addMember(owner, owner.id, {
    operationId: WorkstreamOperationId('child'), name: 'child', description: 'worker',
    provider: 'spawn', prompt: 'Work', signal: new AbortController().signal,
  })
  const child = ctx.agents.get(member.id)!
  // Ask as a participant of a Ticket coordinated by this child, then close through its live membership.
  const created = await ticketActor(ctx, owner.id, () =>
    ctx.tickets.create(owner.session, { subject: 'Child question', description: '', coordinatorId: child.id }))
  const asked = await ticketActor(ctx, child.id, () =>
    ctx.tickets.ask(owner.session, { ticketId: created.id, expectedRevision: created.revision,
      actorId: child.id, question: 'Ready?' }))
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  await ctx.typertGateway.invoke({ peer, namespace: 'workstreamPanel', method: 'closeQuestion', args: {
    agentId: child.id, request: { ticketId: asked.id, questionId: asked.questions[0]!.id, expectedRevision: asked.revision },
  } })
  expect(current(ctx, asked).questions[0]?.status).toBe('closed')
  await ctx.workstreams.stop(owner, owner.id, child.id)
  await expect(ctx.workstreamPanel.resolveAttention(child, {
    ticketId: ticket.id, attentionId: ticket.attentions[0]!.id, expectedRevision: ticket.revision,
  })).rejects.toMatchObject({ code: 'workstreamPanel/denied' })
  expect(current(ctx, ticket)).toEqual(ticket)
})

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'workstream-review': { readonly kind: 'workstream-review' }
  }
}

it('child-only Remote permission does not authorize a mutation of the root Session Ticket log', async () => {
  const { ctx, owner } = await setup()
  const member = await ctx.workstreams.addMember(owner, owner.id, {
    operationId: WorkstreamOperationId('child'), name: 'child', description: 'worker',
    provider: 'spawn', prompt: 'Work', signal: new AbortController().signal,
  })
  const created = await ticketActor(ctx, owner.id, () =>
    ctx.tickets.create(owner.session, { subject: 'Child question', description: '', coordinatorId: member.id }))
  const asked = await ticketActor(ctx, member.id, () =>
    ctx.tickets.ask(owner.session, { ticketId: created.id, expectedRevision: created.revision,
      actorId: member.id, question: 'Ready?' }))
  const principal = { kind: 'workstream-review' } as const
  ctx.remoteAccess.registerPolicy('workstream-review', { bindings: () => [{
    role: { name: 'review:child-only', resource: 'session', actions: ['workstreamPanel/closeQuestion'] },
    resource: { kind: 'session', id: member.id },
  }] })
  expect(ctx.remoteAccess.decide({ principal, action: 'workstreamPanel/closeQuestion',
    resources: [{ kind: 'session', id: owner.id }] })).toMatchObject({ kind: 'deny' })
  const peer = new Peer(ctx, { principal })
  const operation = ctx.typertGateway.invoke({ peer, namespace: 'workstreamPanel', method: 'closeQuestion', args: {
    agentId: member.id, request: { ticketId: asked.id, questionId: asked.questions[0]!.id, expectedRevision: asked.revision },
  } })
  // Inspect both the returned outcome and the real owning Session's resulting state.
  const outcome = await operation.then(() => 'allowed', () => 'denied')
  expect({ outcome, questionStatus: current(ctx, asked).questions[0]?.status }).toEqual({
    outcome: 'denied', questionStatus: 'open',
  })
})

it.each(['answerQuestion', 'closeQuestion', 'acknowledgeAttention', 'resolveAttention'] as const)(
  '%s requires both child and root grants before appending to the root', async (method) => {
    const { ctx, owner } = await setup()
    const member = await ctx.workstreams.addMember(owner, owner.id, {
      operationId: WorkstreamOperationId('child'), name: 'child', description: 'worker',
      provider: 'spawn', prompt: 'Work', signal: new AbortController().signal,
    })
    const created = await ticketActor(ctx, owner.id, () =>
      ctx.tickets.create(owner.session, { subject: 'Child task', description: '', coordinatorId: member.id }))
    const asked = await ticketActor(ctx, member.id, () =>
      ctx.tickets.ask(owner.session, { ticketId: created.id, expectedRevision: created.revision,
        actorId: member.id, question: 'Ready?' }))
    const before = await ticketActor(ctx, member.id, () =>
      ctx.tickets.attention(owner.session, { ticketId: asked.id, expectedRevision: asked.revision,
        actorId: member.id, kind: 'decision', message: 'Approve' }))
    let rootGranted = false
    ctx.remoteAccess.registerPolicy('workstream-review', { bindings: () => (rootGranted ? [member.id, owner.id] : [member.id]).map(id => ({
      role: { name: 'review:commands', resource: 'session', actions: [`workstreamPanel/${method}`] },
      resource: { kind: 'session', id },
    })) })
    const peer = new Peer(ctx, { principal: { kind: 'workstream-review' } })
    const invoke = () => ctx.typertGateway.invoke({ peer, namespace: 'workstreamPanel', method, args: {
      agentId: member.id, request: { ticketId: before.id, questionId: before.questions[0]!.id,
        attentionId: before.attentions[0]!.id, expectedRevision: before.revision, answer: 'main' },
    } })
    await expect(invoke()).rejects.toMatchObject({ code: 'workstreamPanel/denied' })
    expect(current(ctx, before)).toEqual(before)
    rootGranted = true
    await invoke()
    expect(current(ctx, before).revision).toBe(before.revision + 1)
  },
)

it('Changes checks every active member grant before reading the aggregate', async () => {
  const { ctx, owner } = await setup()
  const member = await ctx.workstreams.addMember(owner, owner.id, {
    operationId: WorkstreamOperationId('child'), name: 'child', description: 'worker',
    provider: 'spawn', prompt: 'Work', signal: new AbortController().signal,
  })
  let childGranted = false
  ctx.remoteAccess.registerPolicy('workstream-review', { bindings: () => (childGranted ? [owner.id, member.id] : [owner.id]).map(id => ({
    role: { name: 'review:changes', resource: 'session', actions: ['workstreamPanel/changeRequests'] },
    resource: { kind: 'session', id },
  })) })
  const aggregate = vi.spyOn(ctx.workstreamEvidence, 'aggregateChangeRequests')
  const peer = new Peer(ctx, { principal: { kind: 'workstream-review' } })
  const invoke = () => ctx.typertGateway.invoke({ peer, namespace: 'workstreamPanel', method: 'changeRequests', args: { agentId: owner.id } })
  await expect(invoke()).rejects.toMatchObject({ code: 'workstreamPanel/denied' })
  expect(aggregate).not.toHaveBeenCalled()
  childGranted = true
  await invoke()
  expect(aggregate).toHaveBeenCalledOnce()
})

it('Changes checks a stopped member grant because the aggregate still reads its Session', async () => {
  const { ctx, owner } = await setup()
  const member = await ctx.workstreams.addMember(owner, owner.id, {
    operationId: WorkstreamOperationId('child'), name: 'child', description: 'worker',
    provider: 'spawn', prompt: 'Work', signal: new AbortController().signal,
  })
  await ctx.workstreams.stop(owner, owner.id, member.id)
  ctx.remoteAccess.registerPolicy('workstream-review', { bindings: () => [{
    role: { name: 'review:changes', resource: 'session', actions: ['workstreamPanel/changeRequests'] },
    resource: { kind: 'session', id: owner.id },
  }] })
  const aggregate = vi.spyOn(ctx.workstreamEvidence, 'aggregateChangeRequests')
  const peer = new Peer(ctx, { principal: { kind: 'workstream-review' } })
  await expect(ctx.typertGateway.invoke({ peer, namespace: 'workstreamPanel', method: 'changeRequests', args: { agentId: owner.id } }))
    .rejects.toMatchObject({ code: 'workstreamPanel/denied' })
  expect(aggregate).not.toHaveBeenCalled()
})
