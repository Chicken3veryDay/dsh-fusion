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
  /** True from the send until its outcome; a sending draft is neither retained nor discarded, and no second send starts. */
  readonly sending: boolean
  /** Store-unique number of the latest edit; a send removes the draft only while this still equals the sent edit. */
  readonly revision: number
}

/** All drafts by {@link draftId}; every change publishes a new map. */
export type AnswerDrafts = ReadonlyMap<string, AnswerDraft>

/** One started send: the exact text to submit and the single settlement of its outcome. */
export interface AnswerSend {
  /** Draft text at the moment the send began; submit this, not a later read of the draft. */
  readonly text: string
  /**
   * Settle the send once; later calls and calls after the draft was discarded or emptied are ignored.
   * A commit removes the draft only when no edit followed the sent text, so newer text stays; a refusal
   * keeps the text. Either way the draft stops sending.
   * @param committed - whether the answer was committed.
   */
  settle(committed: boolean): void
}

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
  /** Record the text of a draft; empty text removes it. A draft that is sending keeps sending. */
  edit(key: AnswerDraftKey, text: string, question: string): void
  /**
   * Mark a draft as being sent.
   * @returns the started send, or null when there is no draft or its send is still pending.
   */
  beginSend(key: AnswerDraftKey): AnswerSend | null
  /** Remove a draft the user chose to drop; a pending send of it no longer changes anything. */
  discard(key: AnswerDraftKey): void
}

/**
 * Create the plugin-owned answer draft store.
 * @returns draft reads, edits, send tracking, and discard for the panel.
 */
export function createAnswerDrafts(): AnswerDraftStore {
  const store = createSnapshotStore<AnswerDrafts>(new Map())
  /** Token of the send in flight per draft; a send that is no longer current cannot touch the draft. */
  const sends = new Map<string, symbol>()
  let revisions = 0
  const update = (change: (next: Map<string, AnswerDraft>) => void): void => {
    const next = new Map(store.getSnapshot())
    change(next)
    store.set(next)
  }
  const remove = (id: string): void => {
    sends.delete(id)
    update((next) => { next.delete(id) })
  }
  return {
    subscribe: (listener: () => void) => store.subscribe(listener),
    getSnapshot: (): AnswerDrafts => store.getSnapshot(),
    edit(key: AnswerDraftKey, text: string, question: string): void {
      const id = draftId(key)
      if (text.length === 0) {
        remove(id)
        return
      }
      const sending = store.getSnapshot().get(id)?.sending ?? false
      update((next) => { next.set(id, { ...key, text, question, sending, revision: ++revisions }) })
    },
    beginSend(key: AnswerDraftKey): AnswerSend | null {
      const id = draftId(key)
      const draft = store.getSnapshot().get(id)
      if (draft === undefined || draft.sending) return null
      const token = Symbol(id)
      sends.set(id, token)
      update((next) => { next.set(id, { ...draft, sending: true }) })
      return {
        text: draft.text,
        settle(committed: boolean): void {
          if (sends.get(id) !== token) return
          sends.delete(id)
          const current = store.getSnapshot().get(id)
          /* v8 ignore next -- a send is current only while its draft exists: discard and emptying drop both together. */
          if (current === undefined) return
          if (committed && current.revision === draft.revision) update((next) => { next.delete(id) })
          else update((next) => { next.set(id, { ...current, sending: false }) })
        },
      }
    },
    discard(key: AnswerDraftKey): void {
      remove(draftId(key))
    },
  }
}
