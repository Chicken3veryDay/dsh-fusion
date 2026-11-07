/** Closed attempt lifecycle: the execution owner's phases, the durable command rules, and their only transition functions. */

import type { TicketAttemptSnapshot } from './types.ts'

/** Observed producer outcome handed to the settlement ledger. */
export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled'

/** One execution-owned attempt, from reservation to its hand-off to the settlement ledger.
 *
 * `aborted` is the only cancellation predicate before publication; `cancel` is the sticky intent to cancel once producers
 * may exist. `captured` is the outcome the producers reported before their resource release failed; once present it is
 * final. `handed` and `released` are terminal: the execution reservation is dropped on entry to either.
 */
export type AttemptState =
  | { readonly kind: 'admitting'; readonly aborted: boolean }
  | { readonly kind: 'unflushed' }
  | { readonly kind: 'preparing'; readonly aborted: boolean }
  | { readonly kind: 'worktree'; readonly aborted: boolean }
  | { readonly kind: 'activating'; readonly aborted: boolean }
  | { readonly kind: 'launched'; readonly aborted: boolean }
  | { readonly kind: 'running' }
  | { readonly kind: 'stopping'; readonly cancel: boolean; readonly captured?: AttemptOutcome }
  | { readonly kind: 'unknown'; readonly cancel: boolean; readonly captured?: AttemptOutcome }
  | { readonly kind: 'uncertain' }
  | { readonly kind: 'handed'; readonly outcome: AttemptOutcome }
  | { readonly kind: 'released' }

/** Every event the execution owner observes for one attempt. */
export type AttemptEvent =
  | { readonly type: 'caller-abort' }
  | { readonly type: 'owner-disposed' }
  | { readonly type: 'teardown' }
  | { readonly type: 'admitted' }
  | { readonly type: 'admission-unflushed' }
  | { readonly type: 'admission-refused' }
  | { readonly type: 'retry' }
  | { readonly type: 'worktree-start' }
  | { readonly type: 'activation-start' }
  | { readonly type: 'effect-established' }
  | { readonly type: 'effect-refused' }
  | { readonly type: 'effect-failed' }
  | { readonly type: 'stage-failed' }
  | { readonly type: 'publish' }
  | { readonly type: 'settle' }
  | { readonly type: 'dispose' }
  | { readonly type: 'producers-settled'; readonly outcome: AttemptOutcome }
  | { readonly type: 'cleanup-failed'; readonly outcome: AttemptOutcome }
  | { readonly type: 'stop-failed' }
  | { readonly type: 'cancel-failed' }
  | { readonly type: 'reconciled' }

/** Event names in specification order. */
export const attemptEventTypes = [
  'caller-abort', 'owner-disposed', 'teardown', 'admitted', 'admission-unflushed', 'admission-refused', 'retry',
  'worktree-start', 'activation-start', 'effect-established', 'effect-refused', 'effect-failed', 'stage-failed', 'publish', 'settle',
  'dispose', 'producers-settled', 'cleanup-failed', 'stop-failed', 'cancel-failed', 'reconciled',
] as const satisfies readonly AttemptEvent['type'][]

/** State names in specification order. */
export const attemptStateKinds = [
  'admitting', 'unflushed', 'preparing', 'worktree', 'activating', 'launched', 'running', 'stopping', 'unknown', 'uncertain',
  'handed', 'released',
] as const satisfies readonly AttemptState['kind'][]

/** A pair with no transition; the caller receives `TICKET_ATTEMPT_STATE`. */
export interface AttemptRejection {
  readonly kind: 'rejected'
  readonly reason: string
}

/** Whether preparation must end as cancelled at its next forward step.
 * @param state - Current phase.
 * @returns Whether the phase carries the aborted flag.
 */
export function isAborted(state: AttemptState): boolean {
  return 'aborted' in state && state.aborted
}

/** Whether the execution owner no longer holds the attempt.
 * @param state - Current phase.
 * @returns Whether the phase is `handed` or `released`.
 */
export function isTerminal(state: AttemptState): boolean {
  return state.kind === 'handed' || state.kind === 'released'
}

function assertNever(value: never): never {
  throw new Error(`Unhandled attempt lifecycle value: ${JSON.stringify(value)}`)
}

const reject = (state: AttemptState, event: AttemptEvent): AttemptRejection =>
  ({ kind: 'rejected', reason: `Ticket attempt in ${state.kind} cannot accept ${event.type}` })

/** Outcome of a preparation that ends before any producer starts. */
const unstarted = (aborted: boolean): AttemptState => ({ kind: 'handed', outcome: aborted ? 'cancelled' : 'failed' })

