/** SDK-profile retained replay owner; fixture bytes enter the real JSONL parser in each process. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import { normalizeSessionSnapshots } from '@deepseek-ai/dsh-session-snapshot'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

/** Replay both retained roles through two independent SDK runtime processes. */
export async function replayRetained(): Promise<void> {
  const fixture = fileURLToPath(new URL('./', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'sdk-fusion-retained-'))
  const home = join(root, 'home')
  const sessions = join(home, 'sessions')
  try {
    for (const [index, id] of ['retained-root', 'retained-child'].entries()) {
      const directory = join(sessions, '_no-cwd', id)
      await mkdir(directory, { recursive: true })
      const content = (await readFile(join(fixture, `session${index === 0 ? '' : '.1'}.v4.jsonl`), 'utf8'))
        .replaceAll('{{session:1}}', 'retained-root').replaceAll('{{session:2}}', 'retained-child')
        .replaceAll('{{message:1}}', 'recorded-history').replaceAll('{{message:2}}', 'recorded-queued')
      const hydrated = content.trim().split('\n').map((line, row) => {
        const value: object = JSON.parse(line)
        return JSON.stringify(row === 0 ? value : { ...value, seq: row - 1, time: 1785097381464 + row })
      }).join('\n') + '\n'
      await writeFile(join(directory, 'session.v4.jsonl'), hydrated)
    }
    const patch = join(root, 'retained.patch.json')
    await writeFile(patch, JSON.stringify([
      { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'none' } },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'sdk-jsonrpc-server', config: { queryCommandDefinitions: ['snapshot/retained-fixture'] } },
      { insert: [{ id: 'retained-fixture', name: join(fixture, 'runtime.mjs') }] },
    ]))
    const expected = JSON.parse(await readFile(join(fixture, 'result.expected.json'), 'utf8')) as object
    for (let process = 0; process < 2; process++) {
      const harness = new DeepSeekHarness({ dshHome: home, processCwd: root, cwd: root, patches: [patch],
        provider: 'deepseek-official', model: 'deepseek-v4-flash',
        env: { DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') } })
      try {
        await harness.start()
        const result = await harness.session(`controller-${process}`).run('/retained_fixture')
        expect(result.finishReason, JSON.stringify(result)).toBe('completed')
        expect(JSON.parse(result.finalResponse)).toEqual(expected)
        expect(result.events.filter(event => event.type === 'command/done')).toMatchObject([{ data: { kind: 'success' } }])
      } finally { await harness.close() }
    }
    const actual: string[] = []
    const expectedLogs: string[] = []
    for (const [index, id] of ['retained-root', 'retained-child'].entries()) {
      const content = await readFile(join(sessions, '_no-cwd', id, 'session.v4.jsonl'), 'utf8')
      actual.push(content)
      expectedLogs.push((await readFile(join(fixture, `recovered${index === 0 ? '' : '.1'}.expected.jsonl`), 'utf8'))
        .replaceAll('{{session:1}}', 'retained-root').replaceAll('{{session:2}}', 'retained-child')
        .replaceAll('{{message:1}}', 'recorded-history').replaceAll('{{message:2}}', 'recorded-queued'))
      const rows = content.trim().split('\n').map((line): { type: string } => JSON.parse(line))
      expect(rows.filter(row => row.type === 'agent/runtime-owner')).toHaveLength(1)
      expect(rows.filter(row => row.type === 'request/header' || row.type === 'turn/start')).toEqual([])
      if (id === 'retained-child') {
        expect(rows.filter(row => row.type === 'agent/inbox/spliced')).toHaveLength(5)
        expect(rows.filter(row => row.type === 'user/message')).toHaveLength(1)
      }
    }
    const context = { sessionIds: ['retained-root', 'retained-child'], cwd: root }
    expect(normalizeSessionSnapshots(actual, context)).toEqual(normalizeSessionSnapshots(expectedLogs, context))
  } finally { await rm(root, { recursive: true, force: true }) }
}
