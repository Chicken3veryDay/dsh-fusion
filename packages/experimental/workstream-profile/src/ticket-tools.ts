/**
 * Loader entry that mounts `ticket_*` tools. The Ticket package exports `TicketTools` by name,
 * and the Loader mounts only a module's default export. The active-member rule for `ticket_assign` is enforced by
 * Workstream's assignment authority inside Ticket's queued assignment, so this entry adds no guard of its own.
 * @module @deepseek-ai/dsh-experimental-workstream-profile/ticket-tools
 */

export { TicketTools as default } from '@deepseek-ai/dsh-experimental-ticket'
