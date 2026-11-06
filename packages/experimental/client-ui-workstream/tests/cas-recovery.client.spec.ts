/** Conflict recovery through the mounted panel and real SessionManager projection cache. */
import { SessionManager } from '../../../api/session-controller/src/client/sessions/manager.ts'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkstreamActionInjected } from '../src/client/WorkstreamAction.tsx'
import { WorkstreamAction } from '../src/client/WorkstreamAction.tsx'
import { mountWorkstreamPanel } from '../src/client/mount.ts'
import { build, ROOT, WORKER } from './fixtures.client.ts'

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-client-ui-workstream', descriptors: [] }
const ok: RemoteResult<void> = { ok: true, value: undefined }

function assertActions(value: Record<string, unknown>): asserts value is Record<string, unknown> & WorkstreamActionInjected {
  for (const key of ['openMember', 'command', 'changeRequests', 'reportFailure']) {
    if (typeof value[key] !== 'function') throw new Error(`Workstream header action lacks ${key}`)
  }
}

async function bench(options: { addressed?: boolean; mainView?: boolean } = {}) {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class TestRemote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(value: TypertRemoteContribution) { expect(value).toBe(contribution); return unmount }
  }
  new TestRemote()
  const panel = {
    answerQuestion: vi.fn(async (): Promise<RemoteResult<void>> => ok),
    closeQuestion: vi.fn(async (): Promise<RemoteResult<void>> => ok),
    acknowledgeAttention: vi.fn(async (): Promise<RemoteResult<void>> => ok),
    resolveAttention: vi.fn(async (): Promise<RemoteResult<void>> => ok),
    changeRequests: vi.fn(async () => ({ ok: true, value: { complete: true, changeRequests: [], diagnostics: [] } })),
  }
  ctx.provide('remote.workstreamPanel', panel as never)
  const refreshProjections = vi.fn(async (_id: SessionId, _force?: boolean) => {})
  const navigation: unknown[] = []
  ctx.provide('sessions', {
    binding: (id: SessionId) => options.addressed === true && id === WORKER
      ? { session: { getSnapshot: () => ({ subagent: { address: { parentSessionId: ROOT, childSessionId: WORKER, mode: 'continuable' } } }) } }
      : undefined,
    refreshProjections,
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: options.mainView === false ? {} : { mainView: 1 } }) }),
  } as never)
  ctx.provide('uiWorkspace', { openSession: (target: unknown) => { navigation.push(target) } } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({
    name: 'root', children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const dispose = await mountWorkstreamPanel(ctx, contribution)
  const entry = () => ctx.slots.entries('conversation.session.header.actions').find(candidate => candidate.component === WorkstreamAction)
  const actions = (): WorkstreamActionInjected => {
    const injected = entry()!.inject!()
    assertActions(injected)
    return injected
  }
  return { ctx, panel, refreshProjections, navigation, dispose, unmount, entry, actions }
}


const reviewContexts: Context[] = []
afterEach(async () => { for (const ctx of reviewContexts.splice(0)) await ctx.fiber.dispose() })

it('a CAS conflict refreshes a previously loaded root to its current Ticket revision', async () => {
  let hostRevision = 4
  const projections = vi.fn(async () => ({ ok: true, value: {
    kind: 'sequenced', asOfSeq: hostRevision,
    values: { ticket: { tickets: [{ ...build, revision: hostRevision }] } },
  } }))
  const manager = new SessionManager({ session: { projections } } as never)
  try {
    await manager.refreshProjections(ROOT)
    expect(manager.projectionValues(ROOT)?.ticket?.tickets[0]?.revision).toBe(4)
    const b = await bench()
    reviewContexts.push(b.ctx)
    b.refreshProjections.mockImplementation((id, force) => manager.refreshProjections(id, force))
    hostRevision = 5
    b.panel.answerQuestion.mockResolvedValueOnce({ ok: false, error: new RemoteError(
      'workstreamPanel/stale-revision', 'revision 5, expected 4', {},
    ) })
    const failure = await b.actions().command(ROOT, { kind: 'answer', request: {
      ticketId: build.id, questionId: 'q1' as never, expectedRevision: 4, answer: 'main',
    } })
    expect(failure?.code).toBe('stale')
    expect(manager.projectionValues(ROOT)?.ticket?.tickets[0]?.revision,
      `conflict recovery must reread the Host; projection RPC count=${projections.mock.calls.length}`).toBe(5)
  } finally { await manager.dispose() }
})

it('reports a failed conflict reread without claiming that the latest state is displayed', async () => {
  const b = await bench()
  reviewContexts.push(b.ctx)
  b.refreshProjections.mockRejectedValueOnce(new Error('projection read offline'))
  b.panel.answerQuestion.mockResolvedValueOnce({ ok: false, error: new RemoteError('workstreamPanel/stale-revision', 'changed', {}) })
  expect(await b.actions().command(ROOT, { kind: 'answer', request: {
    ticketId: build.id, questionId: 'q1' as never, expectedRevision: 4, answer: 'draft',
  } })).toEqual({ code: 'refresh-failed', message: 'Error: projection read offline' })
})

it('captures the root before a pending command loses its displayed child binding', async () => {
  const options = { addressed: true }
  const b = await bench(options)
  reviewContexts.push(b.ctx)
  const response = Promise.withResolvers<RemoteResult<void>>()
  b.panel.answerQuestion.mockReturnValueOnce(response.promise)
  const pending = b.actions().command(WORKER, { kind: 'answer', request: {
    ticketId: build.id, questionId: 'q1' as never, expectedRevision: 4, answer: 'draft',
  } })
  options.addressed = false
  response.resolve({ ok: false, error: new RemoteError('workstreamPanel/stale-revision', 'changed', {}) })
  await pending
  expect(b.refreshProjections).toHaveBeenCalledExactlyOnceWith(ROOT, true)
})
