/** Source annotations and generated ACP context events pass through the SDK reader unchanged. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'

const expectedPath = fileURLToPath(new URL('./expected/acp-source-projection.json', import.meta.url))
const pythonExpectedPath = fileURLToPath(new URL('../../../../python/sdk/tests/expected/acp-source-projection.json', import.meta.url))
const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))
/** Session log the shipped `dsh --profile acp` composition wrote in the keyless recorded-session snapshot. */
const productSessionPath = fileURLToPath(new URL('../../../../snapshots/acp/context-instructions/session.v4.jsonl', import.meta.url))

function userMessageData(event: unknown): unknown {
  if (typeof event !== 'object' || event === null || !('type' in event) || event.type !== 'user/message') return undefined
  return 'data' in event ? event.data : undefined
}

interface Fixture {
  events: Array<{ type: string; data: { id: string; source: Record<string, unknown> } }>
  projection: unknown[]
}

it('keeps the TypeScript and Python SDK fixtures identical', async () => {
  expect(await readFile(expectedPath, 'utf8')).toBe(await readFile(pythonExpectedPath, 'utf8'))
})

it('preserves the ACP input annotation, unknown channels, and the generated packet, keeping authority with source.kind', async () => {
  const fixture = JSON.parse(await readFile(expectedPath, 'utf8')) as Fixture
  const harness = createProcessDeepSeekHarness({
    command: process.execPath, args: [fakeRuntime],
    environment: () => ({ ...process.env, FAKE_SESSION_EVENTS: JSON.stringify(fixture.events) }),
    description: 'scripted ACP source projection', initializeTimeoutMs: 5000,
  })
  try {
    const result = await harness.run([{ type: 'text', text: 'read the scripted events' }])
    const received = result.events.filter(event => event.type === 'user/message')
    expect(received.map(({ seq: _seq, time: _time, ...event }) => event)).toEqual(fixture.events)
    expect(received.map(event => ({
      id: event.data.id,
      authority: event.data.source.kind,
      input: 'input' in event.data.source ? event.data.source.input : null,
      packet: event.data.source.kind === 'acp-context',
    }))).toEqual(fixture.projection)
    const notified: unknown[] = []
    for (const notification of result.notifications) {
      if (notification.method !== 'session.event') continue
      const data = userMessageData(notification.params.event)
      if (data !== undefined) notified.push(data)
    }
    expect(notified).toEqual(fixture.events.map(event => event.data))
  } finally {
    await harness.close()
  }
})

it('reads the ACP product session output through the process reader with each source kind and its authority intact', async () => {
  const logged = (await readFile(productSessionPath, 'utf8')).split('\n').filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { type: string; data: { id: string; source: Record<string, unknown> } })
  const events = logged.filter(event => event.type === 'user/message')
  const harness = createProcessDeepSeekHarness({
    command: process.execPath, args: [fakeRuntime],
    environment: () => ({ ...process.env, FAKE_SESSION_EVENTS: JSON.stringify(events) }),
    description: 'ACP product session output', initializeTimeoutMs: 5000,
  })
  try {
    const result = await harness.run([{ type: 'text', text: 'read the product events' }])
    const received = result.events.filter(event => event.type === 'user/message')
    expect(received.map(({ seq: _seq, time: _time, ...event }) => event)).toEqual(events)
    const [input, instructions, packet, runtime] = received.map(event => event.data)
    expect(received.map(event => event.data.source.kind)).toEqual(['user', 'agent-instructions', 'acp-context', 'runtime-context'])
    // Authority stays with source.kind: only the client's input is a user message, and it carries the ACP channel.
    expect(input!.source).toEqual({ kind: 'user', input: { kind: 'acp' } })
    expect(instructions!.source).toMatchObject({ kind: 'agent-instructions', baseline: true })
    expect(packet!.source).toMatchObject({ kind: 'acp-context', recipient: 'acp-automation', latestInput: input!.id })
    // The goal fact arrives as a runtime-context section, a snapshot that carries no ACP channel or authority.
    expect(runtime!.source).toMatchObject({ kind: 'runtime-context', form: 'snapshot' })
    expect(runtime!.source).not.toHaveProperty('input')
    expect((runtime!.source.sections as { name: string; text: string }[]).find(section => section.name === 'acp:goal')?.text).toBe('Goal: none.')
  } finally {
    await harness.close()
  }
})
