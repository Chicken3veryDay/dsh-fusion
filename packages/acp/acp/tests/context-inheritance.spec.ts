import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import * as AgentInstructions from '@deepseek-ai/dsh-agent-instructions'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as ForkInProcess from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { TestCleanup } from './cleanup.ts'
import { makeBridgeHarness, textResponse } from './harness.ts'

const cleanup = new TestCleanup()
const RULE = 'deny: never deploy on Friday'

const textOf = (message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
  message.content.map(block => block.text ?? '').join('')
const isPacket = (message: Parameters<typeof textOf>[0]): boolean => textOf(message).includes('ACP automation context')

beforeEach(() => { vi.stubEnv('DSH_AGENTS_HOME', '/nonexistent-dsh-agents-home') })
afterEach(async () => {
  vi.unstubAllEnvs()
  await cleanup.run()
})

/** A scratch workspace whose AGENTS.md carries one mandatory rule, with the user-global homes pointed away from the machine. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-inherit-'))
  const home = await mkdtemp(join(tmpdir(), 'dsh-acp-inherit-home-'))
  cleanup.defer(async () => { await Promise.all([root, home].map(dir => rm(dir, { recursive: true, force: true }))) })
  vi.stubEnv('DSH_HOME', home)
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'AGENTS.md'), `# Rules\n\n## Commands\n\n- ${RULE}\n`)
  return root
}

async function mountComposition(ctx: Context): Promise<void> {
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(AgentInstructions, { maxBytes: 65536, mode: 'strict' })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(ForkInProcess, { providerName: 'fork' })
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
}

/** An ACP session in the scratch workspace whose parent can start a child through the `delegate` tool. */
async function delegatingSession(provider: 'fork' | 'spawn', script: Parameters<typeof makeBridgeHarness>[0] extends infer O ? O : never) {
  const root = await workspace()
  const harness = cleanup.adopt(await makeBridgeHarness({
    ...script,
    beforeAcp: mountComposition,
  }))
  const started: { session: Session | undefined } = { session: undefined }
  harness.ctx.tools.register(defineContentToolFixture({
    name: 'delegate', description: 'Run a child.', parameters: {},
    execute: async (_args, exec) => {
      const child = await harness.ctx.subagents.startActivation({
        provider, label: 'child', delivery: 'caller', signal: exec.signal,
        request: { parent: exec.agent!, prompt: [{ type: 'text', text: 'child task' }] },
      })
      started.session = harness.ctx.agents.get(child.childId)?.session
      return [...(await child.result).output]
    },
  }))
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const { sessionId } = await harness.client.newSession({ cwd: root, mcpServers: [] })
  return { harness, sessionId, started }
}

function packetEvents(events: readonly SessionEvent[]) {
  return events.flatMap(event =>
    event.type === 'user/message' && event.data.source.kind === 'acp-context' ? [{ seq: event.seq, message: event.data }] : [])
}

describe('ACP context across a forked or spawned child', () => {
  it('keeps the parent identity and mandatory rules in a forked child without labeling it the ACP recipient', async () => {
    const { harness, sessionId, started } = await delegatingSession('fork', {
      script: [
        textResponse('first answer'), toolCallResponse('delegate-1', 'delegate', {}), textResponse('child answer'), textResponse('parent answer'),
      ],
    })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'parent task one' }] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'parent task two' }] })

    const [, , childRequest, parentLast] = harness.adapter.requests
    const childMessages = childRequest!.messages.map(textOf)
    // The fork inherits the completed first turn: the parent's input, its mandatory rule, and the parent's packet, in that order.
    expect(childMessages.indexOf('parent task one')).toBeGreaterThanOrEqual(0)
    expect(childMessages.some(text => text.includes(RULE))).toBe(true)
    expect(childMessages.at(-2)).toBe('child task')
    const inheritedPackets = childRequest!.messages.filter(isPacket).map(textOf)
    expect(inheritedPackets).toHaveLength(1)
    expect(inheritedPackets[0]).toContain(`session ${sessionId}`)

    // The child's log holds only the packet it inherited, still naming the parent; it published none of its own.
    const child = started.session!
    expect(child.header.isSeeded).toBe(true)
    const childPackets = packetEvents(child.snapshotEvents())
    expect(childPackets).toHaveLength(1)
    expect(childPackets[0]!.seq).toBeLessThan(child.inheritedEventCount)
    expect(childPackets[0]!.message.source).toMatchObject({ kind: 'acp-context', session: sessionId })
    expect(child.id).not.toBe(sessionId)
    // The parent's own packets are unchanged by the fork.
    const parent = harness.ctx.agents.get(SessionId(sessionId))!
    expect(parentLast!.messages.filter(isPacket)).toHaveLength(2)
    const parentPackets = packetEvents(parent.session.snapshotEvents())
    expect(parentPackets).toHaveLength(2)
    expect(parentPackets.every(({ message }) => message.source.kind === 'acp-context' && message.source.session === sessionId)).toBe(true)
  })

  it('gives a spawned child its own workspace rules but neither the parent input nor a packet', async () => {
    const { harness, sessionId, started } = await delegatingSession('spawn', {
      script: [textResponse('first answer'), toolCallResponse('delegate-1', 'delegate', {}), textResponse('child answer'), textResponse('parent answer')],
    })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'parent task one' }] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'parent task two' }] })

    const [, , childRequest] = harness.adapter.requests
    const childMessages = childRequest!.messages.map(textOf)
    expect(childMessages.some(text => text.includes(RULE))).toBe(true)
    expect(childMessages).toContain('child task')
    expect(childMessages).not.toContain('parent task one')
    expect(childMessages).not.toContain('parent task two')
    expect(childRequest!.messages.filter(isPacket)).toEqual([])
    expect(started.session!.header.isSeeded).toBe(false)
    expect(packetEvents(started.session!.snapshotEvents())).toEqual([])
  })
})
