// Keyless shipped-Web acceptance for the durable workflow Conversation Node.
// Authored model output calls the real workflow through the default Script SDK.
// The worker, local child, persistence, browser graph, and navigation stay real.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizedSystemPrompts, normalizedToolSchemas,
  normalizeSessionSnapshots, reconcileCatalogCreationTimes, redactSessionSnapshotIds,
  refreshFixtureReplacements, scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import type { WorkflowAgentInfo, WorkflowResultInfo, WorkflowRunInfo } from '@deepseek-ai/dsh-workflow'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, normalizeWebSessionVolatiles, rawSessionLog, readPersistedEvents,
  selectedSessionFixture, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, expandOwningTurnProcess, expandTurnProcesses, newEnglishPage, REPO_ROOT, saveFailureShot,
} from './support.ts'

const EVIDENCE = join(REPO_ROOT, '.artifacts/workflow-run-script')
const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/workflow-run-script', import.meta.url))
const EXPECTED_DIR = fileURLToPath(new URL('./expected/workflow-run-script/', import.meta.url))
const UI_LIVE_EXPECTED = join(EXPECTED_DIR, 'ui-live.expected.md')
const UI_EXPECTED = join(EXPECTED_DIR, 'ui.expected.md')
const PARENT_FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const CHILD_FIXTURE = join(SNAPSHOT_DIR, 'session.1.v4.jsonl')
const CHILD_PROMPT = 'Reply with exactly the word WF_CHILD_OK and nothing else.'

type ObservedWorkflowEvent =
  | { type: 'workflow/start'; info: WorkflowRunInfo }
  | { type: 'workflow/agent-start'; info: WorkflowRunInfo; child: WorkflowAgentInfo }
  | { type: 'workflow/end'; info: WorkflowRunInfo; result: WorkflowResultInfo }

