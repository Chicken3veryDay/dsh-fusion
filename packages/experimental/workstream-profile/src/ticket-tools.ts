/**
 * Loader entry that mounts `ticket_*` tools. The Ticket package exports `TicketTools` by name,
 * and the Loader mounts only a module's default export.
 * @module @deepseek-ai/dsh-experimental-workstream-profile/ticket-tools
 */

export { TicketTools as default } from '@deepseek-ai/dsh-experimental-ticket'
