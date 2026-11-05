/** The five Workstream panel views. */

import { useCallback, useEffect, useState } from 'react'
import { Button, fileSizeText, StateDot, Tag, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AssignmentSnapshot, TicketAttentionSnapshot, TicketStatus, TicketView,
} from '@deepseek-ai/dsh-experimental-ticket/client'
import type { WorkstreamMember, WorkstreamSnapshot } from '@deepseek-ai/dsh-experimental-workstream/client'
import type { WorkstreamEvidenceArtifactRecord } from '@deepseek-ai/dsh-experimental-workstream-evidence/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { missions, type NeedsItem } from './model.ts'
import type { NS, WorkstreamKey } from './locales.ts'
import type { ChangeRequestsRead, WorkstreamActionProps, WorkstreamCommand, WorkstreamFailure } from './WorkstreamAction.tsx'
import css from './WorkstreamAction.module.css'

type T = TranslateNS<typeof NS>
type NameOf = (id: SessionId) => string

function failureText(failure: WorkstreamFailure, t: T): string {
  switch (failure.code) {
    case 'stale': return t('error.stale')
    case 'denied': return t('error.denied')
    case 'unavailable': return t('error.unavailable')
    case 'rejected': return t('error.rejected', { message: failure.message })
    case 'failed': return t('error.failed', { message: failure.message })
  }
}

function FailureNotice({ failure, t }: { failure: WorkstreamFailure; t: T }) {
  return <div className={css.error} role="alert"><StateDot state="error" />{failureText(failure, t)}</div>
}

function Empty({ text }: { text: string }) {
  return <p className={css.empty}>{text}</p>
}

/** Pending flag and last failure of one card's command. */
function useCommand(props: Pick<WorkstreamActionProps, 'sessionId' | 'command'>) {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<WorkstreamFailure | null>(null)
  const run = async (command: WorkstreamCommand): Promise<boolean> => {
    setPending(true)
    setFailure(null)
    try {
      const result = await props.command(props.sessionId, command)
      setFailure(result)
      return result === null
    } catch (error) {
      setFailure({ code: 'failed', message: String(error) })
      return false
    } finally {
      setPending(false)
    }
  }
  return { pending, failure, run }
}

type NeedsProps = Pick<WorkstreamActionProps, 'sessionId' | 'command' | 't'> & { nameOf: NameOf }

function QuestionCard({ item, nameOf, ...props }: NeedsProps & { item: Extract<NeedsItem, { kind: 'question' }> }) {
  const { t } = props
  const [answer, setAnswer] = useState('')
  const { pending, failure, run } = useCommand(props)
  const target = { ticketId: item.ticket.id, questionId: item.question.id, expectedRevision: item.ticket.revision }
  const inputId = `workstream-answer-${item.ticket.id}-${item.question.id}`
  return (
    <article className={css.card} data-question={item.question.id}>
      <div className={css.cardTitle}>
        <StateDot state="warning" />
        <strong>{t('needs.question', { name: nameOf(item.question.authorId) })}</strong>
      </div>
      <p className={css.text}>{item.question.question}</p>
      <div className={css.meta}><span>{t('needs.ticket', { subject: item.ticket.subject })}</span></div>
      <form
        className={css.answerForm}
        onSubmit={(event) => {
          event.preventDefault()
          void run({ kind: 'answer', request: { ...target, answer } }).then((ok) => { if (ok) setAnswer('') })
        }}
      >
        <label htmlFor={inputId} className={css.visuallyHidden}>{t('answer.label')}</label>
        <textarea
          id={inputId}
          className={css.textarea}
          value={answer}
          rows={2}
          placeholder={t('answer.placeholder')}
          disabled={pending}
          onChange={(event) => { setAnswer(event.target.value) }}
        />
        <div className={css.actions}>
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => { void run({ kind: 'closeQuestion', request: target }) }}>
            {t('question.close')}
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={pending || answer.trim().length === 0}>
            {pending ? t('pending') : t('answer.submit')}
          </Button>
        </div>
      </form>
      {failure !== null && <FailureNotice failure={failure} t={t} />}
    </article>
  )
}

