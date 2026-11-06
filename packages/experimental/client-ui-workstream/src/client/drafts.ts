/** Application-owned answer text that survives the question card, tab, panel, and conversation that held it. */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TicketId, TicketQuestionId } from '@deepseek-ai/dsh-experimental-ticket/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identity of one answerable question within a Workstream. */
export interface AnswerDraftKey {
  readonly rootId: SessionId
  readonly ticketId: TicketId
  readonly questionId: TicketQuestionId
}

/** Answer text the user typed for one question, whether sent, rejected, or never sent. */
export interface AnswerDraft extends AnswerDraftKey {
  readonly text: string
  /** Question text when the draft was typed, shown if the question disappears. */
  readonly question: string
  /** True from the send until its outcome; a sending draft is neither retained nor discarded. */
  readonly sending: boolean
}

/** All drafts by {@link draftId}; every change publishes a new map. */
export type AnswerDrafts = ReadonlyMap<string, AnswerDraft>

/**
 * Derive the map key of a draft.
 * @param key - question identity.
 * @returns a string unique to the root, Ticket, and question.
 */
export function draftId(key: AnswerDraftKey): string {
  return JSON.stringify([key.rootId, key.ticketId, key.questionId])
}

/**
 * Find drafts of one Workstream whose question has no answer card.
 * @param drafts - current drafts.
 * @param rootId - Workstream root of the displayed panel.
 * @param answerable - {@link draftId} of every question that currently has a card.
 * @returns the unsent drafts that can no longer be sent from a card, oldest first.
 */
export function retainedDrafts(drafts: AnswerDrafts, rootId: SessionId, answerable: ReadonlySet<string>): readonly AnswerDraft[] {
  return [...drafts].filter(([id, draft]) => draft.rootId === rootId && !draft.sending && !answerable.has(id)).map(([, draft]) => draft)
}

/** Plugin-owned drafts handed to the panel. */
export interface AnswerDraftStore {
  /** Subscribe to every draft change; returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void
  /** Current drafts. */
  readonly getSnapshot: () => AnswerDrafts
  /** Record the text of a draft; empty text removes it. */
  edit(key: AnswerDraftKey, text: string, question: string): void
  /** Mark a draft as being sent. */
  beginSend(key: AnswerDraftKey): void
  /** End a send: a committed answer removes the draft, a refusal keeps its text. */
  endSend(key: AnswerDraftKey, committed: boolean): void
  /** Remove a draft the user chose to drop. */
  discard(key: AnswerDraftKey): void
}

/**
 * Create the plugin-owned answer draft store.
 * @returns draft reads, edits, send tracking, and discard for the panel.
 */
export function createAnswerDrafts(): AnswerDraftStore {
  const store = createSnapshotStore<AnswerDrafts>(new Map())
  const update = (change: (next: Map<string, AnswerDraft>) => void): void => {
    const next = new Map(store.getSnapshot())
    change(next)
    store.set(next)
  }
  return {
    subscribe: (listener: () => void) => store.subscribe(listener),
    getSnapshot: (): AnswerDrafts => store.getSnapshot(),
    edit(key: AnswerDraftKey, text: string, question: string): void {
      update((next) => {
        if (text.length === 0) next.delete(draftId(key))
        else next.set(draftId(key), { ...key, text, question, sending: false })
      })
    },
    beginSend(key: AnswerDraftKey): void {
      update((next) => {
        const draft = next.get(draftId(key))
        if (draft !== undefined) next.set(draftId(key), { ...draft, sending: true })
      })
    },
    endSend(key: AnswerDraftKey, committed: boolean): void {
      update((next) => {
        const draft = next.get(draftId(key))
        if (draft === undefined) return
        if (committed) next.delete(draftId(key))
        else next.set(draftId(key), { ...draft, sending: false })
      })
    },
    discard(key: AnswerDraftKey): void {
      update((next) => { next.delete(draftId(key)) })
    },
  }
}
