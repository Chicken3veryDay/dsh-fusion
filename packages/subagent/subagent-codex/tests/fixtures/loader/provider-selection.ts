/** Public-profile native provider selection and opt-in account acceptance driver. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

/**
 * Execute a public tool with no parent inference and verify external task settlement.
 * @param configPath - shipped-profile overlay.
 * @param mode - keyless or explicitly opted-in ChatGPT account mode.
 */
export async function runProviderSelection(configPath: string, mode: string): Promise<void> {
  assert(mode === 'keyless' || mode === 'live')
  assert(mode !== 'live' || process.env.DSH_CODEX_ACCOUNT_SMOKE === '1')
  const handles: SubprocessHandle[] = []
  const ctx = await bootProductionProfile({
    binName: 'subagent-codex-provider-selection',
    profile: 'headless',
    overlayPaths: [resolveConfigPath(configPath, undefined)],
    prepare: (host) => {
      // Completion is durable Inbox input, but this acceptance never drives a parent model.
      host.on('agent/pre-step', async () => ({ kind: 'reject' }))
    },
  })
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  let childId: string | undefined
  let starts = 0
  let ends = 0
  let completed = false
  let exactAnswer = false
  const nonce = mode === 'live' ? `DSH_NATIVE_${randomUUID()}` : 'DSH_NATIVE_KEYLESS'
  ctx.on('subagent/start', (info) => {
    assert.equal(info.local, false)
    childId = info.id
    starts += 1
  })
  ctx.on('subagent/end', (info) => {
    assert.equal(info.id, childId)
    ends += 1
    completed = info.stopReason === 'completed'
    exactAnswer = info.lastAssistantMessage?.map(block => block.type === 'text' ? block.text : '').join('') === nonce
  })
  try {
    if (mode === 'live') {
      const manifestPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
      const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
      assert(manifest && typeof manifest === 'object' && 'version' in manifest && 'bin' in manifest)
      assert.equal(manifest.version, '0.153.4')
      const bin = manifest.bin
      assert(bin && typeof bin === 'object' && 'codex' in bin && typeof bin.codex === 'string')
      const preflight = spawn({
        argv: [process.execPath, resolve(dirname(manifestPath), bin.codex), '--config', 'model_provider="openai"', 'app-server', '--stdio'], cwd: process.cwd(),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1000,
      })
      handles.push(preflight)
      preflight.stderr?.resume()
      assert(preflight.stdout && preflight.stdin)
      const wire = new JsonRpcLineTransport(preflight.stdout, preflight.stdin)
      try {
        wire.start()
        const signal = AbortSignal.timeout(20_000)
        await wire.request('initialize', { clientInfo: { name: 'deepseek-harness', version: '0.0.1' }, capabilities: { experimentalApi: false } }, signal)
        wire.notify('initialized')
        const raw = await wire.request('account/read', { refreshToken: false }, signal)
        assert(raw && typeof raw === 'object' && 'account' in raw && 'requiresOpenaiAuth' in raw)
        const account = raw.account
        assert(account && typeof account === 'object' && 'type' in account)
        assert.equal(account.type, 'chatgpt', 'live acceptance requires retained ChatGPT mode')
        assert.equal(raw.requiresOpenaiAuth, true)
        const models = await wire.request('model/list', { limit: 100 }, signal)
        assert(models && typeof models === 'object' && 'data' in models && Array.isArray(models.data))
        assert(models.data.some((row: unknown) => row && typeof row === 'object' && 'model' in row && row.model === 'gpt-5.6-luna'), 'cheap model must be listed')
        process.stdout.write(`${JSON.stringify({ accountType: 'chatgpt', requiresOpenaiAuth: true, cheapModelListed: true })}\n`)
      } finally {
        wire.close()
        preflight.terminate()
        await preflight.waitForExit()
        await preflight.done
      }
    }
    // Observe the real managed process without changing its arguments, environment, or ownership.
    let toolItems = 0
    const filesBefore = await readdir(process.cwd())
    ctx.subprocess.spawn = (spec) => {
      const handle = spawn(spec)
      handles.push(handle)
      let buffer = ''
      handle.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const frame: unknown = JSON.parse(line)
          if (!frame || typeof frame !== 'object' || !('method' in frame) || frame.method !== 'item/started') continue
          assert('params' in frame && frame.params && typeof frame.params === 'object' && 'item' in frame.params)
          const item = frame.params.item
          assert(item && typeof item === 'object' && 'type' in item && typeof item.type === 'string')
          if (!['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(item.type)) toolItems += 1
        }
      })
      return handle
    }
    const parent = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: process.cwd() } })
    try {
      const result = await ctx.tools.execute({
        agent: parent.agent,
        calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name: 'subagent_codex', arguments: JSON.stringify({ description: 'Native provider nonce', prompt: `Reply with exactly ${nonce}. No tools, files, or other text.` }) }],
        signal: AbortSignal.timeout(60_000),
      })
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0]?.result.isError, false, 'native public tool activation failed')
      await ctx.subagents.waitForChildren(parent.agent)
      await parent.agent.whenIdle()
      assert.equal(starts, 1)
      assert.equal(ends, 1)
      assert(completed, 'native turn did not complete')
      assert.equal(toolItems, 0, 'nonce must use no tools')
      assert.deepEqual(await readdir(process.cwd()), filesBefore, 'nonce must create no workspace files')
      // Keyless fixtures have a fixed answer; the live model must reproduce the random nonce.
      assert(exactAnswer, 'native answer did not equal the nonce')
      const events = parent.agent.session.snapshotEvents()
      const catalog = events.filter(event => event.type === 'subagent/catalog')
      assert.equal(catalog.length, 1)
      assert.equal(catalog[0]?.data.mode, 'external')
      assert.equal(catalog[0]?.data.childId, childId)
      const value = result.results[0]?.result.value
      assert(value && typeof value === 'object' && !Array.isArray(value) && 'subagentId' in value)
      assert.equal(value.subagentId, childId)
      assert(events.some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => JSON.stringify(message).includes(nonce) && JSON.stringify(message).includes(childId ?? 'missing-child-id'))), 'parent must log completion input')
      for (const handle of handles) {
        assert(await handle.waitForExit())
        await handle.done
      }
      process.stdout.write(`${JSON.stringify({ mode, completed, exactAnswer, toolItems, workspaceFilesUnchanged: true, starts, ends, externalCatalog: true, parentCompletion: true, managedExited: true, nativeUsageAndCost: 'unavailable' })}\n`)
    } finally {
      await parent.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
    for (const handle of handles) {
      handle.terminate()
      await handle.waitForExit()
      await handle.done
    }
  }
}