describe.skipIf(MODE === 'record')('web e2e: durable workflow run in Chat', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let prompt: string
  const releaseChild = Promise.withResolvers<undefined>()
  const childEntered = Promise.withResolvers<Session | undefined>()
  const sessions: Session[] = []
  const workflowEvents: ObservedWorkflowEvent[] = []
  let parent: Session
  let stopStreams = (): void => {}
  let stopSessions = (): void => {}
  let stopSettlement = (): void => {}
  let finishSettlement = (): void => {}
  let selectedParent: string
  let selectedChild: string

  const waitForParentSettlement = (): Promise<SessionId | undefined> => {
    const boundary = Promise.withResolvers<SessionId | undefined>()
    finishSettlement = () => { boundary.resolve(undefined) }
    stopSettlement = scaffold.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end' || session.id !== parent.id) return
      stopSettlement()
      boundary.resolve(session.id)
    })
    return boundary.promise.then(async (id) => {
      if (id === undefined) return undefined
      await scaffold.ctx.agents.get(id)?.whenIdle()
      await scaffold.ctx.sessions.flush(parent)
      return id
    })
  }

  const captureSessions = async (checkpoint: string): Promise<void> => {
    await writeFile(join(EVIDENCE, `${checkpoint}-sessions.json`), JSON.stringify({
      workflowEvents,
      sessions: sessions.map(session => ({ header: session.header, events: session.snapshotEvents() })),
    }, null, 2))
    for (const [index, session] of sessions.entries()) {
      await writeFile(join(EVIDENCE, `${checkpoint}-session-${index}.jsonl`), rawSessionLog(session))
    }
  }

  const compareFamily = async (): Promise<void> => {
    expect(sessions).toHaveLength(2)
    const child = sessions[1]!
    expect(child.header.parentSession).toBe(parent.id)
    expect(child.header.origin).toBe('subagent')
    expect(sessions.map(session => session.header.version)).toEqual([4, 4])
    const paths = [selectedParent, selectedChild]
    let expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
    const actual = sessions.map(session => normalizeWebSessionVolatiles(rawSessionLog(session), parent.header.cwd))
    const context = { sessionIds: sessions.map(session => String(session.id)), cwd: parent.header.cwd! }
    if (MODE === 'refresh') {
      const harvested = sessions.map((session, index) => ({
        id: String(session.id), createdAt: session.header.createdAt, content: actual[index]!,
        ...session.header.parentSession === undefined ? {} : { parentSession: String(session.header.parentSession) },
      }))
      const replacements = refreshFixtureReplacements(harvested, expected)
      const fresh = actual.map((log, index) => scrubSessionSnapshot(prepareSessionSnapshotFixtureForComparison(
        tokenizeSessionFixtureCwd(stabilizeRefreshLog(log, expected[index]!, replacements, context)),
      )))
      expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds(
        reconcileCatalogCreationTimes(fresh, 'preserve-headers'), expected,
      ))
      await Promise.all(paths.map((path, index) => writeFile(path, expected[index]!)))
    }
    expect(normalizeSessionSnapshots(actual, context)).toEqual(normalizeSessionSnapshots(expected, {
      sessionIds: [], cwd: '{{cwd}}',
    }))
    const prompts = normalizedSystemPrompts(actual[0]!, context).map(value => value
      .split(REPO_ROOT).join('{{sourceRoot}}')
      .split(new URL(scaffold.authenticatedUrl).origin).join('{{webUrl}}'))
    const schemas = normalizedToolSchemas(actual[0]!, context)
    expect(schemas[0]!.map(schema => schema !== null && typeof schema === 'object' && 'name' in schema ? schema.name : undefined))
      .toEqual(['run_code'])
    const pins = [
      ['system-prompt.expected.md', formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))],
      ['tool-schemas.expected.json', formatToolSchemasSnapshot(schemas[0]!, schemas.slice(1))],
    ] as const
    for (const [name, content] of pins) {
      const path = join(SNAPSHOT_DIR, name)
      if (MODE === 'refresh') await writeFile(path, content)
      expect(await readFile(path, 'utf8'), name).toBe(content)
    }

    const starts = workflowEvents.filter(event => event.type === 'workflow/start')
    expect(starts).toHaveLength(1)
    const info = starts[0]!.info
    expect(workflowEvents.filter(event => event.type === 'workflow/end')).toEqual([
      { type: 'workflow/end', info, result: { stopReason: 'completed', agentsStarted: 1 } },
    ])
    expect(parent.snapshotEvents().filter(event => event.type.startsWith('tool-workflow/')).map(event => [event.type, event.data]))
      .toEqual([
        ['tool-workflow/run-start', { runId: info.id, name: 'snapshot-flow' }],
        ['tool-workflow/agent-start', {
          runId: info.id, seq: 1, label: 'Reply with exactly the word WF_CHILD_OK and not…', phase: 'Run', childId: child.id,
        }],
        ['tool-workflow/agent-end', { runId: info.id, seq: 1, outcome: 'completed' }],
        ['tool-workflow/run-end', { runId: info.id, stopReason: 'completed' }],
      ])
    expect(child.snapshotEvents().filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content))
      .toContainEqual({ type: 'text', text: 'WF_CHILD_OK' })
  }

  beforeAll(async () => {
    await mkdir(EVIDENCE, { recursive: true })
    selectedParent = await selectedSessionFixture(PARENT_FIXTURE)
    selectedChild = await selectedSessionFixture(CHILD_FIXTURE)
    const prompts = fixtureUserPrompts(await readFile(selectedParent, 'utf8'))
    expect(prompts).toHaveLength(1)
    prompt = prompts[0]!
    scaffold = await launchWebScaffold({
      replayFixture: selectedParent,
      replayChildFixtures: [selectedChild],
      // Complete family comparison below replaces the scaffold's parent-only comparison and preserves child identity.
      compareReplaySession: false,
    })
    stopSessions = scaffold.ctx.on('session/created', (session) => { sessions.push(session) })
    scaffold.ctx.on('workflow/start', (info) => { workflowEvents.push({ type: 'workflow/start', info }) })
    scaffold.ctx.on('workflow/agent-start', (info, child) => { workflowEvents.push({ type: 'workflow/agent-start', info, child }) })
    scaffold.ctx.on('workflow/end', (info, result) => { workflowEvents.push({ type: 'workflow/end', info, result }) })
    // Keep the live child available throughout disclosure, layout, and navigation checks.
    stopStreams = scaffold.ctx.on('llm/stream', async function* (options, next) {
      const session = options.sessionId === undefined ? undefined : scaffold.ctx.sessions.get(options.sessionId)
      if (session?.header.parentSession === parent?.id) {
        childEntered.resolve(session)
        await releaseChild.promise
      }
      yield* next()
    }, { prepend: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    expect(sessions).toHaveLength(1)
    parent = sessions[0]!
    scaffold.ctx.permissionPresets.set(parent, 'danger-full-access')
  }, 120_000)

  afterAll(async () => {
    releaseChild.resolve(undefined)
    childEntered.resolve(undefined)
    stopStreams()
    stopSessions()
    stopSettlement()
    finishSettlement()
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the live member, opens its local child, then retains the settled record beside the tool row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workflow-run-live'))
    const settled = waitForParentSettlement()
    onTestFinished(async () => {
      releaseChild.resolve(undefined)
      childEntered.resolve(undefined)
      try {
        await scaffold.ctx.agents.get(parent.id)?.whenIdle()
        finishSettlement()
        await settled
        for (const session of sessions) {
          if (scaffold.ctx.sessions.get(session.id) === session) await scaffold.ctx.sessions.flush(session)
          expect(await readPersistedEvents(scaffold, session.id)).toEqual(session.snapshotEvents())
        }
        await captureSessions('settled')
        await page.getByText('WORKFLOW_DONE', { exact: true }).waitFor()
        await expandTurnProcesses(page)
        await page.screenshot({ path: join(EVIDENCE, 'settled.png'), fullPage: true })
      } finally {
        stopSettlement()
        finishSettlement()
      }
    })
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompt)
    await input.press('Enter')

    const child = await childEntered.promise
    expect(child?.header.parentSession).toBe(parent.id)
    expect(workflowEvents.filter(event => event.type === 'workflow/agent-start')).toHaveLength(1)
    await captureSessions('active')
    await page.locator('[data-chat-flow-kind="tool-call"]').first().waitFor({ state: 'attached' })

    expect(parent.snapshotEvents().filter(event => event.type === 'tool-workflow/run-start'),
      'a real Script SDK workflow must publish its durable run-start').toHaveLength(1)
    const workflow = page.locator('[data-workflow-run][data-run-status="running"]')
    await expandOwningTurnProcess(page, workflow)
    await workflow.waitFor({ timeout: 30_000 })
    const disclosures = workflow.locator('[data-disclosure-row]')
    await disclosures.nth(1).waitFor({ timeout: 15_000 })
    const runDisclosure = disclosures.nth(0)
    const phaseDisclosure = disclosures.nth(1)
    expect(await runDisclosure.getAttribute('role')).toBe('button')
    expect(await runDisclosure.getAttribute('aria-expanded')).toBe('true')
    expect(await phaseDisclosure.getAttribute('role')).toBe('button')
    expect(await phaseDisclosure.getAttribute('aria-expanded')).toBe('true')
    expect(await runDisclosure.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    expect(await phaseDisclosure.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    const member = page.getByRole('button', { name: /^Open Reply with exactly the word/ })
    await member.waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(EVIDENCE, 'active.png'), fullPage: true })

    await phaseDisclosure.click()
    expect(await phaseDisclosure.getAttribute('aria-expanded')).toBe('false')
    expect(await member.count()).toBe(0)
    const liveSnapshot = await captureStableAria(page, '[data-workflow-run]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_LIVE_EXPECTED, liveSnapshot, MODE)
    await phaseDisclosure.press('Enter')
    await member.waitFor()
    await runDisclosure.click()
    expect(await runDisclosure.getAttribute('aria-expanded')).toBe('false')
    expect(await disclosures.count()).toBe(1)
    await runDisclosure.press('Space')
    expect(await disclosures.count()).toBe(2)
    expect(await phaseDisclosure.getAttribute('aria-expanded')).toBe('true')
    const lightColor = await member.locator('[data-member-label]').evaluate(element => getComputedStyle(element).color)
    await page.setViewportSize({ width: 560, height: 800 })
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    // Exercise keyboard focus after the responsive layout has changed.
    await phaseDisclosure.focus()
    await phaseDisclosure.press('Tab')
    await expect.poll(() => member.evaluate(element => element.matches(':focus-visible'))).toBe(true)
    const darkNarrow = await page.locator('[data-workflow-run]').evaluate((element) => {
      const panel = element as HTMLElement
      panel.style.width = '356px'
      const label = element.querySelector('[data-member-label]')
      const labelWrap = element.querySelector('[data-member-label-wrap]')
      const status = element.querySelector('[data-member-status-text]')
      const disclosures = element.querySelectorAll('[data-disclosure-row]')
      const runHeader = disclosures[0]
      const phaseHeader = disclosures[1]
      const phaseTitle = phaseHeader?.querySelector('[class*="phaseTitle"]') as HTMLElement | null
      const phaseStatus = element.querySelector('[data-phase-status-text]')
      const originalPhaseTitle = phaseTitle?.textContent ?? ''
      if (phaseTitle !== null) phaseTitle.textContent = 'A phase name long enough to require ellipsis in the narrow layout'
      const phaseTitleRight = phaseTitle?.getBoundingClientRect().right ?? 0
      const phaseStatusLeft = phaseStatus?.getBoundingClientRect().left ?? 0
      if (phaseTitle !== null) phaseTitle.textContent = originalPhaseTitle
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        color: label === null ? '' : getComputedStyle(label).color,
        decoration: label === null ? '' : getComputedStyle(label).textDecorationLine,
        focusWidth: labelWrap === null ? '' : getComputedStyle(labelWrap).outlineWidth,
        statusWidth: status?.getBoundingClientRect().width ?? 0,
        statusFontSize: status === null ? '' : getComputedStyle(status).fontSize,
        runHeight: runHeader?.getBoundingClientRect().height ?? 0,
        phaseHeight: phaseHeader?.getBoundingClientRect().height ?? 0,
        phaseTitleRight,
        phaseStatusLeft,
      }
    })
    expect(darkNarrow.clientWidth).toBe(356)
    expect(darkNarrow.scrollWidth).toBeLessThanOrEqual(darkNarrow.clientWidth)
    expect(darkNarrow.color).not.toBe(lightColor)
    expect(darkNarrow.decoration).toContain('underline')
    expect(Number.parseFloat(darkNarrow.focusWidth)).toBeGreaterThanOrEqual(2)
    expect(darkNarrow.statusWidth).toBe(64)
    expect(darkNarrow.statusFontSize).toBe('13px')
    expect(darkNarrow.runHeight).toBe(32)
    expect(darkNarrow.phaseHeight).toBe(32)
    expect(darkNarrow.phaseTitleRight).toBeLessThanOrEqual(darkNarrow.phaseStatusLeft)
    await page.locator('[data-workflow-run]').evaluate((element) => {
      (element as HTMLElement).style.removeProperty('width')
      document.body.removeAttribute('data-ds-dark-theme')
    })
    await page.setViewportSize({ width: 1280, height: 800 })

    await member.click()
    await page.getByText(CHILD_PROMPT, { exact: true }).waitFor({ timeout: 15_000 })

    const sessionTree = page.getByRole('tree', { name: 'Sessions' })
    await sessionTree.getByRole('treeitem', { name: /Use run_code exactly once to/ }).click()
    releaseChild.resolve(undefined)
    expect(await settled).toBe(parent.id)
    await compareFamily()
    await expandTurnProcesses(page)
    await page.locator('[data-workflow-run][data-run-status="completed"]').waitFor()

    expect(await page.locator('[data-chat-flow-kind="tool-call"]').count()).toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-chat-flow-kind="workflow-run"]').count()).toBe(1)
    const terminalWorkflow = page.getByRole('button', { name: /^snapshot-flow/ })
    await terminalWorkflow.waitFor()
    expect(await terminalWorkflow.getAttribute('aria-expanded')).toBe('false')
    expect(await terminalWorkflow.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    await terminalWorkflow.click()
    const terminalPhase = page.locator('[data-workflow-run][data-run-status="completed"] [data-disclosure-row]').nth(1)
    await terminalPhase.waitFor()
    expect(await terminalPhase.getAttribute('aria-expanded')).toBe('false')
    expect(await terminalPhase.evaluate(element => getComputedStyle(element).cursor)).toBe('pointer')
    await terminalPhase.click()
    await page.getByText(CHILD_PROMPT, { exact: false }).waitFor()
    await expect.poll(
      () => page.getByRole('button', { name: /^Open Reply with exactly the word/ }).count(),
      { timeout: 10_000 },
    ).toBe(0)
  }, 90_000)

  it('rebuilds the terminal record from history after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workflow-run-history'))
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expandTurnProcesses(page)
    const workflow = page.getByRole('button', { name: /^snapshot-flow/ })
    await workflow.waitFor({ timeout: 15_000 })
    expect(await workflow.getAttribute('aria-expanded')).toBe('false')
    const snapshot = await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    await workflow.click()
    const phase = page.locator('[data-workflow-run][data-run-status="completed"] [data-disclosure-row]').nth(1)
    await phase.waitFor()
    expect(await phase.getAttribute('aria-expanded')).toBe('false')
    await phase.click()
    await page.getByText(CHILD_PROMPT, { exact: false }).waitFor()
    expect(await page.getByRole('button', { name: /^Open Reply with exactly the word/ }).count()).toBe(0)

    await page.getByRole('button', { name: '1 subagent', exact: true }).hover()
    const catalog = page.getByRole('tree', { name: 'Subagent sessions' })
    await catalog.getByRole('treeitem', { name: /snapshot-flow child 1/ }).click()
    await page.getByText(CHILD_PROMPT, { exact: true }).waitFor({ timeout: 15_000 })
    expect(await page.locator('[data-composer-input][contenteditable="true"]').count()).toBe(1)
  }, 60_000)

  it('stays clean and owns its Session pair and UI goldens', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v4.jsonl', 'session.1.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json',
    ])
    await assertFixtureInventory(EXPECTED_DIR, ['ui-live.expected.md', 'ui.expected.md'])
  })
})
