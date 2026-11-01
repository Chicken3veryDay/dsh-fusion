/** Separate built profile processes own writer exit, restart and conflicting participant locks. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { materializeProfilePatch } from '@deepseek-ai/dsh-session-snapshot'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = join(repo, 'packages/experimental/fusion-participants/tests/fixtures/retained-cleanup')

it('exits the writer before matching built recovery and refuses a separately held participant', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'retained-profile-process-'))
  const children: ReturnType<typeof spawn>[] = []
  const observations: {
    mode: string
    argv: string[]
    exit?: number | null
    signal?: NodeJS.Signals | null
    messages: unknown[]
    output?: string
  }[] = []
  try {
    const patchesDir = join(cwd, 'patches')
    await mkdir(patchesDir)
    const base = join(repo, 'snapshots/session/fusion-host-service-discovery/cordis.snapshot.yml')
    const sources = [join(repo, 'snapshots/session/text-turn/cordis.yml'), base, join(fixture, 'runtime.cordis.yml')]
    const local = join(cwd, 'process.yml')
    await writeFile(local, `- id: llm-replay\n  disabled: true\n- id: agent-default-model\n  config: { provider: retained-process, model: fake }\n- id: session-title\n  disabled: true\n- insert:\n    - id: retained-cleanup-process-fixture\n      name: '${new URL('./fixtures/retained-cleanup/process.ts', import.meta.url).href}'\n`)
    const patches = sources.map((source, index) => materializeProfilePatch(source, cwd, 'headless', patchesDir, index))
    patches.push(materializeProfilePatch(local, cwd, 'headless', patchesDir, sources.length))
    const launch = (mode: string, root?: string, participant?: string) => {
      const argv = [join(repo, 'apps/cli/lib/bin.js'), '--profile', 'headless',
        ...patches.flatMap(path => ['--patch', path]), 'Exercise the fake retained process probe.']
      const record: typeof observations[number] = { mode, argv, messages: [] }
      observations.push(record)
      const child = spawn(process.execPath, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, HOME: join(cwd, 'home'), DSH_HOME: join(cwd, '.dsh'), DSH_AGENTS_HOME: join(cwd, 'agents'),
          XDG_CACHE_HOME: join(cwd, 'cache'), TMPDIR: cwd, DSH_RETAINED_PROCESS_MODE: mode,
          DSH_RETAINED_ROOT: root, DSH_RETAINED_PARTICIPANT: participant },
      })
      children.push(child)
      let output = ''
      child.stdout!.on('data', (chunk) => { output += String(chunk) })
      child.stderr!.on('data', (chunk) => { output += String(chunk) })
      const received = new Map<string, unknown[]>()
      const waiters = new Map<string, (value: unknown) => void>()
      child.on('message', (value: unknown) => {
        record.messages.push(value)
        if (value === null || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return
        const waiter = waiters.get(value.type)
        if (waiter !== undefined) { waiters.delete(value.type); waiter(value) }
        else received.set(value.type, [...received.get(value.type) ?? [], value])
      })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>(resolve => child.once('exit', (code, signal) => {
        record.exit = code; record.signal = signal; record.output = output
        resolve({ code, signal, output })
      }))
      const message = (type: string): Promise<unknown> => {
        const queued = received.get(type)?.shift()
        if (queued !== undefined) return Promise.resolve(queued)
        return Promise.race([new Promise((resolve) => { waiters.set(type, resolve) }),
          exited.then((result) => { throw new Error(`child exited before ${type}: ${JSON.stringify(result)}`) })])
      }
      return { child, exited, message }
    }
    const writer = launch('write')
    const writerExit = await writer.exited
    expect(writerExit, writerExit.output).toMatchObject({ code: 0, signal: null })
    expect(writerExit.output).toContain('RETAINED_PROCESS_OK')
    const sessions = observations[0]!.messages.filter((value): value is { type: string; root: string; participant: string } =>
      typeof value === 'object' && value !== null && 'type' in value && value.type === 'sessions'
      && 'root' in value && typeof value.root === 'string' && 'participant' in value && typeof value.participant === 'string')
    expect(sessions).toHaveLength(2)
    const raw = async () => {
      const root = join(cwd, '.dsh/sessions')
      const files = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
      return Promise.all(files.map(async path => ({ path, bytes: await readFile(join(root, path), 'utf8') })))
    }
    const crash = launch('crash')
    const barrier = await crash.message('crash-ready')
    expect(barrier).toMatchObject({ type: 'crash-ready' })
    if (barrier === null || typeof barrier !== 'object' || !('root' in barrier) || typeof barrier.root !== 'string'
      || !('participant' in barrier) || typeof barrier.participant !== 'string') throw new Error('missing crash Session identities')
    crash.child.kill('SIGKILL')
    expect(await crash.exited).toMatchObject({ code: null, signal: 'SIGKILL' })
    sessions.push({ type: 'sessions', root: barrier.root, participant: barrier.participant })
    const before = await raw()
    for (const file of before) {
      const records = file.bytes.trimEnd().split('\n').map((line: string) => JSON.parse(line) as { seq?: number })
      expect(records[0]).not.toHaveProperty('seq')
      records.slice(1).forEach((event, seq) => { expect(event.seq).toBe(seq) })
    }
    if (process.env.DSH_RETAINED_PROCESS_EVIDENCE !== undefined) {
      await writeFile(process.env.DSH_RETAINED_PROCESS_EVIDENCE + '.raw-before.json', JSON.stringify(before, null, 2) + '\n')
    }
    for (const session of sessions) {
      const reader = launch('read', session.root, session.participant)
      const result = await reader.exited
      expect(result, result.output).toMatchObject({ code: 0, signal: null })
      expect(observations.at(-1)!.messages).toContainEqual({ type: 'recovered', acquisitions: [session.root, session.participant],
        rejected: false })
      const holder = launch('hold', session.root, session.participant)
      await holder.message('held')
      const blocked = launch('refuse', session.root, session.participant)
      const refused = await blocked.exited
      expect(refused, refused.output).toMatchObject({ code: 0, signal: null })
      expect(observations.at(-1)!.messages).toContainEqual({ type: 'recovered', acquisitions: [session.root, session.participant],
        rejected: true })
      holder.child.send({ release: true })
      expect(await holder.exited).toMatchObject({ code: 0, signal: null })
    }
    expect(observations.flatMap(value => value.messages)).not.toContainEqual({ type: 'body' })
    expect(observations.flatMap(value => value.messages)).not.toContainEqual({ type: 'participant-request' })
    const after = await raw()
    if (process.env.DSH_RETAINED_PROCESS_EVIDENCE !== undefined) {
      await writeFile(process.env.DSH_RETAINED_PROCESS_EVIDENCE + '.raw-after.json', JSON.stringify(after, null, 2) + '\n')
    }
    for (const file of before) {
      const recovered = after.find(value => value.path === file.path)!.bytes
      expect(recovered.startsWith(file.bytes)).toBe(true)
      const suffix = recovered.slice(file.bytes.length).trimEnd()
      const types = suffix === '' ? [] : suffix.split('\n').map((line: string) => (JSON.parse(line) as { type: string }).type)
      const owner = sessions.find(session => file.path.includes('/' + session.root + '/'))
      const participant = sessions.some(session => file.path.includes('/' + session.participant + '/'))
      expect(types).toEqual(owner !== undefined ? ['session/end-seed', 'fusion/execution-opened', 'session/end-seed']
        : participant ? ['session/end-seed'] : [])
    }
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
    }
    if (process.env.DSH_RETAINED_PROCESS_EVIDENCE !== undefined) {
      await writeFile(process.env.DSH_RETAINED_PROCESS_EVIDENCE, JSON.stringify(observations, null, 2) + '\n')
    }
    await rm(cwd, { recursive: true, force: true })
  }
}, 60000)
