// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { TicketStatus } from '@deepseek-ai/dsh-experimental-ticket/client'
import type { AggregatedChangeRequestsResult } from '@deepseek-ai/dsh-experimental-workstream-evidence/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  WorkstreamAction, type ChangeRequestsRead, type WorkstreamActionInjected, type WorkstreamActionProps, type WorkstreamFailure,
} from '../src/client/WorkstreamAction.tsx'
import { en } from '../src/client/locales.ts'
import { build, docs, evidence, REVIEWER, ROOT, ticket, tickets, WORKER, workstream } from './fixtures.ts'

afterEach(() => {
  cleanup()
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
  const injected = {
    openMember: vi.fn<WorkstreamActionInjected['openMember']>(),
    command: vi.fn<WorkstreamActionInjected['command']>(async () => null),
    changeRequests: vi.fn<WorkstreamActionInjected['changeRequests']>(async () => ({ ok: true, value: changes })),
  }
  const props = {
    sessionId,
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(sessions),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map())),
    ...injected,
    t: makeTranslate(en, commonEn),
  } as unknown as WorkstreamActionProps
  const setValues = (values: Values): void => {
    act(() => {
      const current = sessions.getSnapshot()
      sessions.set({ ...current, projectionsBySession: { ...current.projectionsBySession, [ROOT]: { state: 'ready', error: null, values } } })
    })
  }
  return { props, injected, setValues }
}

function panel(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Workstream' }))
  return screen.getByRole('dialog', { name: 'Release 2.0' })
}

function tab(name: RegExp): void {
  fireEvent.click(screen.getByRole('tab', { name }))
}

