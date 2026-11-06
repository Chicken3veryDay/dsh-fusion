import { expect, it } from 'vitest'
import type { TicketId, TicketQuestionId } from '@deepseek-ai/dsh-experimental-ticket/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createAnswerDrafts, draftId, retainedDrafts, type AnswerDraftKey } from '../src/client/drafts.ts'

const key = (root: string, question: string): AnswerDraftKey => ({
  rootId: root as SessionId, ticketId: 'build' as TicketId, questionId: question as TicketQuestionId,
})

it('keeps one draft per root, Ticket, and question, and removes it when its text is emptied', () => {
  const drafts = createAnswerDrafts()
  drafts.edit(key('a', 'q1'), 'one', 'Which?')
  drafts.edit(key('b', 'q1'), 'two', 'Which?')
  drafts.edit(key('a', 'q1'), 'three', 'Which?')
  expect([...drafts.getSnapshot().values()].map(draft => draft.text)).toEqual(['three', 'two'])
  drafts.edit(key('a', 'q1'), '', 'Which?')
  expect([...drafts.getSnapshot().values()].map(draft => draft.text)).toEqual(['two'])
  expect(draftId(key('a', 'q1'))).not.toBe(draftId(key('b', 'q1')))
})

it('tracks a send: a refusal keeps the text, a commit drops it, and unknown drafts are ignored', () => {
  const drafts = createAnswerDrafts()
  drafts.beginSend(key('a', 'missing'))
  drafts.endSend(key('a', 'missing'), true)
  expect(drafts.getSnapshot().size).toBe(0)
  drafts.edit(key('a', 'q1'), 'text', 'Which?')
  drafts.beginSend(key('a', 'q1'))
  expect(drafts.getSnapshot().get(draftId(key('a', 'q1')))?.sending).toBe(true)
  drafts.endSend(key('a', 'q1'), false)
  expect(drafts.getSnapshot().get(draftId(key('a', 'q1')))).toMatchObject({ text: 'text', sending: false })
  drafts.endSend(key('a', 'q1'), true)
  expect(drafts.getSnapshot().size).toBe(0)
})

it('notifies subscribers and discards a draft on request', () => {
  const drafts = createAnswerDrafts()
  let notified = 0
  const stop = drafts.subscribe(() => { notified += 1 })
  drafts.edit(key('a', 'q1'), 'text', 'Which?')
  drafts.discard(key('a', 'q1'))
  stop()
  drafts.edit(key('a', 'q2'), 'later', 'Which?')
  expect(notified).toBe(2)
})

it('retains only unsent drafts of the displayed root whose question has no card', () => {
  const drafts = createAnswerDrafts()
  drafts.edit(key('a', 'shown'), 'card', 'Q')
  drafts.edit(key('a', 'orphan'), 'orphan', 'Q')
  drafts.edit(key('a', 'sending'), 'sending', 'Q')
  drafts.beginSend(key('a', 'sending'))
  drafts.edit(key('b', 'other'), 'other root', 'Q')
  const retained = retainedDrafts(drafts.getSnapshot(), 'a' as SessionId, new Set([draftId(key('a', 'shown'))]))
  expect(retained.map(draft => draft.text)).toEqual(['orphan'])
})
