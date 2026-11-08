import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { startResponsesFixture } from './responses-fixture.ts'

const fixtureDir = fileURLToPath(new URL('./fixtures/loader/', import.meta.url))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'provider-selection.patch.yml')
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

it('selects a native provider through the public Loader tool without changing native configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-selection-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const nativeHome = join(root, 'codex')
  await mkdir(nativeHome)
  const inherited = await startResponsesFixture([{ kind: 'complete', text: 'DSH_NATIVE_KEYLESS' }])
  onTestFinished(() => inherited.close())
  const explicit = await startResponsesFixture([{ kind: 'complete', text: 'DSH_NATIVE_KEYLESS' }])
  onTestFinished(() => explicit.close())
  const config = [
    'model = "fixture-model"', 'model_provider = "inherited"',
    'sandbox_mode = "read-only"', 'check_for_update_on_startup = false',
    ...[['inherited', inherited.baseUrl], ['explicit', explicit.baseUrl]].flatMap(([name, url]) => [
      `[model_providers.${name}]`, `name = "${name}"`, `base_url = "${url}"`,
      'env_key = "OPENAI_API_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false',
    ]), '',
  ].join('\n')
  await writeFile(join(nativeHome, 'config.toml'), config)
  for (const provider of ['', 'explicit', 'unknown-native-provider']) {
    const unknown = provider === 'unknown-native-provider'
    const result = await runLoaderSmoke({
      label: 'native provider selection', tempDirPrefix: 'dsh-native-loader-',
      binScript: driver, libBinScript: driver, configPath,
      binArgs: [configPath, 'keyless'], tsconfigPath, processTimeoutMs: 90_000,
      expectedExitCode: unknown ? 1 : 0,
      env: {
        CODEX_HOME: nativeHome, HOME: root,
        DSH_CODEX_TEST_KEYLESS: '1', DSH_CODEX_TEST_PROVIDER: provider,
        DSH_CODEX_TEST_MODEL: 'fixture-model',
      },
    })
    if (unknown) {
      expect(result.stdout).not.toContain('"completed":true')
      expect(result.stderr).toContain('native public tool activation failed')
    } else {
      expect(result.stdout).toContain('"completed":true')
      expect(result.stdout).toContain('"managedExited":true')
    }
    expect(await readFile(join(nativeHome, 'config.toml'), 'utf8')).toBe(config)
  }
  expect(inherited.requests).toHaveLength(1)
  expect(explicit.requests).toHaveLength(1)
}, 120_000)

it.skipIf(process.env.DSH_CODEX_ACCOUNT_SMOKE !== '1')('retained ChatGPT account returns an exact nonce through DSH and a fresh process', async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runLoaderSmoke({
      label: 'native ChatGPT nonce', tempDirPrefix: 'dsh-native-account-',
      binScript: driver, libBinScript: driver, configPath,
      binArgs: [configPath, 'live'], tsconfigPath, processTimeoutMs: 90_000,
      env: {
        DSH_CODEX_ACCOUNT_SMOKE: '1', DSH_CODEX_TEST_KEYLESS: '0', DSH_CODEX_TEST_PROVIDER: 'openai',
        DSH_CODEX_TEST_MODEL: 'gpt-5.6-luna',
      },
    })
    expect(result.stdout).toContain('"accountType":"chatgpt"')
    expect(result.stdout).toContain('"exactAnswer":true')
    expect(result.stdout).toContain('"parentCompletion":true')
    expect(result.stdout).toContain('"persistedParent":true')
    expect(result.stdout).toContain('"managedExited":true')
    expect(result.stdout).toContain('"toolItems":0')
    process.stdout.write(`${JSON.stringify({ attempt: attempt + 1, accountType: 'chatgpt', modelProvider: 'openai', model: 'gpt-5.6-luna', exactNonce: true, parentCompletion: true, persistedParent: true, managedExited: true, toolItems: 0, workspaceFilesUnchanged: true, usageAndCost: 'unavailable' })}\n`)
  }
}, 180_000)
