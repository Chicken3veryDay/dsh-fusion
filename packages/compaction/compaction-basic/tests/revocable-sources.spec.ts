import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { resolveRevocationStubBytes } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { RevocableSourceStub } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, {
  createMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  ContextFormed,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'grant-test': { kind: 'grant-test'; section: string } & ContextFormed
  }
}

const SIGNAL = new AbortController().signal
const MODEL = 'test-model'
const FILLER = 'conversation filler '.repeat(40).trim()

class WindowAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class SpyEngine extends BasicCompactionEngine {
  calls: SummarizationInput[] = []

  protected override summarize(input: SummarizationInput): ReturnType<BasicCompactionEngine['summarize']> {
    this.calls.push(input)
    return Promise.resolve({
      summary: [{ type: 'text', text: 'small checkpoint' }],
      provider: 'summary-provider',
      model: 'summary-model',
    })
  }
}

function engineContext(config: ConstructorParameters<typeof SpyEngine>[1] = {}): { ctx: Context; engine: SpyEngine } {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new WindowAdapter())
  return { ctx, engine: new SpyEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 8192, ...config }) }
}

function agent(session: Session): Agent {
  return { session, options: {} } as Agent
}

function grantBody(section: string): string {
  return `GRANT-BODY[${section}] ${'full section text '.repeat(40)}`
}

function grantMessage(section: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: grantBody(section) }],
    source: { kind: 'grant-test', section },
  })
}

interface Fixture {
  readonly session: Session
  /** First and last surface node of the span that holds u1..a3 (three grants: ops, ops, db). */
  readonly span: { start: SessionSeq; end: SessionSeq }
  readonly tailGrantSeq: SessionSeq
}

/**
 * Four closed turns. Turns 2 and 3 each inject the `ops` grant after the user
 * prompt, turn 4 injects `db`; the span ends at turn 3's assistant reply so
 * turn 4 (including its grant) is the retained tail.
 */
function fixture(options: { grants?: readonly string[]; tailGrant?: string } = {}): Fixture {
  const grants = options.grants ?? ['ops', 'ops']
  const session = Session.create(SessionId(`revocable-${Math.random().toString(36).slice(2)}`))
  let lastSpanSeq = SessionSeq(0)
  let tailGrantSeq = SessionSeq(0)
  for (let turn = 1; turn <= 4; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${FILLER} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const grant = turn === 4 ? options.tailGrant ?? 'db' : grants[turn - 2]
    if (grant !== undefined && turn >= 2) {
      const event = session.append('user/message', grantMessage(grant), { surfaceOp: 'append' })
      if (turn === 4) tailGrantSeq = event.seq
    }
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    }
    const reply = session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${FILLER} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    if (turn === 3) lastSpanSeq = reply.seq
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 5 })
  return { session, span: { start: session.surface.nodes[0]!, end: lastSpanSeq }, tailGrantSeq }
}

function texts(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content)
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
}

function register(engine: BasicCompactionEngine): () => Promise<void> {
  return engine.registerRevocableSource('grant-test', (source): RevocableSourceStub => ({
    key: source.section,
    text: `loaded section ${source.section}; reload if needed`,
  }))
}

function checkpointText(session: Session): string {
  const checkpoint = session.deriveMessages()[0]!
  expect(checkpoint.source.kind).toBe('compact-checkpoint')
  return texts([checkpoint])
}

