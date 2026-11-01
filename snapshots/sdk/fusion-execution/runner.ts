/** SDK replay of cross-session execution facts through closed production authority. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { z } from 'zod'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

/**
 * Normalize only fresh dormant incarnation/opening identities, preserving record order and predecessor links.
 * @param contents - root and participant physical or normalized JSONL.
 * @returns JSONL with stable execution identities; no delivery or stock fields change.
 */
export function normalizeExecutionIdentities(contents: readonly string[]): string[] {
  const record = z.object({ type: z.string(), data: z.record(z.string(), z.unknown()).optional() }).passthrough()
  const logs = contents.map(content => content.trim().split('\n').map(line => record.parse(JSON.parse(line))))
  const incarnations = new Map<string, string>()
  for (const rows of logs) for (const row of rows) {
    if (row.type === 'fusion/execution-opened' && typeof row.data?.incarnation === 'string') {
      incarnations.set(row.data.incarnation, `execution-incarnation-${incarnations.size + 1}`)
    }
  }
  return logs.map(rows => rows.map(row => {
    if (!['fusion/execution-opened', 'fusion/execution-granted', 'fusion/execution-revoked',
      'fusion/effect-started', 'fusion/effect-settled', 'fusion/effect-reconciled'].includes(row.type) || row.data === undefined) return JSON.stringify(row)
    const data = { ...row.data }
    for (const field of ['incarnation', 'previous']) {
      const value = data[field]
      if (typeof value === 'string') data[field] = incarnations.get(value) ?? value
    }
    if (row.type === 'fusion/execution-opened') data.openingId = `execution-opening-${data.incarnation}`
    return JSON.stringify({ ...row, data })
  }).join('\n') + '\n')
}

/** Replay required records and dormant publication in two independent SDK runtime processes. */
export async function replayExecution(): Promise<void> {
  const fixture = fileURLToPath(new URL('./', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'sdk-fusion-execution-'))
  const home = join(root, 'home'), sessions = join(home, 'sessions')
  try {
    for (const [index, id] of ['execution-root', 'execution-child'].entries()) {
      const directory = join(sessions, '_no-cwd', id)
      await mkdir(directory, { recursive: true })
      const content = (await readFile(join(fixture, `session${index === 0 ? '' : '.1'}.v4.jsonl`), 'utf8'))
        .replaceAll('{{session:1}}', 'execution-root').replaceAll('{{session:2}}', 'execution-child')
        .replaceAll('{{message:1}}', 'execution-input')
      const hydrated = content.trim().split('\n').map((line, row) => {
        const value: object = JSON.parse(line)
        return JSON.stringify(row === 0 ? value : { ...value, seq: row - 1, time: 1785097381464 + row })
      }).join('\n') + '\n'
      await writeFile(join(directory, 'session.v4.jsonl'), hydrated)
    }
    const patch = join(root, 'execution.patch.json')
    await writeFile(patch, JSON.stringify([
      { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'none' } },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'sdk-jsonrpc-server', inject: ['sdkAppStartup', 'loader', 'fusionParticipants'],
        config: { queryCommandDefinitions: ['snapshot/execution-fixture'] } },
      { insert: [
        { id: 'execution-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'delivery-empty' } },
        { id: 'execution-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'delivery-empty', plugins: [] } },
        { id: 'execution-config', name: fileURLToPath(new URL('../../../packages/preset/fusion-config/lib/index.js', import.meta.url)),
          config: { document: { credentialRef: 'DELIVERY_TEST', agentPreset: 'delivery-empty', providers: {}, declarations: [], bindings: [], selections: [],
            metadataLimits: { responseBytes: 32768, totalBytes: 262144, pages: 32, timeoutMs: 5000 } } } },
        { id: 'execution-participants', name: fileURLToPath(new URL('../../../packages/experimental/fusion-participants/lib/index.js', import.meta.url)) },
        { id: 'execution-fixture', name: join(fixture, 'runtime.mjs') },
      ] },
    ]))
    const expected: unknown = JSON.parse(await readFile(join(fixture, 'result.expected.json'), 'utf8'))
    for (let process = 0; process < 2; process++) {
      const harness = new DeepSeekHarness({ dshHome: home, processCwd: root, cwd: root, patches: [patch],
        provider: 'deepseek-official', model: 'deepseek-v4-flash',
        env: { DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents'), HOME: join(root, 'os-home') } })
      try {
        await harness.start()
        const result = await harness.session(`execution-controller-${process}`).run('/execution_fixture')
        expect(result.finishReason, JSON.stringify(result)).toBe('completed')
        expect(JSON.parse(result.finalResponse)).toEqual(expected)
      } finally { await harness.close() }
    }
    const logs = await Promise.all(['execution-root', 'execution-child'].map(id =>
      readFile(join(sessions, '_no-cwd', id, 'session.v4.jsonl'), 'utf8')))
    for (const content of logs) {
      const rows = content.trim().split('\n').map(line => z.object({ type: z.string() }).parse(JSON.parse(line)))
      expect(rows.filter(row => row.type === 'request/header' || row.type === 'turn/start')).toEqual([])
    }
    expect(logs[0]?.match(/fusion\/execution-opened/gu)).toHaveLength(3)
    expect(logs[1]?.match(/fusion\/effect-started/gu)).toHaveLength(2)
    expect(logs[1]?.match(/fusion\/effect-settled/gu)).toHaveLength(1)
    expect(logs[1]?.match(/fusion\/effect-reconciled/gu)).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
}
