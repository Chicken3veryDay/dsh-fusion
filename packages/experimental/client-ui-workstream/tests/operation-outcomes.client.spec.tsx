// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState, SessionSnapshot, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { AggregatedChangeRequestsResult } from '@deepseek-ai/dsh-experimental-workstream-evidence/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  WorkstreamAction, type WorkstreamActionInjected, type WorkstreamActionProps, type WorkstreamFailure,
} from '../src/client/WorkstreamAction.tsx'
import { en } from '../src/client/locales.ts'
import { createAnswerDrafts } from '../src/client/drafts.ts'
import { CommandNotice, createCommandReports } from '../src/client/notices.tsx'
import { build, evidence, ROOT, tickets, workstream } from './fixtures.client.ts'

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Projections = SessionListState['projectionsBySession']
type Values = Projections[SessionId]['values']

function bench(options: { values?: Values; sessionId?: SessionId; parentSessionId?: SessionId } = {}) {
  const sessionId = options.sessionId ?? ROOT
  const sessions = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready',
    projectionsBySession: { [ROOT]: { state: 'ready', error: null, values: options.values ?? { workstream, ticket: tickets, workstreamEvidence: evidence } } },
  })
  const session = createSnapshotStore<SessionSnapshot>({
    sessionId, pendingSubmissions: [], running: false,
    subagent: options.parentSessionId === undefined
      ? null
      : { address: { parentSessionId: options.parentSessionId, childSessionId: sessionId, mode: 'continuable' } },
    removed: false, openState: 'open', openError: null, hasMore: false, loadingOlder: false, promptError: null,
    blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
  })
  const changes: AggregatedChangeRequestsResult = { complete: true, changeRequests: [], diagnostics: [] }
  const reports = createCommandReports()
  const injected = {
    reportFailure: reports.reportFailure,
    drafts: createAnswerDrafts(),
    openMember: vi.fn<WorkstreamActionInjected['openMember']>(),
    command: vi.fn<WorkstreamActionInjected['command']>(async () => null),
    changeRequests: vi.fn<WorkstreamActionInjected['changeRequests']>(async () => ({ ok: true, value: changes })),
  }
  const useSessions = bindSnapshotSelector(sessions)
  const props = {
    sessionId,
    useSession: bindSnapshotSelector(session),
    useProjection: ((key: string, select?: (value: unknown) => unknown) => {
      const value = useSessions(state => state.projectionsBySession[sessionId]?.values[key as keyof Values])
      return select === undefined ? value : select(value)
    }) as UseProjection,
    useSessions,
    useSessionStatus: bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map())),
    ...injected,
    t: makeTranslate(en, commonEn),
  } as WorkstreamActionProps
  const setValues = (values: Values): void => {
    act(() => {
      const current = sessions.getSnapshot()
      sessions.set({ ...current, projectionsBySession: { ...current.projectionsBySession, [ROOT]: { state: 'ready', error: null, values } } })
    })
  }
  return { props, injected, setValues, reports }
}

function panel(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Workstream' }))
  return screen.getByRole('dialog', { name: 'Release 2.0' })
}

function tab(name: RegExp): void {
  fireEvent.click(screen.getByRole('tab', { name }))
}


it('a conflict remains visible when refreshing removes the affected question', async () => {
  const b = bench()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  b.injected.command.mockReturnValueOnce(response.promise)
  render(<><WorkstreamAction {...b.props} /><CommandNotice reports={b.reports} t={b.props.t} /></>)
  const dialog = panel()
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Answer' }), { target: { value: 'release/2.0' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send answer' }))
  b.setValues({ workstream, ticket: { tickets: [{ ...build, revision: 5,
    questions: build.questions.map(q => ({ ...q, status: 'answered' as const, answer: 'main' })),
  }] }, workstreamEvidence: evidence })
  await act(async () => { response.resolve({ code: 'stale', message: 'revision 5, expected 4' }) })
  expect(screen.queryByRole('alert')?.textContent,
    'the CAS failure must survive removal of the question card').toBe(en['error.stale'])
  expect(within(screen.getByRole('dialog', { name: 'Release 2.0' })).getByRole('textbox', { name: 'Unsent answer text' }),
    'the rejected answer must stay selectable once its card is gone').toHaveProperty('value', 'release/2.0')
})

it('a failed reload retains the previously visible change requests', async () => {
  const b = bench()
  b.injected.changeRequests.mockResolvedValueOnce({ ok: true, value: {
    complete: true, diagnostics: [], changeRequests: [{
      url: 'https://example.test/pr/42', ref: null, contributions: [],
    }],
  } })
  render(<><WorkstreamAction {...b.props} /><CommandNotice reports={b.reports} t={b.props.t} /></>)
  const dialog = panel()
  await act(async () => { tab(/^Changes$/u) })
  expect(dialog.querySelector('[data-change-request]')).not.toBeNull()
  b.injected.changeRequests.mockResolvedValueOnce({ ok: false, failure: { code: 'failed', message: 'offline' } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' })) })
  expect(within(dialog).getByRole('alert').textContent).toContain('offline')
  expect(dialog.querySelector('[data-change-request]'), 'failed refresh must retain the known list').not.toBeNull()
})

it.each(['tab', 'panel', 'conversation'] as const)('a rejected answer remains reported after closing its %s', async (surface) => {
  const b = bench()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  b.injected.command.mockReturnValueOnce(response.promise)
  const tree = (showConversation: boolean) => <>
    {showConversation && <WorkstreamAction {...b.props} />}
    <CommandNotice reports={b.reports} t={b.props.t} />
  </>
  const view = render(tree(true))
  const dialog = panel()
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Answer' }), { target: { value: 'keep this draft' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send answer' }))
  switch (surface) {
    case 'tab': tab(/^Work/u); break
    case 'panel': fireEvent.keyDown(document, { key: 'Escape' }); break
    case 'conversation': view.rerender(tree(false)); break
  }
  await act(async () => { response.resolve({ code: 'stale', message: 'changed' }) })
  expect(screen.getByRole('alert').textContent).toBe(en['error.stale'])
  expect([...b.injected.drafts.getSnapshot().values()].map(draft => draft.text),
    'the draft outlives the closed surface').toEqual(['keep this draft'])
})

it('Changes retains its list while the reload is pending', async () => {
  const b = bench()
  const value: AggregatedChangeRequestsResult = { complete: true, diagnostics: [], changeRequests: [{
    url: 'https://example.test/pr/42', ref: null, contributions: [],
  }] }
  b.injected.changeRequests.mockResolvedValueOnce({ ok: true, value })
  render(<><WorkstreamAction {...b.props} /><CommandNotice reports={b.reports} t={b.props.t} /></>)
  const dialog = panel()
  await act(async () => { tab(/^Changes$/u) })
  const response = Promise.withResolvers<Awaited<ReturnType<WorkstreamActionInjected['changeRequests']>>>()
  b.injected.changeRequests.mockReturnValueOnce(response.promise)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }))
  expect(within(dialog).getByRole('link', { name: 'https://example.test/pr/42' })).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: 'Reload' })).toHaveProperty('disabled', true)
  await act(async () => { response.resolve({ ok: true, value }) })
  expect(within(dialog).getByRole('button', { name: 'Reload' })).toHaveProperty('disabled', false)
})