/** Outcome the producers' report yields under the intent: a cancel intent turns any outcome other than `failed` into `cancelled`. */
const underIntent = (cancel: boolean, outcome: AttemptOutcome): AttemptOutcome => cancel && outcome !== 'failed' ? 'cancelled' : outcome

/** A stop phase carrying the intent and any captured outcome forward. */
const stopPhase = <K extends 'stopping' | 'unknown'>(kind: K, cancel: boolean, captured: AttemptOutcome | undefined) =>
  captured === undefined ? { kind, cancel } : { kind, cancel, captured }

/** The single transition function of the execution-owned attempt lifecycle.
 * @param state - Current phase.
 * @param event - Observed event.
 * @returns The next phase, or a rejection for a pair with no transition.
 */
export function transitionAttempt(state: AttemptState, event: AttemptEvent): AttemptState | AttemptRejection {
  switch (state.kind) {
    case 'admitting':
    case 'preparing':
    case 'worktree':
    case 'activating':
    case 'launched':
      return transitionPreparation(state, event)
    case 'unflushed':
      switch (event.type) {
        case 'caller-abort': return state
        case 'owner-disposed':
        case 'teardown': return { kind: 'handed', outcome: 'cancelled' }
        case 'retry': return { kind: 'admitting', aborted: false }
        default: return reject(state, event)
      }
    case 'running':
      switch (event.type) {
        case 'caller-abort':
        case 'retry':
        // A producer that refused one cancellation request keeps running; only its own settlement signal ends it.
        case 'cancel-failed': return state
        case 'owner-disposed':
        case 'teardown':
        case 'dispose': return { kind: 'stopping', cancel: true }
        case 'settle': return { kind: 'stopping', cancel: false }
        default: return reject(state, event)
      }
    case 'stopping':
      switch (event.type) {
        case 'caller-abort':
        case 'retry':
        case 'settle':
        // The current stop fails; it alone knows whether a result was captured, so it chooses `stop-failed` or `cleanup-failed`.
        case 'cancel-failed': return state
        case 'owner-disposed':
        case 'teardown':
        case 'dispose': return stopPhase('stopping', true, state.captured)
        // Results and resource release are both proven; a captured outcome predates any later cancel intent.
        case 'producers-settled': return { kind: 'handed', outcome: state.captured ?? underIntent(state.cancel, event.outcome) }
        // Results are known but release is not: the outcome is kept and the reservation stays.
        case 'cleanup-failed': return stopPhase('unknown', state.cancel, state.captured ?? underIntent(state.cancel, event.outcome))
        case 'stop-failed': return stopPhase('unknown', state.cancel, state.captured)
        default: return reject(state, event)
      }
    case 'unknown':
      switch (event.type) {
        case 'caller-abort':
        case 'retry':
        case 'owner-disposed':
        case 'cancel-failed': return state
        case 'teardown':
        case 'dispose': return stopPhase('stopping', true, state.captured)
        case 'settle': return stopPhase('stopping', state.cancel, state.captured)
        // A host caller recorded the outcome with `settleAttempt`, which vouches that the producers ended.
        case 'reconciled': return { kind: 'released' }
        default: return reject(state, event)
      }
    case 'uncertain':
      switch (event.type) {
        case 'caller-abort':
        case 'owner-disposed':
        case 'teardown':
        case 'retry': return state
        case 'reconciled': return { kind: 'released' }
        default: return reject(state, event)
      }
    case 'handed':
      switch (event.type) {
        case 'caller-abort':
        case 'owner-disposed':
        case 'teardown':
        case 'retry':
        case 'settle':
        case 'dispose':
        // A cancellation request sent before the hand-off may fail after it; the producers' outcome is already known.
        case 'cancel-failed': return state
        default: return reject(state, event)
      }
    case 'released':
      switch (event.type) {
        case 'caller-abort':
        case 'owner-disposed':
        case 'teardown':
        case 'cancel-failed': return state
        default: return reject(state, event)
      }
    default: return assertNever(state)
  }
}

type PreparationState = Extract<AttemptState, { readonly aborted: boolean }>