function attentionKey(kind: TicketAttentionSnapshot['kind']): WorkstreamKey {
  switch (kind) {
    case 'review': return 'attention.review'
    case 'question': return 'attention.question'
    case 'blocked': return 'attention.blocked'
    case 'decision': return 'attention.decision'
  }
}

function AttentionCard({ item, ...props }: NeedsProps & { item: Extract<NeedsItem, { kind: 'attention' }> }) {
  const { t } = props
  const { pending, failure, run } = useCommand(props)
  const target = { ticketId: item.ticket.id, attentionId: item.attention.id, expectedRevision: item.ticket.revision }
  const acknowledged = item.attention.status === 'acknowledged'
  return (
    <article className={css.card} data-attention={item.attention.id}>
      <div className={css.cardTitle}>
        <StateDot state={item.attention.kind === 'blocked' ? 'error' : 'warning'} />
        <strong>{t(attentionKey(item.attention.kind))}</strong>
        {acknowledged && <Tag tone="info" className={css.tag}>{t('attention.acknowledged')}</Tag>}
      </div>
      <p className={css.text}>{item.attention.message}</p>
      <div className={css.meta}><span>{t('needs.ticket', { subject: item.ticket.subject })}</span></div>
      <div className={css.actions}>
        {!acknowledged && (
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => { void run({ kind: 'acknowledge', request: target }) }}>
            {t('attention.acknowledge')}
          </Button>
        )}
        <Button type="button" variant="primary" size="sm" disabled={pending} onClick={() => { void run({ kind: 'resolve', request: target }) }}>
          {pending ? t('pending') : t('attention.resolve')}
        </Button>
      </div>
      {failure !== null && <FailureNotice failure={failure} t={t} />}
    </article>
  )
}

/** Open questions and unresolved attention items with their Ticket commands. */
export function NeedsView({ items, ...props }: NeedsProps & { items: readonly NeedsItem[] }) {
  if (items.length === 0) return <Empty text={props.t('needs.empty')} />
  return (
    <div className={css.list}>
      {items.map(item => item.kind === 'question'
        ? <QuestionCard key={`${item.ticket.id}:${item.question.id}`} item={item} {...props} />
        : <AttentionCard key={`${item.ticket.id}:${item.attention.id}`} item={item} {...props} />)}
    </div>
  )
}

function statusDot(status: TicketStatus): StateDotState {
  switch (status) {
    case 'proposed':
    case 'ready': return 'idle'
    case 'coordinating':
    case 'executing':
    case 'integrating':
    case 'reviewing': return 'ongoing'
    case 'waiting':
    case 'blocked': return 'warning'
    case 'completed': return 'done'
    case 'failed':
    case 'cancelled': return 'error'
  }
}

function AssignmentRow({ assignment, nameOf, t }: { assignment: AssignmentSnapshot; nameOf: NameOf; t: T }) {
  return (
    <li>
      <span className={css.assignmentSubject}>{assignment.subject}</span>
      <span>{` · ${nameOf(assignment.ownerId)} · ${t(`role.${assignment.role}`)} · ${t(`assignment.${assignment.status}`)}`}</span>
    </li>
  )
}

