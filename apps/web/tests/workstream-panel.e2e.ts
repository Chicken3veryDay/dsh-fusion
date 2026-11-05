// Keyless assembled-browser coverage for the opt-in Workstream panel over the
// real Host projection frame flow and the generated panel Remote.
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MissionId } from '@deepseek-ai/dsh-experimental-ticket'
import type { TicketView } from '@deepseek-ai/dsh-experimental-ticket'
import { WorkstreamOperationId } from '@deepseek-ai/dsh-experimental-workstream'
import { WorkstreamEvidenceArtifactId, WorkstreamEvidenceOperationId } from '@deepseek-ai/dsh-experimental-workstream-evidence'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./workstream-panel.overlay.yml', import.meta.url))
const PROFILE_PATCH = fileURLToPath(new URL('../../../packages/experimental/workstream-profile/cordis.patch.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/workstream-profile/package.json', import.meta.url)),
]

function profileEntries(path: string): unknown[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`profile layer at ${path} must be a list`)
  return parsed
}

describe('Workstream panel overlay', () => {
  it('matches the Workstream profile layer', () => {
    expect(profileEntries(OVERLAY)).toEqual(profileEntries(PROFILE_PATCH))
  })
})

/** Seed one Workstream with a planned Ticket, an open question, an attention item, and one evidence file. */
async function seedWorkstream(scaffold: WebScaffold, agent: Agent): Promise<TicketView> {
  const { ctx } = scaffold
  await ctx.workstreams.open(agent, { operationId: WorkstreamOperationId('panel-e2e'), title: 'Panel release' })
  const created = await ctx.workstreams.createTicket(agent, agent.id, { subject: 'Ship release', description: 'Publish the 2.0 packages' })
  const asked = await ctx.tickets.ask(agent.session, {
    ticketId: created.id, expectedRevision: created.revision, actorId: agent.id, question: 'Which branch ships?',
  })
  const attended = await ctx.tickets.attention(agent.session, {
    ticketId: asked.id, expectedRevision: asked.revision, actorId: agent.id, kind: 'decision', message: 'Pick the release date',
  })
  const planned = await ctx.tickets.planMission(agent.session, {
    ticketId: attended.id, expectedRevision: attended.revision, actorId: agent.id,
    missionId: MissionId('launch'), expectedPlanRevision: 0, title: 'Launch', milestones: [{ title: 'Beta', ticketIds: [created.id] }],
  })
  await ctx.workstreamEvidence.publish(agent, agent.id, {
    operationId: WorkstreamEvidenceOperationId('notes-1'), artifactId: WorkstreamEvidenceArtifactId('notes'),
    name: 'release-notes.md', expectedVersion: 1, content: '# Release notes\n',
  })
  return planned
}

describe('web e2e: Workstream panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent
  let seeded: TicketView

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const first = scaffold.ctx.agents.list()[0]
    if (first === undefined) throw new Error('connected Workstream workspace did not create an Agent')
    agent = first
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Open the Workstream panel.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Ready.' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('Ready.').waitFor({ timeout: 10_000 })
    seeded = await seedWorkstream(scaffold, agent)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('answers a question and acknowledges attention as the displayed Session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workstream-panel'))
    const trigger = page.locator('[data-workstream-action]').getByRole('button', { name: 'Workstream', exact: true })
    await trigger.click()
    const panel = page.getByRole('dialog', { name: 'Panel release', exact: true })
    await panel.getByText('Which branch ships?').waitFor()
    await panel.getByText('Pick the release date').waitFor()

    await panel.getByRole('textbox', { name: 'Answer' }).fill('release/2.0')
    await panel.getByRole('button', { name: 'Send answer' }).click()
    await panel.getByText('Which branch ships?').waitFor({ state: 'detached' })
    const answered = scaffold.ctx.tickets.get(agent.session, seeded.id)
    expect(answered.revision).toBe(seeded.revision + 1)
    expect(answered.questions[0]).toMatchObject({ status: 'answered', answer: 'release/2.0', answeredBy: agent.id })

    await panel.getByRole('button', { name: 'Acknowledge' }).click()
    await panel.getByText('Acknowledged', { exact: true }).waitFor()
    expect(scaffold.ctx.tickets.get(agent.session, seeded.id).attentions[0]?.status).toBe('acknowledged')
    expect(await panel.getByRole('alert').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('renders Work, Team, Changes, and Files from the seeded Workstream', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workstream-panel-views'))
    const panel = page.getByRole('dialog', { name: 'Panel release', exact: true })
    await panel.getByRole('tab', { name: /^Work/u }).click()
    await panel.getByText('Launch', { exact: true }).waitFor()
    await panel.getByText('0 of 1 done').waitFor()
    await panel.locator('[data-ticket]').getByText('Ship release').waitFor()

    await panel.getByRole('tab', { name: /^Team/u }).click()
    await panel.getByText('Current chat').waitFor()
    await panel.getByText('Owner · Coordinator · Active').waitFor()

    await panel.getByRole('tab', { name: /^Changes/u }).click()
    await panel.getByRole('button', { name: 'Reload' }).waitFor()
    if (scaffold.ctx.get('forgeSession') === undefined) {
      await panel.locator('[data-incomplete]').getByText(/Forge session service is not mounted/u).waitFor()
    }
    await panel.getByText('No change requests are bound to this Workstream.').waitFor()

    await panel.getByRole('tab', { name: /^Files/u }).click()
    const file = panel.locator('[data-artifact="notes"]')
    await file.getByText('release-notes.md').waitFor()
    await file.getByText('Version 1').waitFor()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the panel inside a 390px viewport and closes on Escape', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workstream-panel-narrow'))
    const viewport = page.viewportSize()!
    const panel = page.getByRole('dialog', { name: 'Panel release', exact: true })
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await expect.poll(() => panel.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left >= 16 && rect.right <= window.innerWidth - 16 && rect.bottom <= window.innerHeight - 16
          && document.documentElement.scrollWidth <= window.innerWidth
      })).toBe(true)
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'detached' })
    } finally {
      await page.setViewportSize(viewport)
    }
  })
})
