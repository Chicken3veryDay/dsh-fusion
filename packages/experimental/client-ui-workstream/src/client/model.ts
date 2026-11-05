/** Pure derivations of panel rows from the root Session's Ticket projection. */

import type {
  MissionId, TicketAttentionSnapshot, TicketQuestionSnapshot, TicketView,
} from '@deepseek-ai/dsh-experimental-ticket/client'

/** One item that waits for a human decision, with the Ticket revision it was read at. */
export type NeedsItem =
  | { readonly kind: 'question'; readonly ticket: TicketView; readonly question: TicketQuestionSnapshot }
  | { readonly kind: 'attention'; readonly ticket: TicketView; readonly attention: TicketAttentionSnapshot }

/** Mission plan progress counted from the current Ticket statuses. */
export interface MissionProgress {
  readonly id: MissionId
  readonly title: string
  readonly milestones: readonly { readonly title: string; readonly completed: number; readonly total: number }[]
}

/**
 * List open questions and unresolved attention items of nonterminal Tickets, oldest first.
 * Terminal Tickets reject every command, so their items are omitted.
 * @param tickets - Tickets of the Workstream root.
 * @returns items in creation order.
 */
export function needsYou(tickets: readonly TicketView[]): NeedsItem[] {
  const items: NeedsItem[] = []
  for (const ticket of tickets) {
    if (ticket.terminalOutcome !== undefined) continue
    for (const question of ticket.questions) {
      if (question.status === 'open') items.push({ kind: 'question', ticket, question })
    }
    for (const attention of ticket.attentions) {
      if (attention.status !== 'resolved') items.push({ kind: 'attention', ticket, attention })
    }
  }
  return items.sort((left, right) => createdAt(left) - createdAt(right))
}

function createdAt(item: NeedsItem): number {
  return item.kind === 'question' ? item.question.createdAt : item.attention.createdAt
}

/**
 * Collect each Mission plan once, at its highest revision, with milestone completion counts.
 * A milestone counts a Ticket as done when its status is `completed`; an unknown Ticket id counts as not done.
 * @param tickets - Tickets of the Workstream root.
 * @returns Missions in first-seen order.
 */
export function missions(tickets: readonly TicketView[]): MissionProgress[] {
  const status = new Map(tickets.map(ticket => [ticket.id, ticket.status]))
  const plans = new Map<MissionId, TicketView['missionPlans'][number]>()
  for (const ticket of tickets) {
    for (const plan of ticket.missionPlans) {
      const known = plans.get(plan.id)
      if (known === undefined || known.revision < plan.revision) plans.set(plan.id, plan)
    }
  }
  return [...plans.values()].map(plan => ({
    id: plan.id,
    title: plan.title,
    milestones: plan.milestones.map(milestone => ({
      title: milestone.title,
      completed: milestone.ticketIds.filter(id => status.get(id) === 'completed').length,
      total: milestone.ticketIds.length,
    })),
  }))
}
