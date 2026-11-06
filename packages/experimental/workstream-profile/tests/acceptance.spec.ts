/**
 * First Workstream acceptance scenario through the real opt-in profile: a `dsh` process boots the
 * `@deepseek-ai/dsh-experimental-workstream-profile` bundle over the headless profile, and a scripted
 * model drives the lead and three Workstream members through the profile's model-visible tools. The
 * same scripts are the committed `workstream-acceptance` session snapshot, so this spec asserts the
 * durable end state that the keyless snapshot compares as a transcript.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { materializeProfilePatch } from '../../../test-support/session-snapshot/src/launcher.ts'

const dshBinScript = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const scenarioDir = join(repoRoot, 'snapshots/session/workstream-acceptance')
const defaultComposition = join(repoRoot, 'snapshots/session/text-turn')
const replayHead = fileURLToPath(new URL('./fixtures/replay-head.cordis.yml', import.meta.url))
const restartPlugin = pathToFileURL(fileURLToPath(new URL('./fixtures/restart-script-llm.mjs', import.meta.url))).href
const profilePatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const PROFILE = '@deepseek-ai/dsh-experimental-workstream-profile'
const TICKET = 'accept-ticket'

interface LogEvent { readonly type: string; readonly data?: unknown; readonly parentSession?: string; readonly id?: string }
interface Session { readonly id: string; readonly parent: string | undefined; readonly events: LogEvent[] }
interface TicketRecord {
  readonly id: string
  readonly revision: number
  readonly status: string
  readonly coordinatorId: string
  readonly currentCandidateId?: string
  readonly terminalOutcome?: { readonly kind: string; readonly actorId: string }
  readonly assignments: readonly { readonly id: string; readonly ownerId: string; readonly status: string }[]
  readonly reports: readonly { readonly assignmentId: string; readonly kind: string; readonly authorId: string }[]
  readonly candidates: readonly { readonly id: string; readonly authorId: string; readonly assignmentIds: readonly string[] }[]
  readonly checks: readonly {
    readonly candidateId: string
    readonly criterionId: string
    readonly outcome: string
    readonly authorId: string
  }[]
  readonly questions: readonly { readonly status: string }[]
}

async function sessionFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await sessionFiles(path))
    else if (entry.name === 'session.v4.jsonl') found.push(path)
  }
  return found
}

async function readSessions(home: string): Promise<Session[]> {
  return await Promise.all((await sessionFiles(join(home, 'sessions'))).map(async (file) => {
    const events = (await readFile(file, 'utf8')).split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as LogEvent)
    const header = events[0]
    if (header?.type !== 'session' || header.id === undefined) throw new Error(`${file} has no session header`)
    return { id: header.id, parent: header.parentSession, events }
  }))
}

function scenarioTask(fixture: string): string {
  for (const line of fixture.split('\n')) {
    if (line.length === 0) continue
    const event = JSON.parse(line) as LogEvent
    if (event.type !== 'user/message') continue
    const content = (event.data as { content: { text: string }[] }).content
    return content[0]!.text
  }
  throw new Error('workstream-acceptance fixture has no user message')
}

/** Launch the profile with the scenario's scripted model and return the persisted sessions. */
async function runScenario(): Promise<{ sessions: Session[]; stdout: string; home: string; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-workstream-acceptance-'))
  const home = join(cwd, '.dsh')
  const profileDir = join(home, 'profiles', 'headless')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-headless',
    private: true,
    dependencies: { [PROFILE]: 'workspace:^' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', PROFILE] } },
  }, undefined, 2) + '\n')
  const patchRoot = join(cwd, '.snapshot-patches')
  await mkdir(patchRoot, { recursive: true })
  const patches = [join(defaultComposition, 'cordis.yml'), replayHead, join(defaultComposition, 'model.cordis.yml')]
    .map((source, index) => materializeProfilePatch(source, cwd, 'headless', patchRoot, index))
  const fixture = join(scenarioDir, 'session.v4.jsonl')
  const task = scenarioTask(await readFile(fixture, 'utf8'))
  const launch = resolveExampleLaunch({
    srcBin: dshBinScript,
    configArgs: ['--profile', 'headless', ...patches.flatMap(file => ['--patch', file]), task],
    tsconfigPath,
    env: {
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(cwd, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'snapshot-replay-key',
      DSH_SNAPSHOT: 'replay',
      DSH_SNAPSHOT_PROVIDER: 'deepseek-official',
      DSH_SNAPSHOT_MODEL: 'deepseek-v4-flash',
      DSH_SNAPSHOT_FILE: fixture,
      DSH_SNAPSHOT_CHILD_FILES: [1, 2, 3].map(index => join(scenarioDir, `session.${String(index)}.v4.jsonl`)).join(delimiter),
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        '--disable-warning=ExperimentalWarning',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      ].filter(Boolean).join(' '),
    },
  })
  const result = await execa(launch.command, launch.args, {
    cwd, env: launch.env, input: '', timeout: 180_000, killSignal: 'SIGKILL', reject: false,
  })
  expect(result.exitCode, `dsh exited unexpectedly.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
  return { sessions: await readSessions(home), stdout: result.stdout, home, cwd }
}

function latest<T>(events: readonly LogEvent[], type: string, pick: (data: never) => T): T[] {
  return events.filter(event => event.type === type).map(event => pick(event.data as never))
}

function toolErrors(events: readonly LogEvent[]): string[] {
  return latest(events, 'tool/result', (data: { message: { isError: boolean; content: { text: string }[] } }) => data.message)
    .filter(message => message.isError).map(message => message.content[0]!.text)
}

/** Reopen the lead Session in a second `dsh` process whose scripted model issues `script`, and return its tool results. */
async function reopenLead(
  cwd: string, home: string, leadId: string, script: readonly { name: string; arguments: Record<string, unknown> }[],
): Promise<{ results: { id: string; isError: boolean; text: string }[]; stdout: string }> {
  await writeFile(join(home, 'profiles', 'headless', 'cordis.patch.yml'), [
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: '${join(home, 'sessions')}'`,
    '    compression: none',
    '- insert:',
    '    - id: workstream-restart-script-llm',
    `      name: '${restartPlugin}'`,
    '',
  ].join('\n'))
  const output = join(cwd, 'restart-results.json')
  const launch = resolveExampleLaunch({
    srcBin: dshBinScript,
    configArgs: ['--profile', 'headless', '--session-id', leadId, 'Reopen the Workstream and read its state.'],
    tsconfigPath,
    env: {
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(cwd, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'restart-replay-key',
      WORKSTREAM_RESTART_SCRIPT: JSON.stringify(script),
      WORKSTREAM_RESTART_OUT: output,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        '--disable-warning=ExperimentalWarning',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      ].filter(Boolean).join(' '),
    },
  })
  const result = await execa(launch.command, launch.args, {
    cwd, env: launch.env, input: '', timeout: 180_000, killSignal: 'SIGKILL', reject: false,
  })
  expect(result.exitCode, `restart dsh exited unexpectedly.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
  return { results: JSON.parse(await readFile(output, 'utf8')) as never, stdout: result.stdout }
}

async function sessionLogs(home: string): Promise<Map<string, string>> {
  const logs = new Map<string, string>()
  for (const file of await sessionFiles(join(home, 'sessions'))) logs.set(file, await readFile(file, 'utf8'))
  return logs
}

describe('Workstream first acceptance scenario through the opt-in profile', () => {
  it('keeps the snapshot composition identical to the profile layer', async () => {
    const snapshotPatch = await readFile(join(scenarioDir, 'cordis.snapshot.yml'), 'utf8')
    const layer = await readFile(profilePatch, 'utf8')
    expect(await readFile(join(scenarioDir, 'cordis.yml'), 'utf8')).toBe(layer)
    expect(snapshotPatch).toBe(`${await readFile(replayHead, 'utf8')}\n${layer}`)
  })

  it('drives two contributors, a rejected first candidate, a repair, a coordinator change, and acceptance', async () => {
    const { sessions, stdout, cwd } = await runScenario()
    try {
      expect(stdout).toContain('WORKSTREAM_ACCEPTANCE_OK')
      const lead = sessions.find(session => session.parent === undefined)
      const members = sessions.filter(session => session.parent !== undefined)
      expect(lead).toBeDefined()
      expect(members).toHaveLength(3)

      // The owner stays the runtime parent of every member, even though a member coordinates at the end.
      for (const member of members) {
        expect(member.parent).toBe(lead!.id)
      }

      const states = latest(lead!.events, 'ticket/state', (data: { ticket: TicketRecord & { id: string } }) => data.ticket)
        .filter(ticket => ticket.id === TICKET)
      const ticket = states.at(-1)!
      const validator = ticket.coordinatorId
      expect(validator).not.toBe(lead!.id)
      expect(members.map(member => member.id)).toContain(validator)

      // Final Ticket: accepted with the repaired candidate by the new coordinator.
      expect(ticket).toMatchObject({ status: 'completed', currentCandidateId: 'cand-2' })
      expect(ticket.terminalOutcome).toMatchObject({ kind: 'completed', actorId: validator })

      // Both writers' contributions are present, and the repair is a third required assignment.
      const writers = [...new Set(ticket.assignments.map(assignment => assignment.ownerId))]
      expect(writers).toHaveLength(2)
      expect(ticket.assignments.every(assignment => assignment.status === 'completed')).toBe(true)
      expect(ticket.reports.filter(report => report.kind === 'result').map(report => report.authorId).sort())
        .toEqual([...ticket.assignments.map(assignment => assignment.ownerId)].sort())
      const repaired = ticket.candidates.find(candidate => candidate.id === 'cand-2')!
      expect(repaired.assignmentIds).toEqual(ticket.assignments.map(assignment => assignment.id))

      // The rejected first candidate and its failing independent check stay in history.
      expect(ticket.candidates.map(candidate => candidate.id)).toEqual(['cand-1', 'cand-2'])
      expect(ticket.checks.filter(check => check.candidateId === 'cand-1').map(check => `${check.criterionId}:${check.outcome}`))
        .toEqual(['built:pass', 'validated:fail'])
      expect(ticket.checks.filter(check => check.candidateId === 'cand-2').map(check => `${check.criterionId}:${check.outcome}`))
        .toEqual(['built:pass', 'validated:pass', 'integrated:pass'])
      expect(ticket.checks.every(check => check.authorId === validator)).toBe(true)
      expect(writers).not.toContain(validator)
      expect(ticket.questions.map(question => question.status)).toEqual(['answered'])

      // The coordinator change is recorded in the Workstream log; the owner never changes.
      const workstreams = latest(lead!.events, 'workstream/state', (data: { snapshot: { ownerSessionId: string; coordinatorId: string } }) => data.snapshot)
      expect(new Set(workstreams.map(snapshot => snapshot.ownerSessionId))).toEqual(new Set([lead!.id]))
      expect(workstreams.map(snapshot => snapshot.coordinatorId).filter((id, index, all) => id !== all[index - 1]))
        .toEqual([lead!.id, validator])

      // Negative cases the scripted run exercises on purpose.
      const errors = toolErrors(lead!.events).concat(...members.map(member => toolErrors(member.events)))
      expect(errors).toContain('Error: criterion "validated" requires a passing current check')
      expect(errors).toContain('Error: check candidate or specification is stale')
      expect(errors).toHaveLength(2)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 300_000)

  it('reopens the lead Session in a second process: the accepted Ticket and coordinator replay, and stale commands append nothing', async () => {
    const { sessions, cwd, home } = await runScenario()
    try {
      const lead = sessions.find(session => session.parent === undefined)!
      const before = await sessionLogs(home)
      const finalState = latest(lead.events, 'ticket/state', (data: { ticket: TicketRecord }) => data.ticket).filter(ticket => ticket.id === TICKET).at(-1)!
      const common = { root_session_id: lead.id }
      const { results, stdout } = await reopenLead(cwd, home, lead.id, [
        { name: 'ticket_get', arguments: { ...common, ticket_id: TICKET } },
        { name: 'workstream_get', arguments: common },
        { name: 'ticket_complete', arguments: { ...common, ticket_id: TICKET, expected_revision: finalState.revision, summary: 'Accept again' } },
        { name: 'ticket_complete', arguments: { ...common, ticket_id: TICKET, expected_revision: 1, summary: 'Accept from a stale read' } },
      ])
      expect(stdout).toContain('WORKSTREAM_RESTART_OK')
      expect(results.map(result => result.isError)).toEqual([false, false, true, true])
      const restored = JSON.parse(results[0]!.text) as TicketRecord
      expect(restored).toMatchObject({ status: 'completed', currentCandidateId: 'cand-2', coordinatorId: finalState.coordinatorId, revision: finalState.revision })
      expect(restored.candidates.map(candidate => candidate.id)).toEqual(['cand-1', 'cand-2'])
      expect(JSON.parse(results[1]!.text)).toMatchObject({ ownerSessionId: lead.id, coordinatorId: finalState.coordinatorId })

      // The reopened Session only appended its own turn; the rejected commands wrote no Ticket or Workstream state.
      const after = await sessionLogs(home)
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
      const leadFile = [...before.keys()].find(file => before.get(file)!.includes(`"id":"${lead.id}"`) && !before.get(file)!.includes('"parentSession"'))!
      expect(after.get(leadFile)!.startsWith(before.get(leadFile)!)).toBe(true)
      const appended = after.get(leadFile)!.slice(before.get(leadFile)!.length).split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as LogEvent)
      expect(appended.some(event => event.type === 'turn/start')).toBe(true)
      expect(appended.filter(event => event.type === 'ticket/state' || event.type === 'workstream/state')).toEqual([])
      for (const file of before.keys()) if (file !== leadFile) expect(after.get(file), `${file} was rewritten by the reopened process`).toBe(before.get(file))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 420_000)
})

describe('Workstream acceptance negative cases are covered by named tests', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const covered: readonly (readonly [string, string, string])[] = [
    ['stale attempts', 'ticket/tests/tools.spec.ts', 'names the active attempt when a worker reports through ticket_report'],
    ['invalid command append', 'ticket/tests/ticket.spec.ts', 'rejects a proposed-to-completed transition before appending'],
    ['invalid command append', 'ticket/tests/ticket.spec.ts', 'rejects schema failures without poisoning later valid commands'],
    ['duplicate delivery', 'workstream/tests/workstream.spec.ts', 'provisions two real members, deduplicates peer delivery and preserves parent on handoff'],
    ['duplicate delivery', 'workstream/tests/workstream.spec.ts', 'retains uncertain delivery after interrupted target acceptance and never sends twice'],
    ['nonsettled cancellation', 'ticket/tests/tools.spec.ts', 'refuses a terminal outcome while an attempt is unsettled and accepts cancellation once it settles'],
    ['nonsettled cancellation', 'ticket/tests/execution.spec.ts', 'claims a direct worker attempt, owns Jobs, and settles then releases on cleanup'],
    ['write-scope escalation', 'ticket/tests/ticket.spec.ts', 'normalizes relative scopes and rejects traversal and write escalation'],
    ['stale candidate checks', 'ticket/tests/tools.spec.ts', 'drives specification, candidate, and independent check tools with caller authority and stale rejection'],
    ['restart during an attempt (host-driven)', 'ticket/tests/execution.spec.ts', 'keeps an unknown attempt through host-driven service replacement and never dispatches it again'],
  ]

  it.each(covered)('%s: %s "%s" exists', async (_case, file, title) => {
    expect(await readFile(join(root, file), 'utf8')).toContain(`it('${title}'`)
  })
})
