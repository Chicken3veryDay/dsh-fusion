/** Application-owned command outcomes survive the card, panel, and conversation that sent them. */

import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkstreamActionInjected, WorkstreamFailure } from './WorkstreamAction.tsx'
import type { NS } from './locales.ts'
import { failureText } from './views.tsx'

/**
 * Create the plugin-owned command report store.
 * @returns report publication, subscription, and dismissal for the shell overlay.
 */
export function createCommandReports() {
  const store = createSnapshotStore<{ seq: number; failure: WorkstreamFailure; draft: string } | null>(null)
  let seq = 0
  const reportFailure: WorkstreamActionInjected['reportFailure'] = (failure, command) => {
    store.set(failure === null ? null : {
      seq: ++seq, failure, draft: command.kind === 'answer' ? command.request.answer : '',
    })
  }
  return {
    subscribe: (listener: () => void) => store.subscribe(listener),
    getSnapshot: () => store.getSnapshot(),
    reportFailure,
    dismiss: () => { store.set(null) },
  }
}

/**
 * Render command refusals in the application overlay, including any rejected answer.
 * @param props - plugin-owned reports and localized panel copy.
 * @returns the transient report or no content.
 */
export function CommandNotice({ reports, t }: { reports: ReturnType<typeof createCommandReports> } & PropsLocale<typeof NS>) {
  const notice = useSyncExternalStore(reports.subscribe, reports.getSnapshot)
  if (notice === null) return null
  const text = failureText(notice.failure, t) + (notice.draft.length === 0 ? '' : `\n${notice.draft}`)
  return <Toast key={notice.seq} text={text} onDone={reports.dismiss} />
}
