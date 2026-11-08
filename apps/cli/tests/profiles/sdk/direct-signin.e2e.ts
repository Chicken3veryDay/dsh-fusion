/** Stored DSH sign-ins activate shipped SDK routes and execute the default Script tool. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { execa } from 'execa'
import { expect, it, onTestFinished } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.js'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const networkFixture = fileURLToPath(new URL('./fixtures/direct-signin-network.mjs', import.meta.url))

it.each([true, false])('uses a stored sign-in through the Script-default SDK profile (grant present: %s)', async (signedIn) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-direct-signin-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  await mkdir(home)
  const access = `h.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_synthetic' },
  })).toString('base64url')}.s`
  await writeFile(join(home, '.credentials.yaml'), JSON.stringify({
    version: 1, refs: {}, records: {
      'unrelated-owner/openai-codex': { kind: 'grant', payload: { access: 'unrelated' } },
      ...(signedIn ? {
        'llm-pi-ai/openai-codex': { kind: 'grant', payload: {
          type: 'oauth', access, refresh: 'synthetic-refresh', expires: 4102444800000,
        } },
      } : {}),
    },
  }), { mode: 0o600 })
  const patch = join(root, 'isolation.patch.yml')
  await writeFile(patch, JSON.stringify([{ id: 'skill-filesystem', config: { includeDefaultRoots: false } }]))
  const requestsFile = join(root, 'requests.jsonl')
  const launch = resolveExampleLaunch({
    srcBin: join(repoRoot, 'apps/cli/src/bin.ts'),
    mode: 'lib',
  })
  const child = execa(launch.command, [
    '--import', networkFixture, ...launch.args, '--profile', 'sdk', '--patch', patch,
  ], {
    cwd: root, env: { ...launch.env, DSH_HOME: home, DSH_SIGNIN_REQUESTS: requestsFile,
      DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined },
    // The e2e lane leaves 20 seconds for teardown after this process deadline.
    timeout: 100_000, killSignal: 'SIGKILL', reject: false,
  })
  onTestFinished(async () => { child.kill('SIGKILL'); await child })
  const lines = createInterface({ input: child.stdout })
  onTestFinished(() => { lines.close() })
  const messages: Record<string, unknown>[] = []
  const changed = new Set<() => void>()
  let exited = false
  const settled = (): void => {
    exited = true
    for (const notify of changed) notify()
  }
  void child.then(settled, settled)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  lines.on('line', (line) => {
    messages.push(JSON.parse(line) as Record<string, unknown>)
    for (const notify of changed) notify()
  })
  const waitFor = (predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        changed.delete(check)
        reject(new Error(`SDK response deadline; stderr=${stderr}`))
      }, 90_000)
      const check = (): void => {
        const found = messages.find(predicate)
        if (found === undefined && !exited) return
        clearTimeout(timer)
        changed.delete(check)
        if (found === undefined) reject(new Error(`SDK exited before the expected response; stderr=${stderr}`))
        else resolve(found)
      }
      changed.add(check)
      check()
    })
  const send = (id: number, method: string, params?: object) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return waitFor(value => value.id === id)
  }
  // Choose a catalog model explicitly, rather than the first catalog entry or a saved default.
  const model = 'gpt-6.1-sol'
  const initialized = await send(1, 'initialize', { cwd: root, provider: 'openai-codex', model })
  if (!signedIn) {
    expect(initialized).toHaveProperty('error')
    expect(JSON.stringify(initialized)).toContain('sign in')
    await expect(readFile(requestsFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'signin-proof.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } else {
    expect(initialized, JSON.stringify(initialized) + stderr).toHaveProperty('result')
    expect(await send(2, 'session/prompt', { sessionId: 'signin', contentBlocks: [{ type: 'text', text: 'Write the proof file using Script.' }] }))
      .toHaveProperty('result')
    const turnEnd = await waitFor((value) => {
      const params = value.params as { sessionId?: string; event?: { type: string } } | undefined
      return value.method === 'session.event' && params?.sessionId === 'signin' && params.event?.type === 'turn/end'
    })
    expect(JSON.stringify(turnEnd), JSON.stringify(messages.filter((value) => {
      const params = value.params as { event?: { type: string } } | undefined
      return ['tool/result', 'turn/end'].includes(params?.event?.type ?? '')
    })) + stderr).not.toContain('error')
    const toolResults = messages.filter(value => (value.params as { event?: { type: string } } | undefined)?.event?.type === 'tool/result')
    expect(JSON.stringify(toolResults), stderr).not.toContain('\"isError\":true')
    expect(await readFile(join(root, 'signin-proof.txt'), 'utf8')).toBe('DSH_SCRIPT_EXECUTED\n')
    const requests = (await readFile(requestsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
      authorization: string
      body: { model: string; tools: { name: string }[]; input: { type: string; output?: string }[] }
    })
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${access}`)
      expect(request.body.model).toBe(model)
      expect(request.body.tools.map(tool => tool.name)).toEqual(['run_code'])
    }
    expect(requests[1]!.body.input.find(item => item.type === 'function_call_output')?.output)
      .toContain('DSH_SCRIPT_EXECUTED')
  }
  expect(await send(3, 'shutdown')).toHaveProperty('result')
  const exit = await child
  expect(exit.timedOut, stderr).toBe(false)
  expect(exit.signal, stderr).toBeUndefined()
  expect(exit.exitCode, stderr).toBe(0)
  if (signedIn) {
    const sessions = join(home, 'sessions')
    const paths = await readdir(sessions, { recursive: true })
    const events: SessionEvent[] = []
    for (const path of paths.filter(path => path.endsWith('.jsonl.zstd'))) {
      const bytes = await readFile(join(sessions, path))
      const { frames, tornStart } = scanZstdFrames(bytes)
      expect(tornStart).toBeUndefined()
      events.push(...frames.flatMap(({ start, end }) => zstdDecompressSync(bytes.subarray(start, end))
        .toString().trim().split('\n').map(line => JSON.parse(line) as SessionEvent)))
    }
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['run_code'])
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.data.message.isError).toBe(false)
    const headers = events.filter(event => event.type === 'request/header')
    expect(headers.length).toBeGreaterThan(0)
    for (const header of headers) expect(header.data.header.config).toMatchObject({ provider: 'openai-codex', model })
    expect(JSON.stringify(events.filter(event => event.type === 'tool/result'))).toContain('DSH_SCRIPT_EXECUTED')
  }
})
