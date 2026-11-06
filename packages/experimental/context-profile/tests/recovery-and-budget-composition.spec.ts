/** Eager core budget and pending-note recovery through the shipped headless profile and context-profile Loader layer. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const moduleUrl = (path: string): string => pathToFileURL(repoFile(path)).href

const plugin = `
import { writeFileSync } from 'node:fs'
import { LlmAdapter } from '${moduleUrl('packages/llm/llm/src/index.ts')}'
import DefaultCurator from '${moduleUrl('packages/experimental/context-map/src/curator.ts')}'
let owner
let ids
let changed = false
let childRequests = 0
let reportStarted
const started = new Promise(resolve => { reportStarted = resolve })
const scenario = process.env.PROBE_SCENARIO
export const name = 'recovery-budget-context'
export const inject = ['llm', 'contextMap', 'contextTree', 'contextIndex', 'workingDirectory', 'agents']
export function apply(ctx) {
  class Adapter extends LlmAdapter {
    listModels(provider) { return Promise.resolve([{ provider, id: 'small', name: 'Small' }]) }
    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: model === 'small' ? 40000 : 200000 } })
    }
    async * stream(options) {
      const child = options.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('You are the project map curator')))
      if (child) { childRequests++; reportStarted() }
      else if ((options.tools ?? []).length > 0) {
        if (scenario === 'recovery') {
          let timer
          try { await Promise.race([started, new Promise(resolve => { timer = setTimeout(resolve, 2000) })]) }
          finally { clearTimeout(timer) }
          await ctx.get('contextCurator').idle(owner.id)
        }
        const grants = owner.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'context-grant' ? [event.data.source] : [])
        const view = await ctx.contextMap.view(owner)
        writeFileSync(process.env.PROBE_OUTPUT, JSON.stringify({
          chargedBytes: grants.reduce((sum, grant) => sum + (grant.coreBytes ?? 0), 0),
          grants: grants.length, childRequests,
          pending: view.pending.length, indexChanged: view.indexChanged,
        }))
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'PROBE_OK' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PROBE_OK' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['deepseek-official'], new Adapter())
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    owner = agent
    const directory = await ctx.workingDirectory.ensure(agent)
    ids = (await ctx.contextIndex.snapshot({ workingDirectory: directory })).sections
      .filter(section => section.kind === 'project-instructions').map(section => section.id)
    const claim = await ctx.contextMap.claim(agent)
    if (scenario === 'core') {
      await ctx.contextMap.setCore(agent, { expectedRevision: ctx.contextMap.snapshotOf(agent).revision, sections: [ids[0]] })
    } else {
      await ctx.contextMap.acknowledgeIndex(agent, { indexDigest: claim.observedIndexDigest })
      await ctx.contextMap.release(agent)
      await ctx.contextMap.note(agent, { text: 'A durable pending fact.', cites: ['ref:package.json'] })
      await ctx.plugin(DefaultCurator)
    }
  })
  ctx.on('system-prompt/request-context', async ({ agent }, pending, next) => {
    if (scenario === 'core' && agent === owner && !changed) {
      if (!pending.some(message => message.source.kind === 'context-grant')) throw new Error('Missing pre-step control grant')
      changed = true
      await ctx.contextMap.setCore(owner, { expectedRevision: ctx.contextMap.snapshotOf(owner).revision, sections: [ids[1]] })
    }
    return next()
  })
}
`

it.each(['core', 'recovery'] as const)('%s behavior through the real context-profile layer', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-budget-'))
  try {
    const home = join(root, '.dsh')
    const profile = join(home, 'profiles', 'headless')
    await mkdir(profile, { recursive: true })
    await mkdir(join(root, '.git'))
    await writeFile(join(root, 'AGENTS.md'), `# Before\n\n${'a'.repeat(3000)}\n\n# After\n\n${'b'.repeat(3000)}\n`)
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-headless', private: true,
      dependencies: { '@deepseek-ai/dsh-experimental-context-profile': 'workspace:^' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-experimental-context-profile'] } },
    }))
    const fixture = join(root, 'recovery-budget-plugin.mjs')
    await writeFile(fixture, plugin)
    await writeFile(join(profile, 'cordis.patch.yml'), [
      '- id: llm-deepseek', '  disabled: true',
      '- id: typert-loader', '  disabled: true',
      '- id: context-curator', '  disabled: true',
      '- id: session-persistence-jsonl', '  config:', `    root: '${join(home, 'sessions')}'`, '    compression: none',
      '- insert:', '    - id: recovery-budget-context', `      name: '${pathToFileURL(fixture).href}'`, '',
    ].join('\n'))
    const output = join(root, 'result.json')
    const launch = resolveExampleLaunch({
      srcBin: repoFile('apps/cli/src/bin.ts'), tsconfigPath: repoFile('tsconfig.json'),
      configArgs: ['--profile', 'headless', 'Review probe.'],
      env: { DSH_HOME: home, DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '',
        PROBE_OUTPUT: output, PROBE_SCENARIO: scenario },
    })
    const result = await execa(launch.command, launch.args, { cwd: root, env: launch.env, input: '', timeout: 120000, killSignal: 'SIGKILL', reject: false })
    expect(result.exitCode, result.stderr + '\n' + result.stdout).toBe(0)
    expect(result.stdout).toContain('PROBE_OK')
    const recorded = JSON.parse(await readFile(output, 'utf8')) as {
      chargedBytes: number
      grants: number
      childRequests: number
      pending: number
      indexChanged: boolean
    }
    if (scenario === 'core') {
      expect(recorded.grants).toBeGreaterThan(0)
      expect(recorded.chargedBytes, 'the shipped layer shares one 4096-byte eager budget across both hooks').toBeLessThanOrEqual(4096)
    } else {
      expect({ pending: recorded.pending, indexChanged: recorded.indexChanged }).toEqual({ pending: 1, indexChanged: false })
      expect(recorded.childRequests, 'the shipped curator must resume already-pending work').toBeGreaterThan(0)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 180000)
