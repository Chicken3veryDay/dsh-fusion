/** Application-owned command outcomes survive the card, panel, and conversation that sent them. */

import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkstreamActionInjected, WorkstreamCommand, WorkstreamFailure } from './WorkstreamAction.tsx'
import type { NS } from './locales.ts'
import { failureText } from './views.tsx'

/**
 * Identify the card action a command belongs to, so a command supersedes only its own earlier report.
 * Ticket ids are unique only within their root, so the root is part of the identity.
 */
function commandId(rootId: SessionId, command: WorkstreamCommand): string {
  const { request } = command
  return JSON.stringify([rootId, command.kind, request.ticketId, 'questionId' in request ? request.questionId : request.attentionId])
}

/**
 * Create the plugin-owned command report store.
 * @returns report publication, subscription, and dismissal for the shell overlay.
 */
export function createCommandReports() {
  const store = createSnapshotStore<{ seq: number; id: string; failure: WorkstreamFailure } | null>(null)
  let seq = 0
  const reportFailure: WorkstreamActionInjected['reportFailure'] = (failure, command, rootId) => {
    const id = commandId(rootId, command)
    if (failure !== null) store.set({ seq: ++seq, id, failure })
    else if (store.getSnapshot()?.id === id) store.set(null)
  }
  return {
    subscribe: (listener: () => void) => store.subscribe(listener),
    getSnapshot: () => store.getSnapshot(),
    reportFailure,
    dismiss: () => { store.set(null) },
  }
}

/**
 * Render the latest command refusal in the application overlay. Rejected answer text is not part of
 * the transient report; the answer draft store keeps it.
 * @param props - plugin-owned reports and localized panel copy.
 * @returns the transient report or no content.
 */
export function CommandNotice({ reports, t }: { reports: ReturnType<typeof createCommandReports> } & PropsLocale<typeof NS>) {
  const notice = useSyncExternalStore(reports.subscribe, reports.getSnapshot)
  if (notice === null) return null
  return <Toast key={notice.seq} text={failureText(notice.failure, t)} onDone={reports.dismiss} />
}
