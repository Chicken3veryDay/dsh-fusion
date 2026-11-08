import { Context } from '@deepseek-ai/cordis'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { type AgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmService, { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { AcpModelControl } from '../src/model-control.ts'
import { AcpSession } from '../src/session.ts'
import { makeBridgeHarness } from './harness.ts'

/** Minimal LLM catalog/runtime double for pure standard-option tests. */
function llmRuntime(overrides: Partial<LlmRuntime> = {}): LlmRuntime {
  const listModels = overrides.listModels ?? (() => Promise.resolve([{ provider: 'mock', id: 'mock', name: 'Mock' }]))
  return {
    listProviders: () => [{ id: 'mock', name: 'Mock' }],
    listModels,
    // The base adapter rule: selectable exactly when listed.
    canSelectModel: async (provider: string, model: string) => (await listModels(provider)).some(entry => entry.id === model),
    resolveCallConfig: (selection: { provider?: string; model?: string; reasoningEffort?: string }) => Promise.resolve({
      provider: selection.provider ?? 'mock',
      model: selection.model ?? 'mock',
      ...selection.reasoningEffort === undefined
        ? { reasoningEffort: ReasoningEffortId('high') }
        : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    }),
    resolveModelInfo: (provider: string, model: string) => Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low', description: 'Less thought.' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    }),
    ...overrides,
  } as unknown as LlmRuntime
}

async function createControl(runtime: LlmRuntime, initial?: AgentOptions) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('model-control'))
  const options = initial ?? {}
  const projection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const model = new AgentModel(() => projection.stateOf(session), session, options)
  return { control: new AcpModelControl(runtime, model), session, model }
}

describe('ACP model configuration control', () => {
  it('represents an absent route and validates value types before mutation', async () => {
    const { control, session, model } = await createControl(llmRuntime())

    expect(model.current()).toBeUndefined()
    await expect(control.options()).resolves.toEqual([])
    await expect(control.set('model', false)).rejects.toThrow(/requires a select value/)
    await expect(control.set('model', 'missing')).rejects.toThrow(/no model selection/)

    session.append('model/selection', { provider: 'mock', model: 'mock' })
    expect(model.current()).toEqual({ provider: 'mock', model: 'mock' })
  })

  it('synthesizes an unlisted current route and exposes reasoning descriptions', async () => {
    const { control, model: agentModel } = await createControl(llmRuntime({ listProviders: () => [] }), {
      provider: 'private',
      model: 'unlisted',
    })

    const options = await control.options()

    const model = options.find(option => option.id === 'model')
    const reasoning = options.find(option => option.id === 'reasoning_effort')
    expect(model).toMatchObject({
      type: 'select',
      currentValue: '["private","unlisted"]',
      options: [{ group: 'private', name: 'private', options: [{ name: 'unlisted' }] }],
    })
    expect(reasoning).toMatchObject({
      type: 'select',
      currentValue: 'high',
      options: [{ name: 'Low', description: 'Less thought.' }, { name: 'High' }],
    })

    expect(agentModel.current()).toEqual({ provider: 'private', model: 'unlisted' })

  })

  it('keeps the selected route when its provider catalog is temporarily unavailable', async () => {
    const listModels = vi.fn(() => Promise.reject(new Error('catalog unavailable')))
    const { control } = await createControl(llmRuntime({ listModels }), { provider: 'mock', model: 'mock' })

    const options = await control.options()

    expect(listModels).toHaveBeenCalledWith('mock')
    expect(options[0]).toMatchObject({
      type: 'select',
      options: [{ group: 'mock', options: [{ name: 'mock' }] }],
    })
  })

  it('offers only the models the provider lists and refuses a slug it withheld', async () => {
    const listModels = vi.fn(() => Promise.resolve([{ provider: 'mock', id: 'mock', name: 'Mock' }]))
    const { control } = await createControl(llmRuntime({ listModels }), { provider: 'mock', model: 'mock' })

    const [model] = await control.options()

    expect(model).toMatchObject({ options: [{ group: 'mock', options: [{ name: 'Mock' }] }] })
    await expect(control.set('model', JSON.stringify(['mock', 'withheld']))).rejects.toThrow()
  })

  it('rejects an unadvertised reasoning effort and accepts a later valid change', async () => {
    const { control, session } = await createControl(llmRuntime(), { provider: 'mock', model: 'mock' })

    await expect(control.set('reasoning_effort', 'extreme')).rejects.toThrow(/unknown reasoning effort/)
    const options = await control.set('reasoning_effort', 'low')

    expect(options.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'low' })
    expect(session.snapshotEvents().map(event => ({ type: event.type, data: event.data }))).toEqual([{
      type: 'model/selection', data: { provider: 'mock', model: 'mock', reasoningEffort: 'low' },
    }])
  })

  it('exposes and restores a provider-owned reasoning default', async () => {
    const runtime = llmRuntime({
      resolveCallConfig: (selection: { provider?: string; model?: string; reasoningEffort?: string }) => Promise.resolve({
        provider: selection.provider ?? 'mock',
        model: selection.model ?? 'mock',
        ...selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
      }),
      resolveModelInfo: (provider: string, model: string) => Promise.resolve({
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: [
            { id: ReasoningEffortId('low'), name: 'Low' },
            { id: ReasoningEffortId('high'), name: 'High' },
          ],
        },
      }),
    })
    const { control, model } = await createControl(runtime, { provider: 'mock', model: 'mock' })

    const initial = await control.options()
    expect(initial.find(option => option.id === 'reasoning_effort')).toMatchObject({
      currentValue: '',
      options: [{ value: '', name: 'Provider default' }, { value: 'low' }, { value: 'high' }],
    })
    await control.set('reasoning_effort', 'low')
    const restored = await control.set('reasoning_effort', '')

    expect(restored.find(option => option.id === 'reasoning_effort')).toMatchObject({ currentValue: '' })
    expect(model.current()).toEqual({ provider: 'mock', model: 'mock' })
  })
})

