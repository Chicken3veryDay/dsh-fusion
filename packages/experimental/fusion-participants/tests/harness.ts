/** Loader composition, real JSONL restart and parked Agent context lineage. */
import { afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import Llm from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Native from '@deepseek-ai/dsh-tool-executor-native'
import Agents from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Preset from '@deepseek-ai/dsh-agent-preset'
import Commands from '@deepseek-ai/dsh-commands'
import FusionConfig from '@deepseek-ai/dsh-fusion-config'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeCredentials } from '../../../preset/fusion-config/tests/harness.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import Participants from '../src/index.ts'

const contexts: Context[] = []
export const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
export async function mount(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'fusion-participants-'))
  if (!roots.includes(root)) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    group: Group, llm: Llm, sessions: Sessions, projections: Projections, prompt: Prompt, tools: Tools,
    native: Native, agents: Agents, loop: Loop, presets: Presets, preset: Preset, commands: Commands,
    credentials: FakeCredentials, config: FusionConfig, jsonl: Jsonl, participants: Participants,
  })
  const entries = [
    ...['llm', 'sessions', 'projections', 'prompt', 'tools', 'native', 'agents'].map(name => ({ name: `cordis:${name}` })),
    { name: 'cordis:jsonl', config: { root, compression: 'none' } },
    { name: 'cordis:loop', config: { agents: [] } },
    { name: 'cordis:presets', config: { default: 'standard' } },
    { name: 'cordis:preset', config: { id: 'standard', plugins: [] } },
    { name: 'cordis:commands' }, { name: 'cordis:credentials' },
    { name: 'cordis:config', config: { document: {
      credentialRef: 'PARTICIPANTS_TEST', agentPreset: 'standard', providers: {}, declarations: [], bindings: [],
      selections: [{ id: 'single-test', revision: 'test-v1', agentPreset: 'standard',
        topology: { kind: 'single', participant: { catalogRevision: 'v1', presetId: 'Sol' } }, auxiliaries: {} }],
      metadataLimits: { responseBytes: 32768, totalBytes: 262144, pages: 32, timeoutMs: 5000 },
    } } },
    { name: 'cordis:participants' },
  ]
  for (const entry of entries) await ctx.loader.create(entry)
  await ctx.loader.await()
  const adapter = new MockAdapter(Array.from({ length: 8 }, () => textResponse('retained answer')), {
    efforts: ['low', 'medium', 'high'].map(effort => ({ id: ReasoningEffortId(effort), name: effort })),
  })
  ctx.llm.registerAdapter(['omniroute-openai', 'omniroute-anthropic'], adapter)
  return { ctx, root, adapter }
}
export async function read(ctx: Context, id: SessionId) {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try { return (await reader.read()).events } finally { await reader.close() }
}
export const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
