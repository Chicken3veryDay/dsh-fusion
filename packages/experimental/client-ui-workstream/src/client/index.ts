/** Browser entry of the Workstream panel: the conversation-header action and its Remote. */

import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-experimental-client-ui-workstream/remote'
import { mountWorkstreamPanel } from './mount.ts'

export { inject } from './mount.ts'
export type { WorkstreamKey } from './locales.ts'
export type {
  ChangeRequestsRead, WorkstreamActionInjected, WorkstreamActionProps, WorkstreamCommand, WorkstreamFailure, WorkstreamView,
} from './WorkstreamAction.tsx'

/**
 * Mount the Workstream panel Remote and its header action.
 * @param ctx - browser plugin context.
 * @returns the disposer that withdraws the UI, then the Remote.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountWorkstreamPanel(ctx, remote)
}