describe('WorkstreamAction', () => {
  it('stays absent until the root projects a Workstream', () => {
    const b = bench({ values: { workstream: null } })
    render(<WorkstreamAction {...b.props} />)
    expect(screen.queryByRole('button', { name: 'Workstream' })).toBeNull()
    b.setValues({ workstream })
    expect(screen.getByRole('button', { name: 'Workstream' })).toBeTruthy()
  })

  it('lists open questions and unresolved attention of nonterminal Tickets, oldest first, with a pending badge', () => {
    const b = bench()
    render(<WorkstreamAction {...b.props} />)
    expect(screen.getByRole('button', { name: 'Workstream' }).textContent).toBe('Workstream3')
    const dialog = panel()
    const cards = within(dialog).getAllByRole('article')
    expect(cards.map(card => card.querySelector('strong')?.textContent)).toEqual([
      'Decision needed', 'Question from builder', 'Blocked',
    ])
    expect(within(dialog).getByText('Which branch?')).toBeTruthy()
    expect(within(dialog).queryByText('Old question')).toBeNull()
    expect(within(dialog).queryByText('Done already')).toBeNull()
    expect(within(dialog).queryByText('Ended ticket item')).toBeNull()
    expect(within(cards[2]!).getByText('Acknowledged')).toBeTruthy()
    expect(within(cards[2]!).queryByRole('button', { name: 'Acknowledge' })).toBeNull()
    expect(within(dialog).getAllByText('Ticket: Build artifacts')).toHaveLength(3)
  })

  it.each([['question', 'Question raised'], ['review', 'Review requested']] as const)('labels a %s attention item', (kind, label) => {
    const b = bench({ values: { workstream, ticket: { tickets: [ticket('t', {
      attentions: [{ id: 'n' as never, kind, message: 'Clarify scope', status: 'open', createdAt: 0 }],
    })] } } })
    render(<WorkstreamAction {...b.props} />)
    expect(within(panel()).getByRole('article').querySelector('strong')?.textContent).toBe(label)
  })

  it('shows the empty Needs you copy when nothing waits', () => {
    const b = bench({ values: { workstream, ticket: { tickets: [docs] } } })
    render(<WorkstreamAction {...b.props} />)
    expect(screen.getByRole('button', { name: 'Workstream' }).textContent).toBe('Workstream')
    expect(within(panel()).getByText(en['needs.empty'])).toBeTruthy()
  })

  it('answers a question with the displayed revision and clears the draft', async () => {
    const b = bench()
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    const send = within(dialog).getByRole('button', { name: 'Send answer' })
    expect(send).toHaveProperty('disabled', true)
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Answer' }), { target: { value: 'release/2.0' } })
    await act(async () => { fireEvent.click(send) })
    expect(b.injected.command).toHaveBeenCalledExactlyOnceWith(ROOT, {
      kind: 'answer', request: { ticketId: build.id, questionId: 'q1', expectedRevision: 4, answer: 'release/2.0' },
    })
    expect(within(dialog).getByRole('textbox', { name: 'Answer' })).toHaveProperty('value', '')
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('shows a CAS conflict inline and retries with the refreshed revision', async () => {
    const b = bench()
    let settle!: (failure: WorkstreamFailure | null) => void
    b.injected.command.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    const input = within(dialog).getByRole('textbox', { name: 'Answer' })
    fireEvent.change(input, { target: { value: 'main' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send answer' }))
    expect(within(dialog).getByRole('button', { name: 'Sending…' })).toHaveProperty('disabled', true)
    // The injected command rereads projections before reporting the conflict.
    b.setValues({ workstream, ticket: { tickets: [{ ...build, revision: 5 }, docs] }, workstreamEvidence: evidence })
    await act(async () => { settle({ code: 'stale', message: 'Ticket "build" is at revision 5, expected 4' }) })
    expect(within(dialog).getByRole('alert').textContent).toBe(en['error.stale'])
    expect(input).toHaveProperty('value', 'main')

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Send answer' })) })
    expect(b.injected.command).toHaveBeenLastCalledWith(ROOT, {
      kind: 'answer', request: { ticketId: build.id, questionId: 'q1', expectedRevision: 5, answer: 'main' },
    })
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it.each([
    [{ code: 'denied', message: 'only the current coordinator' }, en['error.denied']],
    [{ code: 'unavailable', message: 'owner not live' }, en['error.unavailable']],
    [{ code: 'rejected', message: 'question is already closed' }, 'The Ticket rejected this change: question is already closed'],
    [{ code: 'failed', message: 'socket closed' }, 'The request failed: socket closed'],
  ] satisfies [WorkstreamFailure, string][])('closes a question and shows %o inline', async (failure, text) => {
    const b = bench()
    b.injected.command.mockResolvedValueOnce(failure)
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Close question' })) })
    expect(b.injected.command).toHaveBeenCalledWith(ROOT, {
      kind: 'closeQuestion', request: { ticketId: build.id, questionId: 'q1', expectedRevision: 4 },
    })
    expect(within(dialog).getByRole('alert').textContent).toBe(text)
  })

  it('acknowledges and resolves attention, reporting a thrown command as a failure', async () => {
    const b = bench()
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    const decision = within(dialog).getAllByRole('article')[0]!
    let settle!: (failure: WorkstreamFailure | null) => void
    b.injected.command.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    fireEvent.click(within(decision).getByRole('button', { name: 'Acknowledge' }))
    expect(within(decision).getByRole('button', { name: 'Sending…' })).toHaveProperty('disabled', true)
    expect(within(decision).getByRole('button', { name: 'Acknowledge' })).toHaveProperty('disabled', true)
    await act(async () => { settle(null) })
    expect(b.injected.command).toHaveBeenLastCalledWith(ROOT, {
      kind: 'acknowledge', request: { ticketId: build.id, attentionId: 'n1', expectedRevision: 4 },
    })
    b.injected.command.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { fireEvent.click(within(decision).getByRole('button', { name: 'Resolve' })) })
    expect(b.injected.command).toHaveBeenLastCalledWith(ROOT, {
      kind: 'resolve', request: { ticketId: build.id, attentionId: 'n1', expectedRevision: 4 },
    })
    expect(within(decision).getByRole('alert').textContent).toBe('The request failed: Error: offline')
  })

  it('renders Missions, Tickets, dependencies, and assignments in Work', () => {
    const b = bench()
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    tab(/^Work2$/u)
    const mission = within(dialog).getByText('Launch').closest('article')!
    expect([...mission.querySelectorAll('li')].map(row => row.textContent)).toEqual([
      'Beta1 of 2 done', 'GA1 of 1 done', 'Later0 of 0 done',
    ])
    const buildCard = dialog.querySelector('[data-ticket="build"]')!
    expect(buildCard.textContent).toContain('Executing')
    expect(buildCard.textContent).toContain('Coordinator: owner')
    expect(buildCard.textContent).toContain('Compile · builder · Worker · Running')
    const docsCard = dialog.querySelector('[data-ticket="docs"]')!
    expect(docsCard.textContent).toContain('Completed')
    expect(docsCard.textContent).toContain('Coordinator: builder')
    expect(docsCard.textContent).toContain('Depends on: Build artifacts, gone')
    expect(docsCard.textContent).toContain('No assignments')
  })

  it.each([
    ['proposed', 'idle'], ['ready', 'idle'], ['coordinating', 'ongoing'], ['executing', 'ongoing'], ['integrating', 'ongoing'],
    ['reviewing', 'ongoing'], ['waiting', 'warning'], ['blocked', 'warning'], ['completed', 'done'], ['failed', 'error'], ['cancelled', 'error'],
  ] satisfies [TicketStatus, string][])('labels a %s Ticket', (status, dot) => {
    const b = bench({ values: { workstream, ticket: { tickets: [ticket('t', { status })] } } })
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    tab(/^Work1$/u)
    const card = dialog.querySelector('[data-ticket="t"]')!
    expect(card.querySelector(`[data-state="${dot}"]`)).not.toBeNull()
    expect(card.textContent).toContain(en[`status.${status}`])
  })

  it('shows empty Work and Files copy and a persisted Ticket failure', () => {
    const b = bench({ values: { workstream, ticket: { tickets: [], failure: 'bad record' }, workstreamEvidence: null } })
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    expect(within(dialog).getByRole('alert').textContent).toBe('Invalid persisted Ticket record: bad record')
    tab(/^Work$/u)
    expect(within(dialog).getByText(en['work.empty'])).toBeTruthy()
    tab(/^Files$/u)
    expect(within(dialog).getByText(en['files.empty'])).toBeTruthy()
  })

  it('renders members with role and phase and opens continuable Sessions', () => {
    const b = bench({ sessionId: WORKER, parentSessionId: ROOT })
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    tab(/^Team5$/u)
    const owner = within(dialog).getByRole('button', { name: 'Open conversation: owner' })
    expect(owner.textContent).toContain('Owner · Coordinator · Active')
    const current = within(dialog).getByText('builder').closest('button')!
    expect(current).toHaveProperty('disabled', true)
    expect(current.textContent).toContain('Current chat')
    expect(current.textContent).toContain('Builds the release')
    expect(within(dialog).getByText('pending').closest('button')).toHaveProperty('disabled', true)
    expect(within(dialog).getByRole('button', { name: 'Open conversation: leaving' }).textContent).toContain('Member · Stopping')
    const reviewer = within(dialog).getByRole('button', { name: 'Open conversation: reviewer' })
    expect(reviewer.textContent).toContain('Stopped')
    expect(reviewer.textContent).toContain('exited with code 1')
    fireEvent.click(reviewer)
    expect(b.injected.openMember).toHaveBeenCalledWith(WORKER, REVIEWER)
    b.injected.openMember.mockImplementationOnce(() => { throw new Error('not retained') })
    fireEvent.click(owner)
    expect(within(dialog).getByRole('alert').textContent).toBe('The request failed: Error: not retained')
  })

  it('reads change requests on open and shows the incomplete notice and contributors', async () => {
    const b = bench()
    let settle!: (read: ChangeRequestsRead) => void
    b.injected.changeRequests.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    tab(/^Changes$/u)
    expect(within(dialog).getByRole('status').textContent).toBe(en['changes.loading'])
    const ref = { repository: { host: 'github.com', owner: 'org', name: 'repo' }, number: 1 } as never
    await act(async () => {
      settle({ ok: true, value: {
        complete: false,
        diagnostics: ['Session reviewer is not loaded; its change requests are not included'],
        changeRequests: [
          { url: 'https://example.test/pr/1', ref, contributions: [
            { sessionId: ROOT, origin: 'created', update: null },
            { sessionId: WORKER, origin: 'discovered', update: { key: 'k' as never, fetchedAt: 1, snapshot: { title: 'Add release notes', state: 'open', draft: true } as never } },
          ] },
          { url: 'https://example.test/pr/2', ref: null, contributions: [{ sessionId: WORKER, origin: 'created', update: null }] },
          { url: 'https://example.test/pr/3', ref, contributions: [
            { sessionId: WORKER, origin: 'created', update: { key: 'k' as never, fetchedAt: 1, failure: { code: 'network' } as never } },
          ] },
          { url: 'https://example.test/pr/4', ref, contributions: [
            { sessionId: 'gone' as SessionId, origin: 'created', update: { key: 'k' as never, fetchedAt: 1, snapshot: { title: 'Merged fix', state: 'merged', draft: false } as never } },
          ] },
        ],
      } })
    })
    expect(dialog.querySelector('[data-incomplete]')?.textContent)
      .toBe('This list may be incomplete: Session reviewer is not loaded; its change requests are not included')
    const first = dialog.querySelector('[data-change-request="https://example.test/pr/1"]')!
    expect(within(first as HTMLElement).getByRole('link', { name: 'Add release notes' }).getAttribute('href')).toBe('https://example.test/pr/1')
    expect(first.textContent).toContain('Draft')
    expect(first.textContent).toContain('Bound in: owner, builder')
    expect(dialog.querySelector('[data-change-request="https://example.test/pr/2"]')!.textContent).toContain('Status not read yet')
    expect(dialog.querySelector('[data-change-request="https://example.test/pr/3"]')!.textContent).toContain('Status not read yet')
    const merged = dialog.querySelector('[data-change-request="https://example.test/pr/4"]')!
    expect(merged.textContent).toContain('Merged')
    expect(merged.textContent).toContain('Bound in: gone')
    expect(b.injected.changeRequests).toHaveBeenCalledExactlyOnceWith(ROOT)
  })

  it('reloads change requests after a failure and shows the empty list', async () => {
    const b = bench()
    b.injected.changeRequests.mockResolvedValueOnce({ ok: false, failure: { code: 'unavailable', message: 'owner not live' } })
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    await act(async () => { tab(/^Changes$/u) })
    expect(within(dialog).getByRole('alert').textContent).toBe(en['error.unavailable'])
    expect(dialog.querySelector('[data-incomplete]')).toBeNull()
    b.injected.changeRequests.mockRejectedValueOnce(new Error('socket closed'))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' })) })
    expect(within(dialog).getByRole('alert').textContent).toBe('The request failed: Error: socket closed')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' })) })
    expect(within(dialog).getByText(en['changes.empty'])).toBeTruthy()
    expect(b.injected.changeRequests).toHaveBeenCalledTimes(3)
  })

  it('drops a change request read that settles after the view closed', async () => {
    const b = bench()
    let settle!: (read: ChangeRequestsRead) => void
    let fail!: (error: Error) => void
    b.injected.changeRequests
      .mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    tab(/^Changes$/u)
    tab(/^Files1$/u)
    tab(/^Changes$/u)
    tab(/^Files1$/u)
    await act(async () => {
      settle({ ok: true, value: { complete: true, changeRequests: [], diagnostics: [] } })
      fail(new Error('late'))
    })
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('lists evidence artifacts with every version newest first', () => {
    const b = bench()
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    tab(/^Files1$/u)
    const card = dialog.querySelector('[data-artifact="spec"]')!
    expect(card.querySelector('strong')?.textContent).toBe('spec-v2.md')
    expect(card.textContent).toContain('2 versions')
    expect([...card.querySelectorAll('li')].map(row => row.textContent)).toEqual([
      'Version 2Latest4.0KBBy builder222222222222',
      'Version 12.0KBBy owner111111111111',
    ])
    expect(card.querySelector('code')?.getAttribute('title')).toBe(`sha256:${'2'.repeat(64)}`)
  })

  it('falls back to the artifact id for an artifact without retained versions', () => {
    const b = bench({ values: { workstream, workstreamEvidence: { ...evidence, artifacts: [{ artifactId: 'empty' as never, latestVersion: 0, versions: [] }] } } })
    render(<WorkstreamAction {...b.props} />)
    const dialog = panel()
    tab(/^Files1$/u)
    expect(dialog.querySelector('[data-artifact="empty"] strong')?.textContent).toBe('empty')
  })

  it('closes on Escape, returning focus to the trigger, and resets when the Session changes', () => {
    const b = bench()
    const view = render(<WorkstreamAction {...b.props} />)
    const trigger = screen.getByRole('button', { name: 'Workstream' })
    const dialog = panel()
    tab(/^Files1$/u)
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
    within(dialog).getByRole('tab', { name: /^Files1$/u }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    panel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    panel()
    tab(/^Files1$/u)
    // A Session outside any Workstream root has no action.
    view.rerender(<WorkstreamAction {...b.props} sessionId={WORKER} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Workstream' })).toBeNull()
    view.rerender(<WorkstreamAction {...b.props} />)
    panel()
    expect(screen.getByRole('tab', { name: /^Needs you3$/u }).getAttribute('aria-selected')).toBe('true')
  })
})