/** A loopback model listing that answers the first request and then fails with 503. */
async function accountListing(): Promise<{ url: string; paths: string[] }> {
  const paths: string[] = []
  const listing = JSON.stringify({ models: ['gpt-5.4', 'gpt-future-unlisted', 'gpt-5.4-mini']
    .map(slug => ({ slug, display_name: `Name ${slug}`, visibility: 'list' })) })
  const server = createServer((request, response) => {
    paths.push(request.url ?? '')
    if (paths.length === 1) response.writeHead(200, { 'content-type': 'application/json' }).end(listing)
    else response.writeHead(503, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${String(address.port)}`, paths }
}

/** Mount a synthetic signed-in account whose advertised models come from a loopback listener. */
async function registerAccount(ctx: Context) {
  const server = await accountListing()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-model-control-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yml'), watch: false })
  await ctx.credentials.modifyRecord(PiAi.recordKeyFor('openai'), () => Promise.resolve({
    kind: 'grant', payload: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 4_000_000_000_000, clientId: 'login-one' },
  }))
  await ctx.plugin(PiAi, { providers: { openai: { baseURL: `${server.url}/v1` } } })
  return server
}

describe('ACP configuration admission', () => {
  it('returns no options when the live route fallback is withdrawn during a catalog lookup', async () => {
    const initial: { provider?: string; model?: string } = { provider: 'mock', model: 'mock' }
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const listModels = async () => {
      entered.resolve(undefined)
      await release.promise
      return []
    }
    const { control } = await createControl(llmRuntime({ listModels }), initial)
    const pending = control.options()
    try {
      await entered.promise
      delete initial.provider
      release.resolve(undefined)
      await expect(pending).resolves.toEqual([])
    } finally {
      release.resolve(undefined)
      await pending.catch(() => undefined)
    }
  })

  it('creates a session without a selection without listing an unrelated account', async () => {
    const harness = await makeBridgeHarness({ config: { provider: undefined, model: undefined } })
    onTestFinished(() => harness.dispose())
    const server = await registerAccount(harness.ctx)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    expect(created.configOptions).toEqual([])
    expect(server.paths).toEqual([])
  })

  it('refuses a cancelled configuration request before listing an unrelated account', async () => {
    const harness = await makeBridgeHarness()
    onTestFinished(() => harness.dispose())
    const server = await registerAccount(harness.ctx)
    const resolveModel = harness.adapter.resolveModel.bind(harness.adapter)
    harness.adapter.resolveModel = (provider: string, model: string, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      return resolveModel(provider, model)
    }
    const record = await AcpSession.create(harness.ctx, {
      sessionId: SessionId('cancelled-configuration'), cwd: process.cwd(), mcpServers: [],
      agentOptions: { provider: 'mock', model: 'mock' }, signal: new AbortController().signal,
      notify: async () => {},
    })
    onTestFinished(() => record.close('configuration test finished'))
    const cancellation = new Error('configuration request cancelled')
    const controller = new AbortController()
    controller.abort(cancellation)

    await expect(record.configOptions(controller.signal)).rejects.toBe(cancellation)
    expect(server.paths).toEqual([])
  })
})

describe('ACP selection on a signed-in account route', () => {
  /** The shipped pi-ai plugin with one stored ChatGPT grant, its account listing on loopback. */
  async function accountControl() {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LlmService)
    const server = await registerAccount(ctx)
    const created = await createControl(ctx.llm, { provider: 'openai', model: 'gpt-5.4' })
    return { ...created, server }
  }

  it('applies a previously offered registered model while the listing answers 503, without listing again', async () => {
    const { control, model, session, server } = await accountControl()
    const [offered] = await control.options()
    if (offered?.type !== 'select') throw new Error('expected a model select option')
    const values = offered.options.flatMap(group => 'group' in group ? group.options.map(option => option.value) : [])
    const mini = JSON.stringify(['openai', 'gpt-5.4-mini'])
    expect(values).toEqual([JSON.stringify(['openai', 'gpt-5.4']), mini])
    expect(server.paths).toEqual(['/v1/models'])

    const state = await control.set('model', mini)

    expect(model.current()).toEqual({ provider: 'openai', model: 'gpt-5.4-mini' })
    expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'model/selection', data: { provider: 'openai', model: 'gpt-5.4-mini' } })
    expect(state.find(option => option.id === 'model')).toMatchObject({
      currentValue: mini,
      options: [{ group: 'openai', options: [{ value: JSON.stringify(['openai', 'gpt-5.4']) }, { value: mini }] }],
    })
    expect(state.find(option => option.id === 'reasoning_effort')).toMatchObject({ type: 'select' })
    expect(server.paths).toEqual(['/v1/models'])
  })

  it('refuses an unresolvable slug, a non-canonical value and an unregistered provider without listing', async () => {
    const { control, model, server } = await accountControl()
    await control.options()
    for (const value of [
      JSON.stringify(['openai', 'gpt-future-unlisted']),
      '["openai", "gpt-5.4-mini"]',
      JSON.stringify(['other', 'gpt-5.4-mini']),
      JSON.stringify(['openai']),
      JSON.stringify([1, 'gpt-5.4-mini']),
      'gpt-5.4-mini',
    ]) await expect(control.set('model', value)).rejects.toThrow(/unknown model option/)
    expect(model.current()).toEqual({ provider: 'openai', model: 'gpt-5.4' })
    expect(server.paths).toEqual(['/v1/models'])
  })

  it('re-selects the current route without asking the adapter', async () => {
    const canSelectModel = vi.fn(() => Promise.resolve(false))
    const { control, model } = await createControl(llmRuntime({ canSelectModel }), { provider: 'mock', model: 'mock' })
    const state = await control.set('model', JSON.stringify(['mock', 'mock']))
    expect(state.find(option => option.id === 'model')).toMatchObject({ currentValue: JSON.stringify(['mock', 'mock']) })
    expect(model.current()).toEqual({ provider: 'mock', model: 'mock' })
    expect(canSelectModel).not.toHaveBeenCalled()
  })

  it('reports a selection check that fails as an unknown option, and keeps the caller abort', async () => {
    const failure = vi.fn(() => Promise.reject(new Error('selection check failed')))
    const { control } = await createControl(llmRuntime({ canSelectModel: failure }), { provider: 'mock', model: 'mock' })
    await expect(control.set('model', JSON.stringify(['mock', 'other']))).rejects.toThrow(/unknown model option/)
    const aborted = new AbortController()
    aborted.abort(new Error('caller gave up'))
    await expect(control.set('model', JSON.stringify(['mock', 'other']), aborted.signal)).rejects.toThrow('caller gave up')
    expect(failure).toHaveBeenCalledTimes(2)
  })
})
