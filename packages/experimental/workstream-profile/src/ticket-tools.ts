/**
 * Loader entry that mounts `ticket_*` tools. The Ticket package exports `TicketTools` by name,
 * and the Loader mounts only a module's default export. Workstream enforces the active-member and coordinator rules
 * through Ticket authorities that exist only while `workstreams` is loaded, so these tools depend on `workstreams` and
 * unload with it.
 * @module @deepseek-ai/dsh-experimental-workstream-profile/ticket-tools
 */

import { TicketTools as BaseTicketTools } from '@deepseek-ai/dsh-experimental-ticket'

/** Ticket tools mounted only while Workstream's Ticket authorities are registered. */
export default class TicketTools extends BaseTicketTools {
  static override inject = [...BaseTicketTools.inject, 'workstreams']
}
