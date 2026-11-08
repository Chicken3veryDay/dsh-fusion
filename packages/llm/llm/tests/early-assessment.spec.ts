/** The early control hook: when the runtime consults it, what it may refuse, and what it never shows an adapter. */
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  assessSuppliedControls, createUserMessage, LlmAdapter, LlmError, ReasoningEffortId, undeclaredControlAssessment,
} from '@deepseek-ai/dsh-llm'
import type {
  CallControlAssessment, ControlDisposition, GenerateOptions, LlmCallControls, PreparedAdapterCall, StreamChunk,
} from '@deepseek-ai/dsh-llm'

const ROUTE = 'route'
const MODEL = 'model'
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const unsupported = (control: 'temperature'): CallControlAssessment => assessSuppliedControls(
  { [control]: 1 }, (): ControlDisposition => ({ kind: 'unsupported', reason: 'reasoning-active' }),
)

/** Records the order of runtime calls and answers the early hook from `early`. */
class EarlyAdapter extends LlmAdapter {
  readonly events: string[] = []
  readonly seen: Readonly<LlmCallControls>[] = []
  captured: (controls: Readonly<LlmCallControls>) => CallControlAssessment = undeclaredControlAssessment
  prepareGate: Promise<undefined> | undefined
  readonly prepareEntered = Promise.withResolvers<undefined>()

  constructor(private readonly early: (controls: Readonly<LlmCallControls>) => CallControlAssessment | undefined = () => undefined) {
    super()
  }

  override preassessControls(_provider: string, _model: string, controls: Readonly<LlmCallControls>) {
    this.events.push('preassess')
    this.seen.push(controls)
    return this.early(controls)
  }

  override resolveModel(provider: string, model: string) {
    const high = ReasoningEffortId('high')
    return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: high, name: 'High' }], defaultEffort: high } })
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    this.events.push('prepareCall')
    this.prepareEntered.resolve(undefined)
    await this.prepareGate
    signal?.throwIfAborted()
    return { ...await super.prepareCall(provider, model, signal), assessControls: controls => this.captured(controls) }
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.events.push('stream')
    yield finish
  }
}

async function runtime(adapter: LlmAdapter): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([ROUTE], adapter)
  return ctx
}

const request = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: ROUTE, model: MODEL, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })], ...overrides,
})

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('the default early verdict', () => {
  it('declares nothing, so an adapter that does not override it is never refused early', async () => {
    class Plain extends LlmAdapter {
      async * stream(): AsyncIterable<StreamChunk> { yield finish }
    }
    const adapter = new Plain()
    expect(adapter.preassessControls(ROUTE, MODEL, { temperature: 1 })).toBeUndefined()
    const ctx = await runtime(adapter)
    const call = await ctx.llm.prepareCall({ provider: ROUTE, model: MODEL, temperature: 1 })
    expect(call.assessment.fields.temperature).toEqual({ kind: 'unverified', reason: 'adapter-undeclared' })
  })
})

