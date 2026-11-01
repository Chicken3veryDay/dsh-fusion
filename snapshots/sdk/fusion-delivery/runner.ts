/** SDK-profile retained replay owner; fixture bytes enter the real JSONL parser in each process. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { normalizeSessionSnapshots } from '@deepseek-ai/dsh-session-snapshot'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

/** Replay both retained roles through two independent SDK runtime processes. */
export async function replayDelivery(): Promise<void> {
  const fixture = fileURLToPath(new URL('./', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'sdk-fusion-delivery-'))
  const home = join(root, 'home')
  const sessions = join(home, 'sessions')
  try {
    for (const [index, id] of ['delivery-root', 'delivery-child'].entries()) {
      const directory = join(sessions, '_no-cwd', id)
      await mkdir(directory, { recursive: true })
      const content = (await readFile(join(fixture, `session${index === 0 ? '' : '.1'}.v4.jsonl`), 'utf8'))
        .replaceAll('{{session:1}}', 'delivery-root').replaceAll('{{session:2}}', 'delivery-child')
        .replaceAll('{{message:1}}', 'recorded-delivery-message')
      const hydrated = content.trim().split('\n').map((line, row) => {
        const value: object = JSON.parse(line)
        return JSON.stringify(row === 0 ? value : { ...value, seq: row - 1, time: 1785097381464 + row })
      }).join('\n') + '\n'
      await writeFile(join(directory, 'session.v4.jsonl'), hydrated)
    }
    const patch = join(root, 'delivery.patch.json')
    await writeFile(patch, JSON.stringify([
      { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'none' } },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'sdk-jsonrpc-server', inject: ['sdkAppStartup', 'loader', 'fusionParticipants'], config: { queryCommandDefinitions: ['snapshot/delivery-fixture', ...['root', 'receiver', 'completion'].map(phase => `snapshot/delivery-shutdown-${phase}`)] } },
      { insert: [
        { id: 'delivery-guard', name: join(fixture, 'guard.mjs') },
        { id: 'delivery-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'delivery-empty' } },
        { id: 'delivery-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'delivery-empty', plugins: [] } },
        { id: 'delivery-config', name: fileURLToPath(new URL('../../../packages/preset/fusion-config/lib/index.js', import.meta.url)), config: { document: {
          credentialRef: 'DELIVERY_TEST', agentPreset: 'delivery-empty', providers: {}, declarations: [], bindings: [], selections: [],
          metadataLimits: { responseBytes: 32768, totalBytes: 262144, pages: 32, timeoutMs: 5000 },
        } } },
        { id: 'delivery-participants', name: fileURLToPath(new URL('../../../packages/experimental/fusion-participants/lib/index.js', import.meta.url)) },
        { id: 'delivery-fixture', name: join(fixture, 'runtime.mjs') },
      ] },
    ]))
    const expected = JSON.parse(await readFile(join(fixture, 'result.expected.json'), 'utf8')) as object
    for (let process = 0; process < 2; process++) {
      const harness = new DeepSeekHarness({ dshHome: home, processCwd: root, cwd: root, patches: [patch],
        provider: 'deepseek-official', model: 'deepseek-v4-flash',
        env: { DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } })
      try {
        await harness.start()
        const result = await harness.session(`controller-${process}`).run('/delivery_fixture')
        expect(result.finishReason, JSON.stringify(result)).toBe('completed')
        expect(JSON.parse(result.finalResponse)).toEqual(expected)
        expect(result.events.filter(event => event.type === 'command/done')).toMatchObject([{ data: { kind: 'success' } }])
      } finally { await harness.close() }
    }
    const shutdownExpected: unknown = JSON.parse(await readFile(join(fixture, 'shutdown.expected.json'), 'utf8'))
    const shutdown: unknown[] = []
    for (const phase of ['root', 'receiver', 'completion']) {
      const control = join(root, `shutdown-${phase}`)
      await mkdir(control)
      const harness = new DeepSeekHarness({ dshHome: home, processCwd: root, cwd: root, patches: [patch],
        provider: 'deepseek-official', model: 'deepseek-v4-flash',
        env: { DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'), DSH_FUSION_SHUTDOWN_CONTROL: control } })
      try {
        await harness.start()
        const ready = await harness.session(`shutdown-${phase}`).run(`/delivery_shutdown_${phase}`)
        expect(ready.finishReason, JSON.stringify(ready)).toBe('completed')
        expect(JSON.parse(ready.finalResponse)).toEqual({ phase, ready: true })
        await writeFile(join(control, 'start'), '')
        await expect.poll(async () => {
          const error = await readFile(join(control, 'error.json'), 'utf8').catch(() => '')
          if (error) throw new Error(error)
          return readFile(join(control, 'result.json'), 'utf8')
        }, { timeout: 15000 }).toBeTruthy()
        const before: object = JSON.parse(await readFile(join(control, 'before.json'), 'utf8'))
        const result: unknown = JSON.parse(await readFile(join(control, 'result.json'), 'utf8'))
        expect(result).toMatchObject(before)
        shutdown.push(result)
      } finally { await harness.close() }
    }
    expect(shutdown).toEqual(shutdownExpected)
    // A fresh runtime after raw teardown must recover the same identities and revision without requests.
    const final = new DeepSeekHarness({ dshHome: home, processCwd: root, cwd: root, patches: [patch],
      provider: 'deepseek-official', model: 'deepseek-v4-flash',
      env: { DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } })
    try {
      await final.start()
      const result = await final.session('shutdown-recovery').run('/delivery_fixture')
      expect(result.finishReason).toBe('completed')
      expect(JSON.parse(result.finalResponse)).toEqual(expected)
    } finally { await final.close() }
    const actual: string[] = []
    const expectedLogs: string[] = []
    for (const [index, id] of ['delivery-root', 'delivery-child'].entries()) {
      const content = await readFile(join(sessions, '_no-cwd', id, 'session.v4.jsonl'), 'utf8')
      actual.push(content)
      expectedLogs.push((await readFile(join(fixture, `recovered${index === 0 ? '' : '.1'}.expected.jsonl`), 'utf8'))
        .replaceAll('{{session:1}}', 'delivery-root').replaceAll('{{session:2}}', 'delivery-child')
        .replaceAll('{{message:1}}', 'recorded-delivery-message'))
      const rows = content.trim().split('\n').map((line): { type: string } => JSON.parse(line))
      expect(rows.filter(row => row.type === 'agent/runtime-owner')).toHaveLength(1)
      expect(rows.filter(row => row.type === 'request/header' || row.type === 'turn/start')).toEqual([])
      if (id === 'delivery-child') {
        expect(rows.filter(row => row.type === 'agent/inbox/spliced')).toHaveLength(2)
        expect(rows.filter(row => row.type === 'user/message')).toHaveLength(0)
      }
    }
    const context = { sessionIds: ['delivery-root', 'delivery-child'], cwd: root }
    expect(normalizeSessionSnapshots(actual, context)).toEqual(normalizeSessionSnapshots(expectedLogs, context))
  } finally { await rm(root, { recursive: true, force: true }) }
}
