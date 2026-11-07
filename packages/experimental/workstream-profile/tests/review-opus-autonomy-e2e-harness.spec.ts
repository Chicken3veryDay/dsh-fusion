/**
 * Review harness: boot the shipped Workstream and context profile layers over the headless profile through the real
 * Loader, in-process, with only the model provider replaced by a scripted adapter. The probe below drives one owner and
 * one member through the model-visible tools across a restart.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, afterEach, expect, it } from 'vitest'
import { bootProductionProfile } from '../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

export type Step = { call: string; args: Record<string, unknown>; id?: string } | { text: string } | { hang: true } | { fail: string }
export interface Request { readonly session: string; readonly tools: string[]; readonly text: string; readonly options: GenerateOptions }
export type Brain = (request: Request, step: number, last: string | undefined) => Step | Promise<Step>

/** The abort reason as an Error, so a rejection always carries one. */
const abortError = (signal: AbortSignal): Error => signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))

const textOf = (message: RequestMessage): string => message.content.map(block => block.type === 'text' ? block.text : '').join('')

export class ScriptAdapter extends LlmAdapter {
  readonly requests: Request[] = []
  brain: Brain = () => ({ text: 'done' })
  override listModels(provider: string) { return Promise.resolve(['deepseek-v4-flash', 'curator-small'].map(id => ({ provider, id, name: id }))) }
  override resolveModel(provider: string, model: string) {
    const small = model === 'curator-small'
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: small ? 40_000 : 200_000 },
      reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }], defaultEffort: small ? 'low' : 'high' } }) as never
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const request: Request = { session: String(options.sessionId), tools: (options.tools ?? []).map(tool => tool.name),
      text: options.messages.map(textOf).join('\n'), options }
    this.requests.push(request)
    const step = options.messages.filter(message => message.role === 'assistant').length
    const lastMessage = options.messages.at(-1)
    const last = lastMessage?.role === 'tool' ? textOf(lastMessage) : undefined
    const signal = options.signal
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal === undefined) return
      if (signal.aborted) reject(abortError(signal))
      signal.addEventListener('abort', () => { reject(abortError(signal)) }, { once: true })
    })
    aborted.catch(() => undefined)
    const next = await Promise.race([this.brain(request, step, last), aborted])
    if ('hang' in next) {
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(abortError(signal)) }, { once: true })
      })
      return
    }
    if ('fail' in next) throw new Error(next.fail)
    if ('call' in next) {
      const id = ToolCallId(next.id ?? `${next.call}-${String(this.requests.length)}`)
      const args = JSON.stringify(next.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: next.call, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: next.call, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: next.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: next.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Per-session scripts: a role picks its script from the request; each entry sees the parsed prior tool results. */
export type ScriptStep = (results: readonly ToolOutcome[], request: Request) => Step | Promise<Step>
export interface ToolOutcome { readonly text: string; readonly json: unknown }
export function scripted(pick: (request: Request) => readonly ScriptStep[] | undefined, after: Step = { text: 'done' }): Brain {
  const cursors = new Map<string, { index: number; results: ToolOutcome[] }>()
  return (request) => {
    const cursor = cursors.get(request.session) ?? { index: 0, results: [] }
    cursors.set(request.session, cursor)
    const last = request.options.messages.at(-1)
    if (last?.role === 'tool' && cursor.index > 0) {
      const text = textOf(last)
      let json: unknown
      try { json = JSON.parse(text) } catch { json = undefined }
      cursor.results.push({ text, json })
    }
    const script = pick(request)
    const step = script?.[cursor.index]
    cursor.index += 1
    return step === undefined ? after : step(cursor.results, request)
  }
}

export interface World { readonly cwd: string; readonly home: string; readonly overlay: string }

const originalCwd = process.cwd()
const worlds: World[] = []
const live: Context[] = []
afterEach(async () => {
  for (const ctx of live.splice(0).reverse()) await ctx.fiber.dispose().catch(() => undefined)
})
afterAll(async () => {
  process.chdir(originalCwd)
  for (const world of worlds.splice(0)) await rm(world.cwd, { recursive: true, force: true })
})

export async function makeWorld(options: { context?: boolean; extra?: string[] } = {}): Promise<World> {
  const cwd = await mkdtemp(join(tmpdir(), 'opus-e2e-'))
  const home = join(cwd, '.dsh')
  const profileDir = join(home, 'profiles', 'headless')
  await mkdir(join(profileDir, 'node_modules', '@deepseek-ai'), { recursive: true })
  const layers = ['workstream-profile', ...options.context === false ? [] : ['context-profile']]
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', ...layers.map(layer => `@deepseek-ai/dsh-experimental-${layer}`)]
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-headless', private: true,
    dependencies: Object.fromEntries(bundles.slice(2).map(bundle => [bundle, 'workspace:^'])), dsh: { profile: { bundles } } }))
  for (const layer of layers) {
    await symlink(fileURLToPath(new URL(`../../${layer}`, import.meta.url)), join(profileDir, 'node_modules', '@deepseek-ai', `dsh-experimental-${layer}`))
  }
  const overlay = join(cwd, 'test.patch.yml')
  await writeFile(overlay, [
    '- id: llm-deepseek', '  disabled: true',
    '- id: plugin-package-inventory-deepseek', '  disabled: true',
    '- id: session-title-llm', '  disabled: true',
    '- id: headless-runner', '  disabled: true',
    '- id: headless-startup', '  disabled: true',
    '- id: sandbox-policy', '  inject: []', '  config:', '    mode: workspace-write', `    workspaceRoot: '${cwd}'`,
    '- id: session-persistence-jsonl', '  config:', `    root: '${join(home, 'sessions')}'`, '    compression: none',
    ...options.extra ?? [],
    '',
  ].join('\n'))
  const world = { cwd, home, overlay }
  worlds.push(world)
  return world
}

