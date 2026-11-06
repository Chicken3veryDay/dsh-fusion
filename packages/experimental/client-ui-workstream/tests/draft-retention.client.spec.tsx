// @vitest-environment jsdom
// Answer text the user typed must survive panel lifecycle, card removal, and report handling (round-2 review findings 1, 2, 6).

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

function bench() {
  const sessions = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready',
    projectionsBySession: { [ROOT]: { state: 'ready', error: null, values: { workstream, ticket: tickets, workstreamEvidence: evidence } } },
  })
  const session = createSnapshotStore<SessionSnapshot>({
    sessionId: ROOT, pendingSubmissions: [], running: false, subagent: null,
    removed: false, openState: 'open', openError: null, hasMore: false, loadingOlder: false, promptError: null,
    blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
  })
  const changes: AggregatedChangeRequestsResult = { complete: true, changeRequests: [], diagnostics: [], gaps: [] }
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
    sessionId: ROOT,
    useSession: bindSnapshotSelector(session),
    useProjection: ((key: string, select?: (value: unknown) => unknown) => {
      const value = useSessions(state => state.projectionsBySession[ROOT]?.values[key as keyof Values])
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
  const view = render(<><WorkstreamAction {...props} /><CommandNotice reports={reports} t={props.t} /></>)
  return { props, injected, setValues, reports, view }
}

function openPanel(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Workstream' }))
  return screen.getByRole('dialog', { name: 'Release 2.0' })
}

function answerBox(dialog: HTMLElement): HTMLTextAreaElement {
  return within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'Answer' })
}

const DRAFT = 'Use release/2.0, rebased on the hotfix branch after the CI fix lands'

it('D1: Escape that cancels an IME composition in the answer box keeps the panel and its draft', () => {
  bench()
  const dialog = openPanel()
  const box = answerBox(dialog)
  fireEvent.change(box, { target: { value: DRAFT } })
  fireEvent.compositionStart(box)
  // Chromium and WebKit deliver the composition-cancelling Escape with isComposing (and keyCode 229 on older engines).
  fireEvent.keyDown(box, { key: 'Escape', isComposing: true, keyCode: 229 })
  expect(screen.queryByRole('dialog', { name: 'Release 2.0' }),
    'an Escape consumed by the IME must not dismiss the panel').not.toBeNull()
  expect(answerBox(screen.getByRole('dialog', { name: 'Release 2.0' })).value).toBe(DRAFT)
})

it('D2: an unsent answer survives switching tabs inside the panel', () => {
  bench()
  const dialog = openPanel()
  fireEvent.change(answerBox(dialog), { target: { value: DRAFT } })
  fireEvent.click(within(dialog).getByRole('tab', { name: /^Work/u }))
  fireEvent.click(within(dialog).getByRole('tab', { name: /^Needs you/u }))
  expect(answerBox(dialog).value, 'switching tabs must not discard the typed answer').toBe(DRAFT)
})

it('D3: an unsent answer survives an outside click that dismisses the panel', () => {
  bench()
  const dialog = openPanel()
  fireEvent.change(answerBox(dialog), { target: { value: DRAFT } })
  // The user clicks the conversation, for example to copy a branch name into the answer.
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('dialog')).toBeNull()
  const reopened = openPanel()
  expect(answerBox(reopened).value, 'dismissing the popover must not discard the typed answer').toBe(DRAFT)
})

