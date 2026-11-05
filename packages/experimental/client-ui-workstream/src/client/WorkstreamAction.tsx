import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {} from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  IconChecklistOutlineRegular, SegmentedTabs, StateDot, useAnchoredPosition, useDismissOnOutsidePointer, type SegmentedTab,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-experimental-ticket/client'
import type {} from '@deepseek-ai/dsh-experimental-workstream/client'
import type { AggregatedChangeRequestsResult } from '@deepseek-ai/dsh-experimental-workstream-evidence/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkstreamAttentionTarget, WorkstreamQuestionAnswer, WorkstreamQuestionTarget } from '../types.ts'
import { needsYou } from './model.ts'
import { NS } from './locales.ts'
import { ChangesView, FilesView, NeedsView, TeamView, WorkView } from './views.tsx'
import css from './WorkstreamAction.module.css'

/** One Ticket command the panel sends for the displayed Session. */
export type WorkstreamCommand =
  | { readonly kind: 'answer'; readonly request: WorkstreamQuestionAnswer }
  | { readonly kind: 'closeQuestion'; readonly request: WorkstreamQuestionTarget }
  | { readonly kind: 'acknowledge'; readonly request: WorkstreamAttentionTarget }
  | { readonly kind: 'resolve'; readonly request: WorkstreamAttentionTarget }

/** Typed command or read failure shown inline; `message` is the Host diagnostic. */
export interface WorkstreamFailure {
  readonly code: 'stale' | 'denied' | 'unavailable' | 'rejected' | 'failed'
  readonly message: string
}

/** Change request read result. */
export type ChangeRequestsRead =
  | { readonly ok: true; readonly value: AggregatedChangeRequestsResult }
  | { readonly ok: false; readonly failure: WorkstreamFailure }

/** Business actions injected by the browser plugin. */
export interface WorkstreamActionInjected {
  /** Open a member Session from the displayed conversation. */
  openMember: (sessionId: SessionId, memberId: SessionId) => void
  /**
   * Send one Ticket command as the displayed Session. After a stale-revision
   * failure the projections are reread before the promise settles.
   * @returns null after the command commits, else the failure.
   */
  command: (sessionId: SessionId, command: WorkstreamCommand) => Promise<WorkstreamFailure | null>
  /** Read the change requests bound by the displayed Session's Workstream. */
  changeRequests: (sessionId: SessionId) => Promise<ChangeRequestsRead>
}

/** Full props of the Workstream conversation-header action. */
export type WorkstreamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & WorkstreamActionInjected & PropsLocale<typeof NS>

/** Panel view value. */
export type WorkstreamView = 'needs' | 'work' | 'team' | 'changes' | 'files'

/**
 * Render the Workstream header action and its click-opened panel. The action
 * appears only while the displayed Session's Workstream root projects a
 * Workstream; every view derives from the root's `workstream`, `ticket`, and
 * `workstreamEvidence` projections, except Changes, which reads the Host.
 */
export function WorkstreamAction(props: WorkstreamActionProps) {
  const { sessionId, useSession, useSessions, t } = props
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<WorkstreamView>('needs')
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16 })
  const positioned = position !== null
  const rootId = useSession(snapshot => snapshot.subagent?.address.parentSessionId) ?? sessionId
  const workstream = useSessions(state => state.projectionsBySession[rootId]?.values.workstream)
  const tickets = useSessions(state => state.projectionsBySession[rootId]?.values.ticket)
  const evidence = useSessions(state => state.projectionsBySession[rootId]?.values.workstreamEvidence)

  useEffect(() => {
    setOpen(false)
    setView('needs')
  }, [sessionId])

  useLayoutEffect(() => {
    if (open && positioned) panelRef.current?.focus()
  }, [open, positioned])

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      /* v8 ignore next -- the panel element mounts in the same commit as the open state that registers this listener. */
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    }
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('keydown', dismiss) }
  }, [open])

  if (workstream == null) return null
  const ticketList = tickets?.tickets ?? []
  const needs = needsYou(ticketList)
  const artifacts = evidence?.artifacts ?? []
  const counts: Record<WorkstreamView, number | null> = {
    needs: needs.length, work: ticketList.length, team: workstream.members.length, changes: null, files: artifacts.length,
  }
  const tabItem = (value: WorkstreamView): SegmentedTab<WorkstreamView> => ({
    value,
    id: `workstream-tab-${value}`,
    panelId: `workstream-panel-${value}`,
    label: (
      <span className={css.tabLabel}>
        {t(`tab.${value}`)}
        {counts[value] !== null && counts[value] > 0 && <span className={css.count}>{counts[value]}</span>}
      </span>
    ),
  })
  const names = new Map(workstream.members.map(member => [member.id, member.name]))
  const nameOf = (id: SessionId): string => names.get(id) ?? id

  return (
    <div ref={rootRef} className={css.root} data-workstream-action>
      <button
        type="button"
        ref={triggerRef}
        className={css.trigger}
        aria-label={t('trigger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) setOpen(true)
          else panelRef.current?.focus()
        }}
      >
        <IconChecklistOutlineRegular size={14} />
        <span className={css.triggerLabel}>{t('trigger')}</span>
        {needs.length > 0 && <span className={css.badge}>{needs.length}</span>}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={workstream.title}
          data-workstream-panel
        >
          <div className={css.header}>
            <h2 className={css.title}>{workstream.title}</h2>
            <SegmentedTabs
              items={[tabItem('needs'), tabItem('work'), tabItem('team'), tabItem('changes'), tabItem('files')]}
              value={view}
              onChange={setView}
              label={t('views')}
              size="sm"
              className={css.tabs}
            />
          </div>
          <div className={css.body} role="tabpanel" id={`workstream-panel-${view}`} aria-labelledby={`workstream-tab-${view}`}>
            {tickets?.failure !== undefined && (
              <div className={css.error} role="alert"><StateDot state="error" />{t('failure', { message: tickets.failure })}</div>
            )}
            {view === 'needs' && <NeedsView {...props} items={needs} nameOf={nameOf} />}
            {view === 'work' && <WorkView tickets={ticketList} nameOf={nameOf} t={t} />}
            {view === 'team' && <TeamView {...props} rootId={rootId} workstream={workstream} />}
            {view === 'changes' && <ChangesView {...props} nameOf={nameOf} />}
            {view === 'files' && <FilesView artifacts={artifacts} nameOf={nameOf} t={t} />}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