describe('revocable message sources', () => {
  it('omits registered-kind messages from the summarizer input and follows the checkpoint with one stub per key', async () => {
    const { engine } = engineContext()
    register(engine)
    const { session, span } = fixture()

    await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)

    expect(engine.calls).toHaveLength(1)
    const sent = texts(engine.calls[0]!.messages)
    expect(sent).not.toContain('GRANT-BODY')
    expect(sent).toContain('user 1')
    expect(sent).toContain('assistant 3')

    const checkpoint = session.deriveMessages()[0]!
    const blocks = checkpoint.content as ContentBlock[]
    const closeAt = blocks.findIndex(block => block.type === 'text' && block.text === '</compacted-summary>')
    const afterClose = texts([{ ...checkpoint, content: blocks.slice(closeAt + 1) }])
    expect(afterClose.match(/loaded section ops; reload if needed/g)).toHaveLength(1)
    expect(afterClose).not.toContain('GRANT-BODY')
  })

  it('keeps a registered-kind message in the retained tail verbatim', async () => {
    const { engine } = engineContext()
    register(engine)
    const { session, span, tailGrantSeq } = fixture()
    const before = session.deriveEventMessage(session.eventAt(tailGrantSeq)!)

    await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)

    const derived = session.deriveMessages()
    expect(derived).toContainEqual(before)
    expect(texts(derived)).toContain(grantBody('db'))
    expect(checkpointText(session)).not.toContain('section db')
  })

  it('treats unregistered kinds exactly as before', async () => {
    const { engine } = engineContext()
    const { session, span } = fixture()

    await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)

    expect(texts(engine.calls[0]!.messages)).toContain(grantBody('ops'))
    expect(session.deriveMessages()[0]!.content).toHaveLength(3)
  })

  it('stops excluding after the registration is disposed', async () => {
    const { engine } = engineContext()
    const dispose = register(engine)
    await dispose()
    await dispose()
    const { session, span } = fixture()

    await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)

    expect(texts(engine.calls[0]!.messages)).toContain(grantBody('ops'))
    expect(session.deriveMessages()[0]!.content).toHaveLength(3)
  })

  it('removes the registration when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, engine } = engineContext()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      register(inner.compaction as BasicCompactionEngine)
    }, { inject: ['compaction'] }))
    const first = fixture()
    await engine.compactRegion(first.span.start, first.span.end, agent(first.session), SIGNAL)
    expect(texts(engine.calls[0]!.messages)).not.toContain('GRANT-BODY')

    await fiber.dispose()

    const second = fixture()
    await engine.compactRegion(second.span.start, second.span.end, agent(second.session), SIGNAL)
    expect(texts(engine.calls[1]!.messages)).toContain(grantBody('ops'))
    expect(() => register(engine)).not.toThrow()
  })

  it('reproduces the identical model request when the compacted session is replayed', async () => {
    const { engine } = engineContext()
    const dispose = register(engine)
    const { session, span } = fixture()
    await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)
    // Replay must not consult the registry: drop it before rebuilding.
    await dispose()

    const events = JSON.parse(JSON.stringify(session.snapshotEvents())) as SessionEvent[]
    const replayed = Session.create(SessionId('replayed'), events)

    expect(replayed.deriveMessages()).toEqual(session.deriveMessages())
    expect(texts(replayed.deriveMessages())).toContain('loaded section ops; reload if needed')
  })

  it('replaces a span of only revoked context with a stub-only checkpoint and no model call', async () => {
    const { engine } = engineContext()
    register(engine)
    const session = Session.create(SessionId('only-grants'))
    session.append('turn/start', { turn: 1 })
    const first = session.append('user/message', grantMessage('ops'), { surfaceOp: 'append' })
    const second = session.append('user/message', grantMessage('db'), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tail' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await engine.compactRegion(first.seq, second.seq, agent(session), SIGNAL)

    expect(engine.calls).toHaveLength(0)
    const text = checkpointText(session)
    expect(text).toContain('loaded section ops; reload if needed')
    expect(text).toContain('loaded section db; reload if needed')
    expect(text).not.toContain('GRANT-BODY')
  })

  it('records the model call as a revocation-only summary in the log', async () => {
    const { engine } = engineContext()
    register(engine)
    const session = Session.create(SessionId('only-grants-log'))
    session.append('turn/start', { turn: 1 })
    const only = session.append('user/message', grantMessage('ops'), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tail' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await engine.compactRegion(only.seq, only.seq, agent(session), SIGNAL)

    const summary = session.snapshotEvents().find(event => event.type === 'compaction/summary')!
    if (summary.type !== 'compaction/summary') throw new Error('unreachable')
    expect(summary.data.provider).toBe('compaction-basic')
    expect(summary.data.model).toBe('revocation-only')
    expect(summary.data.llmStreamCall).toBeUndefined()
  })

  it('rejects registrations that would revoke human input or a checkpoint', () => {
    const { engine } = engineContext()
    const render = (): RevocableSourceStub => ({ key: 'k', text: 't' })
    expect(() => engine.registerRevocableSource('user', render)).toThrow(/cannot be revoked/)
    expect(() => engine.registerRevocableSource('compact-checkpoint', render)).toThrow(/cannot be revoked/)
  })

  it('rejects a second registration for one kind and leaves the first intact', async () => {
    const { engine } = engineContext()
    register(engine)
    expect(() => register(engine)).toThrow(/already registered/)
    const { session, span } = fixture()
    await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)
    expect(texts(engine.calls[0]!.messages)).not.toContain('GRANT-BODY')
  })

  it('fails the compaction and closes the bracket with the error when a renderer throws', async () => {
    const { engine } = engineContext()
    engine.registerRevocableSource('grant-test', () => { throw new Error('renderer exploded') })
    const { session, span } = fixture()

    await expect(engine.compactRegion(span.start, span.end, agent(session), SIGNAL)).rejects.toThrow('renderer exploded')

    const end = session.snapshotEvents().findLast(event => event.type === 'compaction/end')!
    if (end.type !== 'compaction/end') throw new Error('unreachable')
    expect(end.data.error).toContain('renderer exploded')
    expect(engine.calls).toHaveLength(0)
  })

  describe('stub budget', () => {
    function stubLines(session: Session): string[] {
      const text = checkpointText(session)
      return text.slice(text.indexOf('</compacted-summary>') + '</compacted-summary>'.length)
        .split('\n').filter(line => line.startsWith('- ') && !line.includes('more revoked'))
    }

    function stubBlockBytes(session: Session): number {
      const content = session.deriveMessages()[0]!.content as ContentBlock[]
      const last = content.at(-1)!
      return last.type === 'text' ? Buffer.byteLength(last.text, 'utf8') : 0
    }

    it('defaults to a bound that needs no configuration', () => {
      expect(resolveRevocationStubBytes({})).toBe(2048)
      expect(resolveRevocationStubBytes({ revocationStubBytes: 0 })).toBe(0)
      expect(() => resolveRevocationStubBytes({ revocationStubBytes: -1 })).toThrow(/revocationStubBytes/)
      expect(() => resolveRevocationStubBytes({ revocationStubBytes: 1.5 })).toThrow(/revocationStubBytes/)
    })

    it('keeps the whole stub block within the byte limit and counts the stubs it dropped', async () => {
      const { engine } = engineContext({ revocationStubBytes: 160 })
      engine.registerRevocableSource('grant-test', source => ({ key: source.section, text: `loaded ${source.section} ${'x'.repeat(60)}` }))
      const { session, span } = fixture({ grants: ['a', 'b'] })
      // Two distinct keys, ~70 bytes each: the header plus both cannot fit in 160 bytes.
      await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)

      expect(stubBlockBytes(session)).toBeLessThanOrEqual(160)
      const text = checkpointText(session)
      expect(text).toContain('loaded a')
      expect(text).not.toContain('loaded b')
      expect(text).toMatch(/1 more revoked/)
    })

    it('emits no stub block at a zero budget while still excluding the messages', async () => {
      const { engine } = engineContext({ revocationStubBytes: 0 })
      register(engine)
      const { session, span } = fixture()
      await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)

      expect(texts(engine.calls[0]!.messages)).not.toContain('GRANT-BODY')
      expect(session.deriveMessages()[0]!.content).toHaveLength(3)
    })

    it('measures UTF-8 bytes, not characters, and truncates one oversized stub inside the limit', async () => {
      const { engine } = engineContext({ revocationStubBytes: 120 })
      engine.registerRevocableSource('grant-test', source => ({ key: source.section, text: '段'.repeat(500) }))
      const { session, span } = fixture({ grants: ['a', 'b'] })
      await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)

      expect(stubBlockBytes(session)).toBeLessThanOrEqual(120)
      expect(stubLines(session)).toHaveLength(1)
      expect(stubLines(session)[0]).toMatch(/…$/)
      expect(checkpointText(session)).toMatch(/1 more revoked/)
    })

    it('accepts a stub block of exactly the limit', async () => {
      const probe = engineContext()
      register(probe.engine)
      const sample = fixture({ grants: ['ops', 'ops'] })
      await probe.engine.compactRegion(sample.span.start, sample.span.end, agent(sample.session), SIGNAL)
      const exact = stubBlockBytes(sample.session)

      const { engine } = engineContext({ revocationStubBytes: exact })
      register(engine)
      const { session, span } = fixture({ grants: ['ops', 'ops'] })
      await engine.compactRegion(span.start, span.end, agent(session), SIGNAL)

      expect(stubBlockBytes(session)).toBe(exact)
      expect(checkpointText(session)).toContain('loaded section ops')
      expect(checkpointText(session)).not.toMatch(/more revoked/)
    })
  })
})