/** Answer fails stale after another actor answered the question, so no surviving input holds the draft. */
async function rejectedAfterRemoval(b: ReturnType<typeof bench>): Promise<HTMLElement> {
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  b.injected.command.mockReturnValueOnce(response.promise)
  const dialog = openPanel()
  fireEvent.change(answerBox(dialog), { target: { value: DRAFT } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send answer' }))
  b.setValues({ workstream, ticket: { tickets: [{ ...build, revision: 5,
    questions: build.questions.map(q => ({ ...q, status: 'answered' as const, answer: 'main' })),
  }] }, workstreamEvidence: evidence })
  await act(async () => { response.resolve({ code: 'stale', message: 'revision 5, expected 4' }) })
  expect(document.body.textContent).toContain(DRAFT)
  return dialog
}

it('D4: the rejected answer text is not discarded by the next command sent from another card', async () => {
  const b = bench()
  const dialog = await rejectedAfterRemoval(b)
  // The user reacts to a different Needs-you item before copying the text out of the banner.
  const attention = dialog.querySelector('[data-attention="n1"]') as HTMLElement
  await act(async () => { fireEvent.click(within(attention).getByRole('button', { name: 'Acknowledge' })) })
  expect(document.body.textContent, 'the only remaining copy of the rejected answer must survive an unrelated command').toContain(DRAFT)
})

it('D5: the rejected answer text outlives the transient banner timeout', async () => {
  const b = bench()
  await rejectedAfterRemoval(b)
  await act(async () => { vi.advanceTimersByTime(4_001) })
  expect(document.body.textContent, 'the only remaining copy of the rejected answer must remain recoverable').toContain(DRAFT)
})

it('an answer typed while another actor answers the question stays in a retained row', () => {
  const b = bench()
  const dialog = openPanel()
  fireEvent.change(answerBox(dialog), { target: { value: DRAFT } })
  b.setValues({ workstream, ticket: { tickets: [{ ...build, revision: 5,
    questions: build.questions.map(q => ({ ...q, status: 'answered' as const, answer: 'main' })),
  }] }, workstreamEvidence: evidence })
  const retained = dialog.querySelector('[data-retained-draft]') as HTMLElement
  expect(within(retained).getByRole<HTMLTextAreaElement>('textbox', { name: 'Unsent answer text' }).value).toBe(DRAFT)
  expect(retained.textContent).toContain('Which branch?')
  expect(screen.getByRole('button', { name: 'Workstream' }).textContent, 'the retained answer counts as waiting for the user').toBe('Workstream3')
})

it('a retained answer is restored into its card when the question can be answered again', async () => {
  const b = bench()
  await rejectedAfterRemoval(b)
  const dialog = screen.getByRole('dialog', { name: 'Release 2.0' })
  expect(dialog.querySelector('[data-retained-draft]')).not.toBeNull()
  b.setValues({ workstream, ticket: tickets, workstreamEvidence: evidence })
  expect(dialog.querySelector('[data-retained-draft]')).toBeNull()
  expect(answerBox(dialog).value).toBe(DRAFT)
})

it('Copy writes the retained answer to the clipboard and Discard removes it', async () => {
  const b = bench()
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  try {
    const dialog = await rejectedAfterRemoval(b)
    const retained = dialog.querySelector('[data-retained-draft]') as HTMLElement
    await act(async () => { fireEvent.click(within(retained).getByRole('button', { name: 'Copy answer' })) })
    expect(writeText).toHaveBeenCalledExactlyOnceWith(DRAFT)
    fireEvent.click(within(retained).getByRole('button', { name: 'Discard' }))
    expect(dialog.querySelector('[data-retained-draft]')).toBeNull()
    expect(document.body.textContent).not.toContain(DRAFT)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('a refused clipboard leaves the retained answer selected for a manual copy', async () => {
  const b = bench()
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
  try {
    const dialog = await rejectedAfterRemoval(b)
    const box = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'Unsent answer text' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Copy answer' })) })
    expect(document.activeElement).toBe(box)
    expect(box.value.slice(box.selectionStart, box.selectionEnd)).toBe(DRAFT)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('an answer in flight is neither a retained row nor lost when its card disappears', async () => {
  const b = bench()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  b.injected.command.mockReturnValueOnce(response.promise)
  const dialog = openPanel()
  fireEvent.change(answerBox(dialog), { target: { value: DRAFT } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send answer' }))
  b.setValues({ workstream, ticket: { tickets: [{ ...build, revision: 5,
    questions: build.questions.map(q => ({ ...q, status: 'answered' as const, answer: 'main' })),
  }] }, workstreamEvidence: evidence })
  expect(dialog.querySelector('[data-retained-draft]'), 'the send has no outcome yet').toBeNull()
  await act(async () => { response.resolve({ code: 'stale', message: 'revision 5, expected 4' }) })
  expect(dialog.querySelector('[data-retained-draft]')).not.toBeNull()
})

it('a committed answer leaves no draft behind', async () => {
  const b = bench()
  const dialog = openPanel()
  fireEvent.change(answerBox(dialog), { target: { value: DRAFT } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Send answer' })) })
  b.setValues({ workstream, ticket: { tickets: [{ ...build, revision: 5,
    questions: build.questions.map(q => ({ ...q, status: 'answered' as const, answer: DRAFT })),
  }] }, workstreamEvidence: evidence })
  expect(b.injected.drafts.getSnapshot().size).toBe(0)
  expect(dialog.querySelector('[data-retained-draft]')).toBeNull()
})

it('drafts are not reported orphaned while the Ticket projection has not loaded', () => {
  const b = bench()
  const dialog = openPanel()
  fireEvent.change(answerBox(dialog), { target: { value: DRAFT } })
  b.setValues({ workstream, workstreamEvidence: evidence })
  expect(dialog.querySelector('[data-retained-draft]')).toBeNull()
  b.setValues({ workstream, ticket: tickets, workstreamEvidence: evidence })
  expect(answerBox(dialog).value).toBe(DRAFT)
})

it('a command clears only its own earlier report', async () => {
  const b = bench()
  const dialog = openPanel()
  const attention = dialog.querySelector('[data-attention="n1"]') as HTMLElement
  const other = dialog.querySelector('[data-attention="n2"]') as HTMLElement
  b.injected.command.mockResolvedValueOnce({ code: 'rejected', message: 'first' })
  await act(async () => { fireEvent.click(within(attention).getByRole('button', { name: 'Resolve' })) })
  expect(screen.getByRole('alert').textContent).toContain('first')
  // Another card's command leaves the report of the first one in place.
  await act(async () => { fireEvent.click(within(other).getByRole('button', { name: 'Resolve' })) })
  expect(screen.getByRole('alert').textContent).toContain('first')
  // Repeating the failed command supersedes its own report.
  const pending = Promise.withResolvers<WorkstreamFailure | null>()
  b.injected.command.mockReturnValueOnce(pending.promise)
  fireEvent.click(within(attention).getByRole('button', { name: 'Resolve' }))
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { pending.resolve(null) })
})

it('the failure banner no longer carries the answer text', async () => {
  const b = bench()
  await rejectedAfterRemoval(b)
  expect(screen.getByRole('alert').textContent).toBe(en['error.stale'])
})