/** Boot one process lifetime of the world; the adapter is the only replaced provider. */
export async function boot(world: World, adapter: ScriptAdapter): Promise<Context> {
  process.env.DSH_HOME = world.home
  process.env.DSH_AGENTS_HOME = join(world.cwd, '.agents')
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.chdir(world.cwd)
  const ctx = await bootProductionProfile({ binName: 'opus-e2e', profile: 'headless', overlayPaths: [world.overlay] })
  live.push(ctx)
  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  return ctx
}

/** Reload one Loader entry, wherever the profile include nested it, by disabling and re-enabling it. */
export async function reloadEntry(ctx: Context, id: string): Promise<void> {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
  if (entry === undefined) throw new Error(`no Loader entry ${id}`)
  await entry.update({ disabled: true })
  await entry.update({ disabled: false })
  await entry.fiber?.await()
}

export async function shutdown(ctx: Context): Promise<void> {
  const index = live.indexOf(ctx)
  if (index >= 0) live.splice(index, 1)
  await ctx.fiber.dispose()
}

export const MODEL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

export async function createRoot(ctx: Context, id: string): Promise<Agent> {
  const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: process.cwd() }, agentOptions: MODEL })
  return agent
}

export async function resumeRoot(ctx: Context, id: string): Promise<Agent> {
  const { agent } = await ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions: MODEL })
  return agent
}

/** Send one user task and wait until the agent and its children are idle, as the headless runner does. */
export async function runTask(ctx: Context, agent: Agent, task: string, limitMs = 60_000): Promise<'idle' | 'timeout'> {
  const work = (async () => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
    for (;;) {
      await agent.whenIdle()
      const seq = agent.session.seq
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return 'idle' as const
      if (!await subagents.waitForChildren(agent) && agent.status === 'idle' && agent.session.seq === seq) return 'idle' as const
    }
  })()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { resolve('timeout') }, limitMs) })
  try { return await Promise.race([work, timeout]) } finally { clearTimeout(timer) }
}

export async function debug(value: unknown): Promise<void> {
  await writeFile(join(process.env.REVIEW_DEBUG_DIR ?? tmpdir(), 'review-debug.json'), JSON.stringify(value, undefined, 1))
}

/** The `tool/call` and `tool/result` fields `toolResults` reads; other event types leave them absent. */
interface ToolEventData {
  readonly callId?: string
  readonly name?: string
  readonly message?: { readonly toolCallId: string; readonly isError: boolean; readonly content: readonly { readonly text?: string }[] }
}
export interface LogEvent { readonly type: string; readonly data?: ToolEventData; readonly parentSession?: string; readonly id?: string }

export async function readLogs(home: string): Promise<Map<string, LogEvent[]>> {
  const out = new Map<string, LogEvent[]>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name === 'session.v4.jsonl') {
        const events = (await readFile(path, 'utf8')).split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as LogEvent)
        out.set((events[0] as { id?: string }).id ?? path, events)
      }
    }
  }
  await walk(join(home, 'sessions'))
  return out
}

/** Tool results the model saw, in order, for one session's requests. */
export function toolResults(events: readonly LogEvent[]): { name: string; isError: boolean; text: string }[] {
  const names = new Map<string, string>()
  const out: { name: string; isError: boolean; text: string }[] = []
  for (const event of events) {
    const data = event.data
    if (event.type === 'tool/call' && data?.callId !== undefined && data.name !== undefined) names.set(data.callId, data.name)
    const message = event.type === 'tool/result' ? data?.message : undefined
    if (message !== undefined) {
      out.push({ name: names.get(message.toolCallId) ?? '?', isError: message.isError,
        text: message.content.map(block => block.text ?? '').join('') })
    }
  }
  return out
}

it.runIf((expect.getState().testPath ?? '').endsWith('review-opus-autonomy-e2e-harness.spec.ts'))('harness: boots both layers and drives a scripted owner turn', async () => {
  const world = await makeWorld()
  const adapter = new ScriptAdapter()
  const ctx = await boot(world, adapter)
  const owner = await createRoot(ctx, 'owner-root')
  adapter.brain = (request, step) => {
    if (request.session !== 'owner-root') return { text: 'member done' }
    if (step === 0) return { call: 'context_load', args: { paths: ['Tools'] } }
    return { text: 'ok' }
  }
  expect(await runTask(ctx, owner, 'probe')).toBe('idle')
  const first = adapter.requests[0]!
  const results = toolResults((await readLogs(world.home)).get('owner-root')!)
  await debug({ first: first.tools, counts: adapter.requests.map(r => [r.session, r.tools.length]), results,
    last: adapter.requests.at(-1)!.tools })
}, 120_000)