describe('LlmRuntime.prepareCall without a ConfigureCall', () => {
  it('consults the hook once, before the adapter prepares, and refuses on an unsupported verdict', async () => {
    const adapter = new EarlyAdapter(() => unsupported('temperature'))
    const ctx = await runtime(adapter)
    const refusal = await ctx.llm.prepareCall({ provider: ROUTE, model: MODEL, temperature: 0.2 })
      .then(() => undefined, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(LlmError)
    expect(refusal).toMatchObject({
      code: 'UNSUPPORTED_CONTROL',
      failure: { unsupportedControl: { control: 'temperature', reason: 'reasoning-active' } },
    })
    expect(adapter.events).toEqual(['preassess'])
  })

  it('shows the adapter only the supplied control fields, as a detached frozen copy', async () => {
    const adapter = new EarlyAdapter()
    const ctx = await runtime(adapter)
    const stop = ['END']
    const config = { provider: ROUTE, model: MODEL, temperature: 0.5, stop, reasoningEffort: ReasoningEffortId('high') }
    await ctx.llm.prepareCall(config)
    expect(adapter.seen).toHaveLength(1)
    const controls = adapter.seen[0]!
    expect(controls).toEqual({ temperature: 0.5, stop: ['END'], reasoningEffort: 'high' })
    expect(Object.isFrozen(controls)).toBe(true)
    expect(Object.isFrozen(controls.stop)).toBe(true)
    expect(controls.stop).not.toBe(stop)
    expect(Object.isFrozen(stop)).toBe(false)
    stop.push('LATER')
    expect(controls.stop).toEqual(['END'])
  })

  it.each([
    ['an undefined verdict', () => undefined],
    ['a supported verdict', () => assessSuppliedControls({ temperature: 1 }, (): ControlDisposition => ({ kind: 'supported' }))],
    ['an unverified verdict', () => assessSuppliedControls({ temperature: 1 }, (): ControlDisposition => ({ kind: 'unverified', reason: 'protocol-unverified' }))],
  ])('does not bypass the captured generation after %s', async (_name, early) => {
    const adapter = new EarlyAdapter(early)
    adapter.captured = () => unsupported('temperature')
    const ctx = await runtime(adapter)
    await expect(ctx.llm.prepareCall({ provider: ROUTE, model: MODEL, temperature: 1 })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTROL' })
    expect(adapter.events).toEqual(['preassess', 'prepareCall'])
  })

  it('does not advertise support from an early verdict', async () => {
    const adapter = new EarlyAdapter(() => assessSuppliedControls({ temperature: 1 }, (): ControlDisposition => ({ kind: 'supported' })))
    const ctx = await runtime(adapter)
    const call = await ctx.llm.prepareCall({ provider: ROUTE, model: MODEL, temperature: 1 })
    expect(call.assessment.fields.temperature).toEqual({ kind: 'unverified', reason: 'adapter-undeclared' })
  })

  it('skips the hook when a ConfigureCall owns the controls, and calls the callback exactly once', async () => {
    const adapter = new EarlyAdapter(() => unsupported('temperature'))
    const ctx = await runtime(adapter)
    let calls = 0
    const call = await ctx.llm.prepareCall({ provider: ROUTE, model: MODEL, temperature: 1 }, undefined, () => { calls += 1; return {} })
    expect(calls).toBe(1)
    expect(call.config.temperature).toBeUndefined()
    expect(adapter.events).toEqual(['prepareCall'])
  })

  it('never reassesses early when a prepared call is dispatched', async () => {
    const adapter = new EarlyAdapter()
    const ctx = await runtime(adapter)
    const call = await ctx.llm.prepareCall({ provider: ROUTE, model: MODEL, temperature: 1 })
    const output = await drain(call.stream(request(call.config)))
    expect(output.at(-1)).toMatchObject({ type: 'finish' })
    expect(adapter.events).toEqual(['preassess', 'prepareCall', 'stream'])
  })

  it('reports a failing hook as the preparation error without preparing the adapter', async () => {
    const adapter = new EarlyAdapter(() => { throw new LlmError('connection facts unavailable', 'CONFIG') })
    const ctx = await runtime(adapter)
    await expect(ctx.llm.prepareCall({ provider: ROUTE, model: MODEL })).rejects.toMatchObject({ code: 'CONFIG' })
    expect(adapter.events).toEqual(['preassess'])
  })

  it('rejects a pre-aborted call on entry, before the hook', async () => {
    const adapter = new EarlyAdapter(() => unsupported('temperature'))
    const ctx = await runtime(adapter)
    await expect(ctx.llm.prepareCall({ provider: ROUTE, model: MODEL, temperature: 1 }, AbortSignal.abort(new Error('gone'))))
      .rejects.toThrow('gone')
    expect(adapter.events).toEqual([])
  })
})

describe('an unprepared ctx.llm.stream', () => {
  it('refuses on an unsupported early verdict as a terminal failure, before the adapter prepares', async () => {
    const adapter = new EarlyAdapter(() => unsupported('temperature'))
    const ctx = await runtime(adapter)
    const output = await drain(ctx.llm.stream(request({ temperature: 1 })))
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CONTROL', unsupportedControl: { control: 'temperature' } } },
    })
    expect(adapter.events).toEqual(['preassess'])
  })

  it('shows the hook the controls but not the messages', async () => {
    const adapter = new EarlyAdapter()
    const ctx = await runtime(adapter)
    await drain(ctx.llm.stream(request({ temperature: 0.25, maxTokens: 64 })))
    expect(adapter.seen).toEqual([{ temperature: 0.25, maxTokens: 64 }])
    expect(adapter.events).toEqual(['preassess', 'prepareCall', 'stream'])
  })

  it('does not bypass the captured generation after a supported or undefined verdict', async () => {
    const adapter = new EarlyAdapter()
    adapter.captured = () => unsupported('temperature')
    const ctx = await runtime(adapter)
    const output = await drain(ctx.llm.stream(request({ temperature: 1 })))
    expect(output.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'UNSUPPORTED_CONTROL' } } })
    expect(adapter.events).toEqual(['preassess', 'prepareCall'])
  })

  it('stops an already-aborted stream before the hook or adapter preparation', async () => {
    const adapter = new EarlyAdapter(() => unsupported('temperature'))
    const ctx = await runtime(adapter)
    const output = await drain(ctx.llm.stream(request({ temperature: 1, signal: AbortSignal.abort(new Error('gone')) })))
    expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(output.at(-1)).toMatchObject({ reason: { failure: { code: 'ABORTED' } } })
    expect(output.at(-1)).not.toMatchObject({ reason: { failure: { code: 'UNSUPPORTED_CONTROL' } } })
    expect(adapter.events).toEqual([])
  })

  it('finishes as aborted when the caller leaves while the adapter is still preparing', async () => {
    const adapter = new EarlyAdapter()
    const gate = Promise.withResolvers<undefined>()
    adapter.prepareGate = gate.promise
    const ctx = await runtime(adapter)
    const caller = new AbortController()
    const pending = drain(ctx.llm.stream(request({ signal: caller.signal })))
    // The hook has run and the adapter is parked on the barrier; the abort lands in that window.
    await adapter.prepareEntered.promise
    expect(adapter.events).toEqual(['preassess', 'prepareCall'])
    caller.abort(new Error('caller left'))
    gate.resolve(undefined)
    const output = await pending
    expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(adapter.events).toEqual(['preassess', 'prepareCall'])
  })
})