function transitionPreparation(state: PreparationState, event: AttemptEvent): AttemptState | AttemptRejection {
  switch (event.type) {
    case 'caller-abort':
    case 'owner-disposed':
    case 'teardown': return { ...state, aborted: true }
    case 'retry': return state
    case 'admitted':
      if (state.kind !== 'admitting') return reject(state, event)
      return state.aborted ? { kind: 'handed', outcome: 'cancelled' } : { kind: 'preparing', aborted: false }
    case 'admission-unflushed':
      if (state.kind !== 'admitting') return reject(state, event)
      return state.aborted ? { kind: 'handed', outcome: 'cancelled' } : { kind: 'unflushed' }
    case 'admission-refused':
      return state.kind === 'admitting' ? { kind: 'released' } : reject(state, event)
    case 'worktree-start':
    case 'activation-start':
      if (state.kind !== 'preparing') return reject(state, event)
      if (state.aborted) return unstarted(true)
      return { kind: event.type === 'worktree-start' ? 'worktree' : 'activating', aborted: false }
    case 'effect-established':
      if (state.kind === 'worktree') return state.aborted ? unstarted(true) : { kind: 'preparing', aborted: false }
      if (state.kind === 'activating') return state.aborted ? { kind: 'stopping', cancel: true } : { kind: 'launched', aborted: false }
      return reject(state, event)
    case 'effect-refused':
      // The Subagent seam certifies that a rejected start left no child: the provider cleaned up and any rollback succeeded.
      return state.kind === 'activating' ? unstarted(state.aborted) : reject(state, event)
    case 'effect-failed':
      // A Worktree provider may have created the checkout before failing; a failed Subagent rollback may leave a live child.
      return state.kind === 'worktree' || state.kind === 'activating' ? { kind: 'uncertain' } : reject(state, event)
    case 'stage-failed':
      if (state.kind === 'preparing') return unstarted(state.aborted)
      if (state.kind === 'launched') return { kind: 'stopping', cancel: true }
      return reject(state, event)
    case 'publish':
      if (state.kind === 'preparing') return state.aborted ? unstarted(true) : { kind: 'running' }
      if (state.kind === 'launched') return state.aborted ? { kind: 'stopping', cancel: true } : { kind: 'running' }
      return reject(state, event)
    case 'settle':
    case 'dispose':
    case 'producers-settled':
    case 'cleanup-failed':
    case 'stop-failed':
    // No producer handle exists before publication, apart from an activation whose release the stop observes.
    case 'cancel-failed':
    case 'reconciled': return reject(state, event)
    default: return assertNever(event)
  }
}

/** Durable execution stages that record an attempt as `unknown` without settling it: `stop-unknown` after `stop-failed`,
 * `cleanup-unknown` after `cleanup-failed`. */
export const uncertaintyStages = ['stop-unknown', 'cleanup-unknown'] as const

/** One durable uncertainty stage. */
export type UncertaintyStage = typeof uncertaintyStages[number]

/** The diagnostic an uncertainty stage writes. It is fixed for one attempt, so a repeated write is an idempotent retry.
 * @param stage - Uncertainty stage.
 * @param captured - Outcome the producers reported before their release failed; required for `cleanup-unknown`.
 * @returns Diagnostic text.
 */
export function uncertaintyDiagnostic(stage: UncertaintyStage, captured?: AttemptOutcome): string {
  switch (stage) {
    case 'stop-unknown': return 'Cancellation did not establish producer settlement; reservation retained'
    case 'cleanup-unknown': return `Producers reported ${captured ?? 'succeeded'}, but releasing their resources was not confirmed; reservation retained`
    default: return assertNever(stage)
  }
}

/** Ticket commands whose admission depends on an assignment's current attempt. */
export type AttemptCommand = 'end-ticket' | 'release' | 'report-progress' | 'report-failure' | 'report-result'

/** Command names in specification order. */
export const attemptCommands = ['end-ticket', 'release', 'report-progress', 'report-failure', 'report-result'] as const satisfies readonly AttemptCommand[]

/** Durable attempt status as Ticket commands see it. */
export type DurableAttemptStatus =
  | Exclude<TicketAttemptSnapshot['status'], 'settled'>
  | `settled:${AttemptOutcome}`

/** Durable statuses in specification order. */
export const durableAttemptStatuses = [
  'preparing', 'running', 'stopping', 'unknown', 'settled:succeeded', 'settled:failed', 'settled:cancelled',
] as const satisfies readonly DurableAttemptStatus[]

/** Read the durable status of one attempt snapshot.
 * @param attempt - Committed attempt.
 * @returns Status with the settled outcome folded in.
 */
export function durableAttemptStatus(attempt: TicketAttemptSnapshot): DurableAttemptStatus {
  return attempt.status === 'settled' ? `settled:${attempt.outcome}` : attempt.status
}

/** Decide whether a Ticket command may proceed against an attempt. Command admission and replay read the same rule.
 * @param status - Durable status of the relevant attempt.
 * @param command - Ticket command.
 * @returns `allowed`, or the reason the command is refused with `TICKET_ATTEMPT_STATE`.
 */