/** Mission milestones, then every Ticket with status, dependencies, and assignments. */
export function WorkView({ tickets, nameOf, t }: { tickets: readonly TicketView[]; nameOf: NameOf; t: T }) {
  if (tickets.length === 0) return <Empty text={t('work.empty')} />
  const subjects = new Map(tickets.map(ticket => [ticket.id, ticket.subject]))
  const plans = missions(tickets)
  return (
    <>
      {plans.length > 0 && (
        <section>
          <h3>{t('work.missions')}</h3>
          <div className={css.list}>
            {plans.map(plan => (
              <article key={plan.id} className={css.card}>
                <div className={css.cardTitle}><strong>{plan.title}</strong></div>
                <ul className={css.milestones}>
                  {plan.milestones.map(milestone => (
                    <li key={milestone.title}>
                      <StateDot state={milestone.total > 0 && milestone.completed === milestone.total ? 'done' : 'idle'} />
                      <span>{milestone.title}</span>
                      <span className={css.progress}>{t('work.progress', { completed: milestone.completed, total: milestone.total })}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
      )}
      <section>
        <h3>{t('work.tickets')}<span className={css.count}>{tickets.length}</span></h3>
        <div className={css.list}>
          {tickets.map(ticket => (
            <article key={ticket.id} className={css.card} data-ticket={ticket.id}>
              <div className={css.cardTitle}>
                <strong>{ticket.subject}</strong>
                <span className={css.state}><StateDot state={statusDot(ticket.status)} /><span>{t(`status.${ticket.status}`)}</span></span>
              </div>
              {ticket.description.length > 0 && <p className={`${css.text} ${css.clamped}`}>{ticket.description}</p>}
              <div className={css.meta}>
                <span>{t('work.coordinator')}: {nameOf(ticket.coordinatorId)}</span>
                {ticket.specification.dependencies.length > 0 && (
                  <span>{t('work.dependsOn')}: {ticket.specification.dependencies.map(id => subjects.get(id) ?? id).join(', ')}</span>
                )}
              </div>
              {ticket.assignments.length === 0
                ? <div className={css.meta}><span>{t('work.unassigned')}</span></div>
                : (
                  <ul className={css.assignments}>
                    {ticket.assignments.map(assignment => (
                      <AssignmentRow key={assignment.id} assignment={assignment} nameOf={nameOf} t={t} />
                    ))}
                  </ul>
                )}
            </article>
          ))}
        </div>
      </section>
    </>
  )
}

function phaseDot(phase: WorkstreamMember['phase']): StateDotState {
  switch (phase) {
    case 'provisioning':
    case 'stopping': return 'ongoing'
    case 'active': return 'done'
    case 'stopped': return 'idle'
  }
}

/** Members with role and phase; each opens its continuable Session. */
export function TeamView({ sessionId, rootId, workstream, openMember, t }: Pick<WorkstreamActionProps, 'sessionId' | 'openMember' | 't'> & {
  rootId: SessionId
  workstream: WorkstreamSnapshot
}) {
  const [failure, setFailure] = useState<WorkstreamFailure | null>(null)
  return (
    <>
      {failure !== null && <FailureNotice failure={failure} t={t} />}
      <div className={css.roster}>
        {workstream.members.map((member) => {
          const current = member.id === sessionId
          const inert = current || member.phase === 'provisioning'
          return (
            <button
              key={member.id}
              type="button"
              className={current ? `${css.member} ${css.memberCurrent}` : css.member}
              disabled={inert}
              aria-label={inert ? undefined : `${t('team.open')}: ${member.name}`}
              onClick={() => {
                try {
                  openMember(sessionId, member.id)
                } catch (error) {
                  setFailure({ code: 'failed', message: String(error) })
                }
              }}
            >
              <span className={css.memberDot}><StateDot state={phaseDot(member.phase)} /></span>
              <span className={css.memberText}>
                <span className={css.memberName}>
                  <span className={css.memberNameText}>{member.name}</span>
                  {current && <Tag tone="info" className={css.tag}>{t('team.current')}</Tag>}
                </span>
                <small>
                  {t(member.id === rootId ? 'member.owner' : 'member.member')}
                  {member.id === workstream.coordinatorId && ` · ${t('member.coordinator')}`}
                  {` · ${t(`phase.${member.phase}`)}`}
                </small>
                {member.description.length > 0 && <small className={css.memberDescription}>{member.description}</small>}
                {member.diagnostic !== null && <small className={css.diagnostic}>{member.diagnostic}</small>}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}

type ChangesState = { readonly phase: 'loading' } | ChangeRequestsRead

/** Change requests bound by members, with contributing Sessions and an incomplete notice. */
export function ChangesView({ sessionId, changeRequests, nameOf, t }: Pick<WorkstreamActionProps, 'sessionId' | 'changeRequests' | 't'> & {
  nameOf: NameOf
}) {
  const [state, setState] = useState<ChangesState>({ phase: 'loading' })
  const [reads, setReads] = useState(0)
  const reload = useCallback(() => { setReads(count => count + 1) }, [])
  useEffect(() => {
    // A read that settles after the view changed Session or reloaded is dropped.
    let current = true
    setState({ phase: 'loading' })
    changeRequests(sessionId).then(
      (result) => { if (current) setState(result) },
      (error: unknown) => { if (current) setState({ ok: false, failure: { code: 'failed', message: String(error) } }) },
    )
    return () => { current = false }
  }, [sessionId, changeRequests, reads])
  const toolbar = (
    <div className={css.toolbar}>
      <Button type="button" variant="ghost" size="sm" disabled={'phase' in state} onClick={reload}>{t('changes.reload')}</Button>
    </div>
  )
  if ('phase' in state) {
    return <div className={css.notice} role="status"><StateDot state="ongoing" />{t('changes.loading')}</div>
  }
  if (!state.ok) return <>{toolbar}<FailureNotice failure={state.failure} t={t} /></>
  const { complete, changeRequests: entries, diagnostics } = state.value
  return (
    <>
      {toolbar}
      {!complete && (
        <div className={css.warningNotice} role="status" data-incomplete>
          <StateDot state="warning" />
          {t('changes.incomplete', { reasons: diagnostics.join('; ') })}
        </div>
      )}
      {entries.length === 0
        ? <Empty text={t('changes.empty')} />
        : (
          <div className={css.list}>
            {entries.map((entry) => {
              const update = entry.contributions.find(contribution => contribution.update !== null)?.update ?? null
              const snapshot = update !== null && 'snapshot' in update ? update.snapshot : null
              return (
                <article key={entry.url} className={css.card} data-change-request={entry.url}>
                  <div className={css.cardTitle}>
                    <a className={css.link} href={entry.url} target="_blank" rel="noopener noreferrer">{snapshot?.title ?? entry.url}</a>
                    <span className={css.state}>
                      {snapshot === null
                        ? <span>{t('changes.unread')}</span>
                        : <span>{t(snapshot.draft && snapshot.state === 'open' ? 'changes.draft' : `changes.${snapshot.state}`)}</span>}
                    </span>
                  </div>
                  <div className={css.meta}>
                    <span>{t('changes.boundIn')}: {entry.contributions.map(contribution => nameOf(contribution.sessionId)).join(', ')}</span>
                  </div>
                </article>
              )
            })}
          </div>
        )}
    </>
  )
}

/** Evidence artifacts with every retained version's metadata. */
export function FilesView({ artifacts, nameOf, t }: { artifacts: readonly WorkstreamEvidenceArtifactRecord[]; nameOf: NameOf; t: T }) {
  if (artifacts.length === 0) return <Empty text={t('files.empty')} />
  return (
    <div className={css.list}>
      {artifacts.map((artifact) => {
        const versions = [...artifact.versions].sort((left, right) => right.version - left.version)
        const latest = versions[0]
        return (
          <article key={artifact.artifactId} className={css.card} data-artifact={artifact.artifactId}>
            <div className={css.cardTitle}>
              <strong className={css.fileName}>{latest?.name ?? artifact.artifactId}</strong>
              <span className={css.state}>{t('files.versions', { count: versions.length })}</span>
            </div>
            <ul className={css.versions}>
              {versions.map(version => (
                <li key={version.version}>
                  <span>{t('files.version', { version: version.version })}</span>
                  {version.version === artifact.latestVersion && <Tag tone="info" className={css.tag}>{t('files.latest')}</Tag>}
                  <span>{fileSizeText(version.bytes)}</span>
                  <span>{t('files.author', { name: nameOf(version.authorSessionId) })}</span>
                  <code className={css.digest} title={version.digest}>{version.digest.replace(/^sha256:/u, '').slice(0, 12)}</code>
                </li>
              ))}
            </ul>
          </article>
        )
      })}
    </div>
  )
}
