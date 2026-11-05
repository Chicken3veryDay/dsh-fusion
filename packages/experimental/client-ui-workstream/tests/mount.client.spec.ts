/** The browser plugin sends commands as the displayed Session, rereads projections after a CAS conflict, and leaves with its fiber. */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkstreamActionInjected, WorkstreamCommand } from '../src/client/WorkstreamAction.tsx'
import { WorkstreamAction } from '../src/client/WorkstreamAction.tsx'
import { failureOf, inject, mountWorkstreamPanel } from '../src/client/mount.ts'
import { build, REVIEWER, ROOT, WORKER } from './fixtures.ts'

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-client-ui-workstream', descriptors: [] }
const ok: RemoteResult<void> = { ok: true, value: undefined }

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
  const refreshProjections = vi.fn(async (_id: SessionId) => {})
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
    name: 'root', children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  const dispose = await mountWorkstreamPanel(ctx, contribution)
  const entry = () => ctx.slots.entries('conversation.session.header.actions').find(candidate => candidate.component === WorkstreamAction)
  const actions = () => entry()!.inject!() as unknown as WorkstreamActionInjected
  return { ctx, panel, refreshProjections, navigation, dispose, unmount, entry, actions }
}

describe('Workstream panel browser plugin', () => {
  it('registers the localized header action and withdraws it before the Remote', async () => {
    const b = await bench()
    expect(inject).toEqual(['remote', 'sessions', 'uiWorkspace', 'slots', 'locale'])
    expect(b.entry()).toMatchObject({ options: { id: 'workstream', order: -19 }, locale: 'workstream' })
    const t = b.ctx.locale.bind('workstream')
    expect(t('tab.needs')).toBe('Needs you')
    await b.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.unmount).toHaveBeenCalledOnce()
    expect(t('tab.needs')).toBe('tab.needs')
  })

  it.each([
    [{ kind: 'answer', request: { ticketId: build.id, questionId: 'q1', expectedRevision: 4, answer: 'main' } }, 'answerQuestion'],
    [{ kind: 'closeQuestion', request: { ticketId: build.id, questionId: 'q1', expectedRevision: 4 } }, 'closeQuestion'],
    [{ kind: 'acknowledge', request: { ticketId: build.id, attentionId: 'n1', expectedRevision: 4 } }, 'acknowledgeAttention'],
    [{ kind: 'resolve', request: { ticketId: build.id, attentionId: 'n1', expectedRevision: 4 } }, 'resolveAttention'],
  ] as [WorkstreamCommand, 'answerQuestion'][])('sends %o as the displayed Session only', async (command, method) => {
    const b = await bench({ addressed: true })
    expect(await b.actions().command(WORKER, command)).toBeNull()
    expect(b.panel[method]).toHaveBeenCalledExactlyOnceWith(WORKER, command.request)
    expect(b.refreshProjections).not.toHaveBeenCalled()
  })

  it('rereads the Workstream root projections before reporting a CAS conflict', async () => {
    const b = await bench({ addressed: true })
    let refreshed = false
    b.refreshProjections.mockImplementationOnce(async () => { refreshed = true })
    b.panel.answerQuestion.mockResolvedValueOnce({ ok: false, error: new RemoteError('workstreamPanel/stale-revision', 'Ticket "build" is at revision 5, expected 4', {}) })
    const failure = await b.actions().command(WORKER, {
      kind: 'answer', request: { ticketId: build.id, questionId: 'q1' as never, expectedRevision: 4, answer: 'main' },
    })
    expect(refreshed).toBe(true)
    expect(b.refreshProjections).toHaveBeenCalledExactlyOnceWith(ROOT)
    expect(failure).toEqual({ code: 'stale', message: 'Ticket "build" is at revision 5, expected 4' })
  })

  it('reports other refusals without rereading', async () => {
    const b = await bench()
    b.panel.resolveAttention.mockResolvedValueOnce({ ok: false, error: new RemoteError('workstreamPanel/denied', 'only the current coordinator', {}) })
    expect(await b.actions().command(ROOT, {
      kind: 'resolve', request: { ticketId: build.id, attentionId: 'n1' as never, expectedRevision: 4 },
    })).toEqual({ code: 'denied', message: 'only the current coordinator' })
    expect(b.refreshProjections).not.toHaveBeenCalled()
  })

  it('reads change requests for the displayed Session and types a failure', async () => {
    const b = await bench()
    expect(await b.actions().changeRequests(ROOT)).toEqual({ ok: true, value: { complete: true, changeRequests: [], diagnostics: [] } })
    b.panel.changeRequests.mockResolvedValueOnce({ ok: false, error: new RemoteError('workstreamPanel/unavailable', 'owner not live', {}) } as never)
    expect(await b.actions().changeRequests(ROOT)).toEqual({ ok: false, failure: { code: 'unavailable', message: 'owner not live' } })
    expect(b.panel.changeRequests).toHaveBeenCalledWith(ROOT)
  })

  it.each([
    ['workstreamPanel/stale-revision', 'stale'],
    ['workstreamPanel/denied', 'denied'],
    ['workstreamPanel/unavailable', 'unavailable'],
    ['workstreamPanel/rejected', 'rejected'],
    ['gateway/internal', 'failed'],
  ] as const)('classifies %s as %s', (code, kind) => {
    expect(failureOf({ code, message: 'm' })).toEqual({ code: kind, message: 'm' })
  })

  it('opens members through the Workstream root and only from the main view', async () => {
    const b = await bench({ addressed: true })
    b.actions().openMember(WORKER, REVIEWER)
    b.actions().openMember(WORKER, ROOT)
    b.actions().openMember(ROOT, WORKER)
    expect(b.navigation).toEqual([
      { parentSessionId: ROOT, childSessionId: REVIEWER, mode: 'continuable' },
      ROOT,
      { parentSessionId: ROOT, childSessionId: WORKER, mode: 'continuable' },
    ])
    const hidden = await bench({ mainView: false })
    hidden.actions().openMember(ROOT, WORKER)
    expect(hidden.navigation).toEqual([])
  })

  it('withdraws the Remote when the UI cannot start', async () => {
    const ctx = new Context()
    const unmount = vi.fn(async () => {})
    class TestRemote extends Service {
      constructor() { super(ctx, 'remote') }
      async $mount() { return unmount }
    }
    new TestRemote()
    ctx.provide('remote.workstreamPanel', {} as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('uiWorkspace', {} as never)
    ctx.provide('slots', {} as never)
    ctx.provide('locale', { register: () => { throw new Error('locale unavailable') } } as never)
    await expect(mountWorkstreamPanel(ctx, contribution)).rejects.toThrow('locale unavailable')
    expect(unmount).toHaveBeenCalledOnce()
  })
})
