/** Source annotations and generated ACP context events pass through the SDK reader unchanged. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'

const expectedPath = fileURLToPath(new URL('./expected/acp-source-projection.json', import.meta.url))
const pythonExpectedPath = fileURLToPath(new URL('../../../../python/sdk/tests/expected/acp-source-projection.json', import.meta.url))
const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))

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
