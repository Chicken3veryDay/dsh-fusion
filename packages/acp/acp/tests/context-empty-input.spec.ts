/** Strict workspace guidance cannot turn a removed client input into model work. */
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TestCleanup } from './cleanup.ts'
import { makeBridgeHarness, textResponse } from './harness.ts'

const cleanup = new TestCleanup()
afterEach(async () => { await cleanup.run() })

it('defers strict instructions after a removed input and delivers them with the next real input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-empty-input-'))
  cleanup.defer(() => rm(root, { recursive: true, force: true }))
  cleanup.defer(() => { vi.unstubAllEnvs() })
  const cwd = join(root, 'project')
  const home = join(root, 'dsh-home')
  const agentsHome = join(root, 'agents-home')
  await Promise.all([
    mkdir(join(cwd, '.git'), { recursive: true }),
    mkdir(home),
    mkdir(agentsHome),
  ])
  await writeFile(join(cwd, 'AGENTS.md'), 'Project rule: never force push.\n')
  await writeFile(join(home, 'AGENTS.md'), 'Owner rule: keep replies concise.\n')
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_AGENTS_HOME', agentsHome)
  const harness = cleanup.adopt(await makeBridgeHarness({
    script: [textResponse('done')],
    beforeAcp: async (ctx) => {
      provideWorkingDirectoryFixture(ctx)
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(AgentInstructions, { maxBytes: 65536, mode: 'strict' })
    },
  }))
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
  const stopRemoving = harness.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind === 'user') agent.inbox.remove(message.id)
  })
  const result = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'removed task' }] })
  expect(result).toEqual({ stopReason: 'cancelled' })
  expect(harness.adapter.requests).toHaveLength(0)
  const agent = harness.ctx.agents.get(SessionId(sessionId))!
  expect(agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' || event.type === 'step/start' || event.type === 'tool/call')).toEqual([])
  expect(agent.inbox.nextStep.some(message => message.source.kind === 'agent-instructions')).toBe(true)

  stopRemoving()
  await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'real task' }] })
  expect(harness.adapter.requests).toHaveLength(1)
  const text = harness.adapter.requests[0]!.messages.flatMap(message =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
  expect(text).toContain('Project rule: never force push.')
  expect(text).toContain('Owner rule: keep replies concise.')
  expect(text).toContain('real task')
  expect(text).not.toContain('removed task')
  const messages = agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data] : [])
  const input = messages.find(message => message.source.kind === 'user')!
  expect(messages.filter(message => message.source.kind === 'user')).toHaveLength(1)
  expect(messages.filter(message => message.source.kind === 'acp-context')).toHaveLength(1)
  expect(messages.find(message => message.source.kind === 'acp-context')?.source).toMatchObject({ latestInput: input.id })
})
