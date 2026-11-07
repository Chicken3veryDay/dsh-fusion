/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { interruptedTurnClosers, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  AgentEventDispatch,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
  InboxWireState,
} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/** Standard fold that reconstructs pending input and rejects invalid durable splice history. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event) {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    try {
      const inbox = state[splice.target]
      const removedCount = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || splice.start + removedCount > inbox.length) {
        throw new Error('invalid inbox splice')
      }
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step']]
        : [...state['next-turn'], ...next]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      return splice.target === 'next-turn'
        ? { 'next-turn': next, 'next-step': state['next-step'] }
        : { 'next-turn': state['next-turn'], 'next-step': next }
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // The wire value is the fold state itself: every pending message already
    // round-trips the session log as lossless JSON. Only the static type
    // narrows to the JSON-safe projection table entry.
    viewSchema: inboxProjectionSchema as unknown as z.ZodType<InboxWireState>,
    view: (state: InboxState) => state as unknown as InboxWireState,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'inbox', InboxState>

/**
 * Crash repair for claimed input: the events that commit the batch the open
 * tail turn claimed after its last `user/message` or `assistant/message`. A
 * claim is a pure-deletion `agent/inbox/spliced` (removed messages and no
 * `outcome`); its messages are those the inbox fold held at the claimed range.
 * The commits land inside the open step, or open the proposed step when the
 * claim preceded `step/start`, as a live preparation failure does. A log
 * without a `system/message` first receives the empty head that reserves
 * surface node 0 for the prompt. Append the result before the interrupted
 * closers, which close the step, so a process lost between a claim and its
 * `user/message` commit keeps the accepted input model-visible exactly once.
 * @param events - the persisted log, possibly ending inside an open turn.
 * @returns the commit events, numbered after the last event; empty when no open turn holds an uncommitted claim.
 */
export function uncommittedClaimCommits(events: readonly SessionEvent[]): SessionEvent[] {
  let state = inboxProjectionDefinition.init()
  let turn: number | null = null
  let step = 1
  let stepOpen = false
  let prompted = false
  let claimed: UserMessage[] = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turn = event.data.turn
        step = 1
        stepOpen = false
        claimed = []
        break
      case 'turn/end':
        turn = null
        claimed = []
        break
      case 'step/start':
        step = event.data.step
        stepOpen = true
        break
      case 'step/end':
        step = event.data.step + 1
        stepOpen = false
        break
      case 'system/message':
        prompted = true
        break
      case 'user/message':
      case 'assistant/message':
        claimed = []
        break
      case 'agent/inbox/spliced': {
        const { target, start, removedCount = 0, outcome } = event.data
        if (turn !== null && outcome === undefined && removedCount > 0) {
          claimed.push(...state[target].slice(start, start + removedCount))
        }
        break
      }
      // Other event types neither claim nor commit input.
      default:
        break
    }
    state = inboxProjectionDefinition.apply(state, event)
  }
  const last = events.at(-1)
  if (turn === null || last === undefined || claimed.length === 0) return []
  let seq = last.seq
  const commits: SessionEvent[] = []
  if (!stepOpen) commits.push({ type: 'step/start', seq: SessionSeq(++seq), time: last.time, data: { turn, step } })
  if (!prompted) {
    commits.push({
      type: 'system/message', seq: SessionSeq(++seq), time: last.time,
      data: { turn, step, message: createSystemMessage('') }, surfaceOp: 'append',
    })
  }
  for (const message of claimed) {
    commits.push({ type: 'user/message', seq: SessionSeq(++seq), time: last.time, data: message, surfaceOp: 'append' })
  }
  return commits
}

/**
 * Crash repair for a persisted log whose tail turn is open: the commits of
 * its uncommitted claimed input, then the interrupted closers.
 * @param events - the persisted log, possibly ending inside an open turn.
 * @returns the events to append after `events`; empty when the log is balanced.
 */
export function repairOpenTurn(events: readonly SessionEvent[]): SessionEvent[] {
  const commits = uncommittedClaimCommits(events)
  return [...commits, ...interruptedTurnClosers([...events, ...commits])]
}

/**
 * Driver-owned durable Inbox implementation used by ReactLoopAgent and focused
 * provider tests.
 * @param readState - reader for the live Inbox projection state.
 * @param session - session whose durable events store pending input.
 * @param dispatch - agent-scoped notifications for Inbox lifecycle events.
 */
export class ReactLoopInbox implements InboxContract {
  constructor(
    private readonly readState: () => InboxState,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.readState()['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.readState()['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const state = this.readState()
    return state['next-turn'].length > 0 || state['next-step'].length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step. The driver
   * delivers a claimed batch exactly once: the step commits it, a step
   * failure commits it before `turn/end`, and resume commits it after a
   * process loss. Only cancellation and an authoritative pre-step reject
   * consume it undelivered.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.readState()[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.readState()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Commit one normalized mutation and publish its live events. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const state = this.readState()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