export function attemptAdmitsCommand(status: DurableAttemptStatus, command: AttemptCommand): 'allowed' | AttemptRejection {
  const settled = status === 'settled:succeeded' || status === 'settled:failed' || status === 'settled:cancelled'
  switch (command) {
    case 'end-ticket':
    case 'release':
      return settled ? 'allowed' : { kind: 'rejected', reason: 'settle the attempt first' }
    case 'report-progress':
    case 'report-failure':
      return settled ? { kind: 'rejected', reason: 'settled attempt cannot report progress or failure' } : 'allowed'
    case 'report-result':
      return settled && status !== 'settled:succeeded'
        ? { kind: 'rejected', reason: 'a failed or cancelled attempt cannot report a result' } : 'allowed'
    default: return assertNever(command)
  }
}

function describeState(state: AttemptState): string {
  switch (state.kind) {
    case 'admitting':
    case 'preparing':
    case 'worktree':
    case 'activating':
    case 'launched': return state.aborted ? `${state.kind}(aborted)` : state.kind
    case 'stopping':
    case 'unknown': return `${state.kind}(${state.cancel ? 'cancel' : 'natural'}${state.captured === undefined ? '' : `; ${state.captured}`})`
    case 'handed': return `handed(${state.outcome})`
    case 'unflushed':
    case 'running':
    case 'uncertain':
    case 'released': return state.kind
    default: return assertNever(state)
  }
}

function variants(kind: AttemptState['kind']): { readonly label: string; readonly state: AttemptState }[] {
  switch (kind) {
    case 'admitting':
    case 'preparing':
    case 'worktree':
    case 'activating':
    case 'launched':
      return [{ label: '', state: { kind, aborted: false } }, { label: 'aborted', state: { kind, aborted: true } }]
    case 'stopping':
    case 'unknown':
      return [{ label: 'natural', state: { kind, cancel: false } }, { label: 'cancel', state: { kind, cancel: true } },
        { label: 'captured', state: { kind, cancel: false, captured: 'succeeded' } }]
    case 'handed': return [{ label: '', state: { kind, outcome: 'succeeded' } }]
    case 'unflushed':
    case 'running':
    case 'uncertain':
    case 'released': return [{ label: '', state: { kind } }]
    default: return assertNever(kind)
  }
}

function sampleEvent(type: AttemptEvent['type']): AttemptEvent {
  return type === 'producers-settled' || type === 'cleanup-failed' ? { type, outcome: 'succeeded' } : { type }
}

/** Render one specification cell: `—` keeps the state, `✗` rejects, otherwise the next state per variant.
 * `producers-settled` and `cleanup-failed` are rendered for a succeeded report; cancel intent turns it into `cancelled`
 * unless it failed, and a captured outcome (rendered as `succeeded`) takes precedence over both.
 * @param kind - State name.
 * @param type - Event name.
 * @returns Cell text.
 */
export function describeAttemptTransition(kind: AttemptState['kind'], type: AttemptEvent['type']): string {
  const cells = variants(kind).map(({ label, state }) => {
    const next = transitionAttempt(state, sampleEvent(type))
    const text = 'reason' in next ? '✗' : describeState(next) === describeState(state) ? '—' : describeState(next)
    return { label, text }
  })
  const [first] = cells
  if (first !== undefined && cells.every(cell => cell.text === first.text)) return first.text
  return cells.map(cell => cell.label === '' ? cell.text : `${cell.label}: ${cell.text}`).join('; ')
}

/** Render the attempt specification table that the package README carries verbatim.
 * @returns Markdown table with one row per state and one column per event.
 */
export function renderAttemptTable(): string {
  const header = `| State | ${attemptEventTypes.map(type => `\`${type}\``).join(' | ')} |`
  const rule = `|${'---|'.repeat(attemptEventTypes.length + 1)}`
  const rows = attemptStateKinds.map(kind => `| \`${kind}\` | ${attemptEventTypes.map(type => describeAttemptTransition(kind, type)).join(' | ')} |`)
  return [header, rule, ...rows].join('\n')
}

/** Render the command-admission table that the package README carries verbatim.
 * @returns Markdown table with one row per durable status and one column per command.
 */
export function renderCommandTable(): string {
  const header = `| Attempt status | ${attemptCommands.map(command => `\`${command}\``).join(' | ')} |`
  const rule = `|${'---|'.repeat(attemptCommands.length + 1)}`
  const rows = durableAttemptStatuses.map(status => `| \`${status}\` | ${attemptCommands.map(command => attemptAdmitsCommand(status, command) === 'allowed' ? 'allowed' : '✗').join(' | ')} |`)
  return [header, rule, ...rows].join('\n')
}
