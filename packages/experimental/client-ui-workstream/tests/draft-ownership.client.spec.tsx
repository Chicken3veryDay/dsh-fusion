// @vitest-environment jsdom
/** Draft ownership across card lifetimes and Workstream roots. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkstreamAction, type WorkstreamActionInjected, type WorkstreamActionProps, type WorkstreamFailure } from '../src/client/WorkstreamAction.tsx'
import { createAnswerDrafts, draftId } from '../src/client/drafts.ts'
import { en } from '../src/client/locales.ts'
import { CommandNotice, createCommandReports } from '../src/client/notices.tsx'
import { NeedsView } from '../src/client/views.tsx'
import { needsYou } from '../src/client/model.ts'
import { build, evidence, ROOT, tickets, workstream, WORKER } from './fixtures.client.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const FIRST = 'Use release/2.0'
const LATER = 'Use release/2.0 after the hotfix lands; keep the deployment paused'
const key = { rootId: ROOT, ticketId: build.id, questionId: build.questions[0]!.id }

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
  const reports = createCommandReports()
  const drafts = createAnswerDrafts()
  const command = vi.fn<WorkstreamActionInjected['command']>(async () => null)
  const props = {
    sessionId: ROOT, useSession: bindSnapshotSelector(session), useSessions: bindSnapshotSelector(sessions),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map())),
    command, drafts, reportFailure: reports.reportFailure, openMember: () => {},
    changeRequests: async () => ({ ok: true, value: { complete: true, changeRequests: [], diagnostics: [], gaps: [] } }),
    t: makeTranslate(en, commonEn),
  }
  // The component reads the shared Session list; the other runtime hooks are unused here.
  const fullProps = props as WorkstreamActionProps
  const tree = (id = ROOT) => <><WorkstreamAction {...fullProps} sessionId={id} /><CommandNotice reports={reports} t={props.t} /></>
  const view = render(tree())
  const box = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Answer' })
  const open = () => { fireEvent.click(screen.getByRole('button', { name: 'Workstream' })) }
  const edit = (text: string) => { fireEvent.change(box(), { target: { value: text } }) }
  const send = () => { fireEvent.click(screen.getByRole('button', { name: 'Send answer' })) }
  const remountCard = () => {
    fireEvent.click(screen.getByRole('tab', { name: /^Work/u }))
    fireEvent.click(screen.getByRole('tab', { name: /^Needs you/u }))
  }
  const removeQuestion = () => { act(() => {
    const current = sessions.getSnapshot()
    sessions.set({ ...current, projectionsBySession: { [ROOT]: { state: 'ready', error: null, values: {
      workstream, ticket: { tickets: [{ ...build, revision: 5, questions: build.questions.map(q => ({ ...q, status: 'answered', answer: FIRST })) }] },
    } } } })
  }) }
  return { props, view, tree, box, open, edit, send, remountCard, removeQuestion, drafts, command }
}

it('D1: a remounted answer card observes the pending send owned by its draft', async () => {
  const b = bench()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  b.command.mockReturnValueOnce(response.promise)
  b.open(); b.edit(FIRST); b.send(); b.remountCard()
  const disabled = b.box().disabled
  await act(async () => { response.resolve(null) })
  expect(disabled, 'switching tabs must not re-enable an answer whose send is still pending').toBe(true)
})

it('D2: an earlier successful send preserves later text accepted by a remounted card', async () => {
  const b = bench()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  b.command.mockReturnValueOnce(response.promise)
  b.open(); b.edit(FIRST); b.send(); b.remountCard()
  // A fix may lock editing for the full send. If editing remains available, the new text must survive.
  const acceptsEdit = !b.box().disabled
  if (acceptsEdit) b.edit(LATER)
  b.removeQuestion()
  await act(async () => { response.resolve(null) })
  expect(b.drafts.getSnapshot().get(draftId(key))?.text,
    'the completed request sent only the earlier text; it must not delete a later accepted edit').toBe(acceptsEdit ? LATER : undefined)
})

it('D3: switching conversations and returning cannot let an earlier success erase a newer draft', async () => {
  const b = bench()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  b.command.mockReturnValueOnce(response.promise)
  b.open(); b.edit(FIRST); b.send()
  b.view.rerender(b.tree(WORKER))
  b.view.rerender(b.tree(ROOT))
  b.open()
  const acceptsEdit = !b.box().disabled
  if (acceptsEdit) b.edit(LATER)
  await act(async () => { response.resolve(null) })
  expect(b.box().value, 'only the submitted answer may be cleared after returning to the conversation').toBe(acceptsEdit ? LATER : '')
})

it('D4: an earlier success cannot erase text accepted by a second card sharing the draft store', async () => {
  const drafts = createAnswerDrafts()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  const command = vi.fn<WorkstreamActionInjected['command']>(() => response.promise)
  const props = { sessionId: ROOT, rootId: ROOT, command, drafts, t: makeTranslate(en, commonEn), nameOf: (id: SessionId) => id,
    items: needsYou([build]), retained: [] }
  const one = render(<NeedsView {...props} />)
  const two = render(<NeedsView {...props} />)
  const first = within(one.container).getByRole<HTMLTextAreaElement>('textbox')
  fireEvent.change(first, { target: { value: FIRST } })
  fireEvent.click(within(one.container).getByRole('button', { name: 'Send answer' }))
  const second = within(two.container).getByRole<HTMLTextAreaElement>('textbox')
  const acceptsEdit = !second.disabled
  if (acceptsEdit) fireEvent.change(second, { target: { value: LATER } })
  await act(async () => { response.resolve(null) })
  expect(second.value, 'the other card accepted this text after the request was submitted').toBe(acceptsEdit ? LATER : '')
})

it('C1: a thrown send releases draft sending state and preserves its text after card removal', async () => {
  const b = bench()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  b.command.mockReturnValueOnce(response.promise)
  b.open(); b.edit(FIRST); b.send(); b.removeQuestion()
  await act(async () => { response.reject(new Error('disconnected')) })
  expect(b.drafts.getSnapshot().get(draftId(key))).toMatchObject({ text: FIRST, sending: false })
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Unsent answer text' }).value).toBe(FIRST)
  expect(screen.getByRole('alert').textContent).toContain('disconnected')
})

it('C2: identical Ticket and question ids in another root keep separate drafts', () => {
  const drafts = createAnswerDrafts()
  drafts.edit(key, FIRST, 'Which branch?')
  drafts.edit({ ...key, rootId: WORKER }, LATER, 'Which branch?')
  drafts.beginSend(key)!.settle(true)
  expect(drafts.getSnapshot().get(draftId({ ...key, rootId: WORKER }))?.text).toBe(LATER)
})

it('C3: an unsent draft survives switching to another conversation and returning', () => {
  const b = bench()
  b.open(); b.edit(LATER)
  b.view.rerender(b.tree(WORKER))
  b.view.rerender(b.tree(ROOT))
  b.open()
  expect(b.box().value).toBe(LATER)
})

it('C4: a refused send releases controls and permits a successful retry', async () => {
  const b = bench()
  b.command.mockResolvedValueOnce({ code: 'rejected', message: 'not ready' })
  b.open(); b.edit(FIRST)
  await act(async () => { b.send() })
  expect(b.box().disabled).toBe(false)
  expect(b.drafts.getSnapshot().get(draftId(key))).toMatchObject({ text: FIRST, sending: false })
  b.edit(LATER)
  await act(async () => { b.send() })
  expect(b.box().value).toBe('')
  expect(b.command).toHaveBeenLastCalledWith(ROOT, { kind: 'answer', request: {
    ticketId: build.id, questionId: key.questionId, expectedRevision: build.revision, answer: LATER,
  } })
})

it('N1: the same Ticket/question action in another root must not clear the first roots failure', () => {
  const reports = createCommandReports()
  // Explicit Ticket ids are unique only within their owning Session; both roots may have id "build" and question "q1".
  const rootACommand = { kind: 'answer' as const, request: {
    ticketId: build.id, questionId: key.questionId, expectedRevision: 4, answer: FIRST,
  } }
  const rootBCommand = { ...rootACommand, request: { ...rootACommand.request, answer: LATER } }
  reports.reportFailure({ code: 'rejected', message: 'root A refused the answer' }, rootACommand, ROOT)
  reports.reportFailure(null, rootBCommand, WORKER)
  expect(reports.getSnapshot()?.failure.message,
    'starting a command in root B must leave root As unrelated refusal visible').toBe('root A refused the answer')
})

it('N2: each simultaneously rendered answer field has its own associated label', () => {
  const props = { sessionId: ROOT, rootId: ROOT, command: async () => null, drafts: createAnswerDrafts(),
    t: makeTranslate(en, commonEn), nameOf: (id: SessionId) => id, items: needsYou([build]), retained: [] }
  render(<NeedsView {...props} />)
  const second = render(<NeedsView {...props} />)
  const box = within(second.container).getByRole<HTMLTextAreaElement>('textbox')
  expect(box.labels?.length, 'the second panels label must name its own answer field').toBe(1)
})

it('a send that succeeds keeps text edited into the draft store after the send began', async () => {
  const b = bench()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  b.command.mockReturnValueOnce(response.promise)
  b.open(); b.edit(FIRST); b.send()
  act(() => { b.drafts.edit(key, LATER, 'Which branch?') })
  await act(async () => { response.resolve(null) })
  expect(b.box().value).toBe(LATER)
  expect(b.box().disabled).toBe(false)
  expect(b.command).toHaveBeenCalledExactlyOnceWith(ROOT, { kind: 'answer', request: {
    ticketId: build.id, questionId: key.questionId, expectedRevision: build.revision, answer: FIRST,
  } })
})

it('a second send cannot start while the first is pending', async () => {
  const drafts = createAnswerDrafts()
  const response = Promise.withResolvers<WorkstreamFailure | null>()
  const command = vi.fn<WorkstreamActionInjected['command']>(() => response.promise)
  const props = { sessionId: ROOT, rootId: ROOT, command, drafts, t: makeTranslate(en, commonEn), nameOf: (id: SessionId) => id,
    items: needsYou([build]), retained: [] }
  const one = render(<NeedsView {...props} />)
  const two = render(<NeedsView {...props} />)
  fireEvent.change(within(one.container).getByRole('textbox'), { target: { value: FIRST } })
  fireEvent.submit(within(one.container).getByRole('textbox').closest('form')!)
  fireEvent.submit(within(two.container).getByRole('textbox').closest('form')!)
  await act(async () => { response.resolve(null) })
  expect(command).toHaveBeenCalledOnce()
})
