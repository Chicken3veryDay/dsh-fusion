/** Durable evidence that a child accepted one inbox message. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'

/** Durable message evidence includes admitted history, the surviving pending inbox, and input a turn claimed.
 *
 * A turn removes its input from the inbox before the first step commits the `user/message`; a removal without
 * `outcome: 'canceled'` is that claim and still proves acceptance. A cancelled removal dropped the message unrun.
 * @param events - The child's committed events after its inherited prefix.
 * @param predicate - Selects the message whose acceptance is in question.
 * @returns The accepted message id, or undefined when the log holds no evidence.
 */
export function acceptedMessage(events: readonly SessionEvent[], predicate: (message: UserMessage) => boolean): MessageId | undefined {
  const pending: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  const claimed: UserMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message' && predicate(event.data)) return event.data.id
    if (event.type === 'agent/inbox/spliced') {
      const removed = pending[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
      if (event.data.outcome !== 'canceled') claimed.push(...removed)
    }
  }
  return [...claimed, ...pending['next-turn'], ...pending['next-step']].find(predicate)?.id
}
