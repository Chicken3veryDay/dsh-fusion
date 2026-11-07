import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { discoverBaselineInstructionFiles } from '@deepseek-ai/dsh-agent-instructions'
import { FsError, FsVersion, type FsDirEntry, type FsInfo, type FsTarget } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContextIndexService, { ContextIndexError, ContextSectionIdOf, type Config, type ContextSectionId } from '../src/index.ts'
import { ConfigSchema, resolveConfig } from '../src/config.ts'
import { contentHash } from '../src/ids.ts'
import { LISTING_SETTLE_MS } from '../src/sources.ts'

/** Local filesystem with call recording, failure injection, and a barrier on reads. */
class ProbeFileSystem extends LocalFileSystem {
  readCalls: string[] = []
  listCalls: string[] = []
  readSignals: AbortSignal[] = []
  /** Directories, by path suffix, whose version `stat` reports as this fixed value. */
  pinned = new Map<string, FsVersion>()
  failRead = new Set<string>()
  failList = new Set<string>()
  /** Failures, by path suffix, that `stat` throws as given (an Error, an FsError, or any other value). */
  failStat = new Map<string, unknown>()
  /** FsError codes, by path suffix, that `readBytes` throws after its gate. */
  failReadWith = new Map<string, 'FS_TOO_LARGE' | 'FS_NOT_TEXT'>()
  /** Whether `stat` leaves out the byte size, as a backend that cannot report it does. */
  hideSize = false
  /** Whether `listDir` returns entries in reverse name order. */
  reverseList = false
  /** Whether `listDir` returns every entry twice, as a backend that repeats a name would. */
  repeatList = false
  gate: Promise<void> | undefined
  entered: (() => void) | undefined

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    this.readCalls.push(target.displayPath)
    if (signal !== undefined) this.readSignals.push(signal)
    this.entered?.()
    if (this.gate !== undefined) await this.until(this.gate, signal)
    for (const suffix of this.failRead) {
      if (target.displayPath.endsWith(suffix)) throw new FsError('injected read failure', 'FS_IO_ERROR')
    }
    for (const [suffix, code] of this.failReadWith) {
      if (target.displayPath.endsWith(suffix)) throw new FsError('injected read failure', code)
    }
    return super.readBytes(target, signal, maxBytes)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    for (const [suffix, failure] of this.failStat) {
      if (target.displayPath.endsWith(suffix)) throw failure
    }
    const found = await super.stat(target, signal)
    const info = this.hideSize && found !== undefined ? { version: found.version, type: found.type } : found
    const pinned = [...this.pinned].find(([suffix]) => target.displayPath.endsWith(suffix))?.[1]
    return info === undefined || pinned === undefined ? info : { ...info, version: pinned }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    this.listCalls.push(target.displayPath)
    for (const suffix of this.failList) {
      if (target.displayPath.endsWith(suffix)) throw new FsError('injected list failure', 'FS_PERMISSION_DENIED')
    }
    const entries = await super.listDir(target, signal)
    const listed = this.reverseList ? entries.toReversed() : entries
    return this.repeatList ? listed.flatMap(entry => [entry, entry]) : listed
  }

  readsOf(suffix: string): number {
    return this.readCalls.filter(path => path.endsWith(suffix)).length
  }

  private until(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        reject(new FsError('read aborted', 'FS_ABORTED'))
      }
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      void gate.then(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      })
    })
  }
}

const DOCS = 'docs'

interface World {
  root: string
  home: string
  agentsHome: string
  project: string
  ctx: Context
  fs: ProbeFileSystem
  index: ContextIndexService
}

const roots: string[] = []
const contexts: Context[] = []

beforeEach(() => {
  vi.stubEnv('DSH_HOME', '')
  vi.stubEnv('DSH_AGENTS_HOME', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

async function world(config: Config = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-index-')))
  roots.push(root)
  const home = join(root, 'home')
  const agentsHome = join(root, 'agents-home')
  const project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(agentsHome)
  mkdirSync(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_AGENTS_HOME', agentsHome)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ProbeFileSystem, { cwd: '/' })
  await ctx.plugin(ContextIndexService, config)
  return { root, home, agentsHome, project, ctx, fs: ctx.fs as ProbeFileSystem, index: ctx.contextIndex }
}

const scopeOf = (w: World, sub = ''): { workingDirectory: string } => ({ workingDirectory: sub === '' ? w.project : join(w.project, sub) })

describe('sources and precedence', () => {
  it('orders user-global files, then the root-to-working-directory chain, as agent-instructions discovers them', async () => {
    const w = await world()
    write(join(w.home, 'AGENTS.md'), '# Home\nh\n')
    write(join(w.agentsHome, 'AGENTS.md'), '# Agents home\na\n')
    write(join(w.project, 'AGENTS.md'), '# Root\nr\n')
    write(join(w.project, 'CLAUDE.md'), '# Root claude\nc\n')
    write(join(w.project, 'AGENTS.local.md'), '# Root local\nl\n')
    write(join(w.project, 'pkg', 'AGENTS.md'), '# Pkg\np\n')
    write(join(w.project, 'pkg', 'sub', 'CLAUDE.md'), '# Sub\ns\n')
    write(join(w.project, 'other', 'AGENTS.md'), '# Not on the chain\n')
    const cwd = join(w.project, 'pkg', 'sub')

    const expected = (await discoverBaselineInstructionFiles({
      cwd,
      dshHome: w.home,
      agentsHome: w.agentsHome,
      projectRootMarkers: ['.git'],
    })).map(file => file.displayPath)
    const snapshot = await w.index.snapshot({ workingDirectory: cwd })

    expect(snapshot.sources.map(source => source.path)).toEqual(expected)
    expect(snapshot.sources.map(source => source.path)).toEqual([
      '$DSH_HOME/AGENTS.md',
      '$DSH_AGENTS_HOME/AGENTS.md',
      'AGENTS.md',
      'CLAUDE.md',
      'AGENTS.local.md',
      'pkg/AGENTS.md',
      'pkg/sub/CLAUDE.md',
    ])
    expect(snapshot.sources.map(source => source.kind)).toEqual([
      'user-instructions',
      'user-instructions',
      ...Array(5).fill('project-instructions') as string[],
    ])
    expect(snapshot.sources.map(source => source.order)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(snapshot.diagnostics).toEqual([])
  })

  it('collapses trimmed-content duplicates inside a directory group like agent-instructions', async () => {
    const w = await world()
    write(join(w.home, 'AGENTS.md'), '# Same\nx\n')
    write(join(w.agentsHome, 'AGENTS.md'), '\n# Same\nx\n\n')
    write(join(w.project, 'AGENTS.md'), '# Dir\nsame\n')
    write(join(w.project, 'CLAUDE.md'), '# Dir\nsame\n  \n')
    write(join(w.project, 'AGENTS.local.md'), '# Dir\nsame\n')
    write(join(w.project, 'pkg', 'AGENTS.md'), '# Dir\nsame\n')
    const snapshot = await w.index.snapshot(scopeOf(w, 'pkg'))
    expect(snapshot.sources.map(source => source.path)).toEqual(['$DSH_HOME/AGENTS.md', 'AGENTS.md', 'pkg/AGENTS.md'])
  })

  it('indexes Markdown under the doc roots in name order and skips hidden, vendored, and other files', async () => {
    const w = await world()
    write(join(w.project, 'docs', 'z.md'), '# Z\n')
    write(join(w.project, 'docs', 'a', 'b.MD'), '# B\n')
    write(join(w.project, 'docs', '.hidden', 'x.md'), '# X\n')
    write(join(w.project, 'docs', 'node_modules', 'y.md'), '# Y\n')
    write(join(w.project, 'docs', 'skip.txt'), 'no\n')
    write(join(w.project, 'doc', 'c.markdown'), '# C\n')
    write(join(w.project, 'notes', 'n.md'), '# N\n')
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => [source.kind, source.path])).toEqual([
      ['doc', `${DOCS}/a/b.MD`],
      ['doc', `${DOCS}/z.md`],
      ['doc', 'doc/c.markdown'],
    ])
  })

  it('reads through the configured filesystem service only', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\n')
    write(join(w.project, 'docs', 'd.md'), '# D\n')
    await w.index.snapshot(scopeOf(w))
    expect(w.fs.readCalls.sort()).toEqual([join(w.project, 'AGENTS.md'), join(w.project, 'docs', 'd.md')].sort())
  })
})

describe('sections and ids', () => {
  it('describes each section with a path and heading anchor, byte size, and content hash', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), 'intro\n# Top\nt\n## Sub\ns\n')
    const { sections } = await w.index.snapshot(scopeOf(w))
    expect(sections.map(section => section.anchor)).toEqual(['AGENTS.md', 'AGENTS.md#Top', 'AGENTS.md#Top > Sub'])
    expect(sections.map(section => section.bytes)).toEqual([6, 8, 9])
    expect(sections.map(section => section.order)).toEqual([0, 1, 2])
    for (const section of sections) {
      expect(section.id).toMatch(/^sec_[0-9a-f]{16}$/)
      expect(section.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
    expect(new Set(sections.map(section => section.id)).size).toBe(3)
  })

  it('keeps section ids across content edits while hashes change', async () => {
    const w = await world()
    const file = join(w.project, 'AGENTS.md')
    write(file, '# One\nfirst\n# Two\nsecond\n')
    const before = await w.index.snapshot(scopeOf(w))
    write(file, '# One\nfirst, edited and longer\n# Two\nsecond\n')
    const after = await w.index.snapshot(scopeOf(w))

    expect(after.sections.map(section => section.id)).toEqual(before.sections.map(section => section.id))
    expect(after.sources[0]?.id).toBe(before.sources[0]?.id)
    expect(after.sections[0]?.hash).not.toBe(before.sections[0]?.hash)
    expect(after.sections[1]?.hash).toBe(before.sections[1]?.hash)
    expect(after.sources[0]?.hash).not.toBe(before.sources[0]?.hash)
    expect(after.revision).toBe(before.revision + 1)
  })

  it('gives repeated headings distinct stable ids and keeps part one stable when a section grows past the bound', async () => {
    const w = await world({ maxSectionBytes: 64 })
    const file = join(w.project, 'AGENTS.md')
    write(file, '# Same\na\n# Same\nb\n')
    const small = await w.index.snapshot(scopeOf(w))
    expect(new Set(small.sections.map(section => section.id)).size).toBe(2)

    write(file, `# Same\na\n\n${'p'.repeat(60)}\n\n${'q'.repeat(60)}\n# Same\nb\n`)
    const grown = await w.index.snapshot(scopeOf(w))
    const parts = grown.sections.filter(section => section.headingPath[0] === 'Same' && section.partCount > 1)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map(part => part.part)).toEqual(parts.map((_, index) => index + 1))
    expect(grown.sections[0]?.id).toBe(small.sections[0]?.id)
    expect(grown.sections.at(-1)?.id).toBe(small.sections[1]?.id)
    for (const part of parts) expect(part.bytes).toBeLessThanOrEqual(64)
  })

  it('splits an oversized section at paragraph boundaries and reads the parts back losslessly', async () => {
    const w = await world({ maxSectionBytes: 100 })
    const body = `# H\n\n${'a'.repeat(40)}\n\n${'b'.repeat(40)}\n\n${'c'.repeat(40)}\n`
    write(join(w.project, 'docs', 'big.md'), body)
    const { sections } = await w.index.snapshot(scopeOf(w))
    expect(sections).toHaveLength(2)
    const result = await w.index.read(scopeOf(w), sections.map(section => section.id))
    expect(result.sections.map(section => section.text).join('')).toBe(body)
    expect(result.sections.every(section => !section.truncated)).toBe(true)
  })
})

describe('refresh and change detection', () => {
  it('returns the same snapshot object until a file changes and does not re-read unchanged files', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\nx\n')
    const first = await w.index.snapshot(scopeOf(w))
    const second = await w.index.snapshot(scopeOf(w))
    expect(second).toBe(first)
    expect(w.fs.readsOf('AGENTS.md')).toBe(1)
  })

  it('re-reads a touched file but keeps the snapshot when its hash is unchanged', async () => {
    const w = await world()
    const file = join(w.project, 'AGENTS.md')
    write(file, '# A\nx\n')
    const first = await w.index.snapshot(scopeOf(w))
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    const second = await w.index.snapshot(scopeOf(w))
    expect(w.fs.readsOf('AGENTS.md')).toBe(2)
    expect(second).toBe(first)
  })

  it('notices added and removed files and a changed size', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\nx\n')
    const first = await w.index.snapshot(scopeOf(w))
    write(join(w.project, 'docs', 'new.md'), '# New\n')
    const added = await w.index.snapshot(scopeOf(w))
    expect(added.sources.map(source => source.path)).toEqual(['AGENTS.md', `${DOCS}/new.md`])
    expect(added.revision).toBe(first.revision + 1)
    rmSync(join(w.project, 'docs', 'new.md'))
    const removed = await w.index.snapshot(scopeOf(w))
    expect(removed.sources.map(source => source.path)).toEqual(['AGENTS.md'])
    expect(removed.revision).toBe(added.revision + 1)
  })

  it('keeps one index per working directory and evicts the least recently used', async () => {
    const w = await world({ maxIndexedDirectories: 1 })
    write(join(w.project, 'AGENTS.md'), '# A\n')
    write(join(w.project, 'pkg', 'AGENTS.md'), '# P\n')
    await w.index.snapshot(scopeOf(w))
    await w.index.snapshot(scopeOf(w, 'pkg'))
    const reads = w.fs.readsOf('AGENTS.md')
    await w.index.snapshot(scopeOf(w))
    expect(w.fs.readsOf('AGENTS.md')).toBeGreaterThan(reads)
  })

  it('rejects a relative or missing working directory', async () => {
    const w = await world()
    await expect(w.index.snapshot({ workingDirectory: 'relative/dir' })).rejects.toMatchObject({ code: 'CONTEXT_INDEX_INVALID_INPUT' })
    await expect(w.index.snapshot({ workingDirectory: join(w.root, 'missing') })).rejects.toMatchObject({ code: 'CONTEXT_INDEX_INVALID_INPUT' })
    await expect(w.index.snapshot({ workingDirectory: join(w.project, '.git') })).resolves.toBeDefined()
    write(join(w.root, 'file.txt'), 'x')
    await expect(w.index.snapshot({ workingDirectory: join(w.root, 'file.txt') })).rejects.toMatchObject({ code: 'CONTEXT_INDEX_INVALID_INPUT' })
  })
})

describe('diagnostics', () => {
  it('reports unreadable, non-UTF-8, and oversized files while indexing the rest', async () => {
    const w = await world({ maxSourceBytes: 200 })
    write(join(w.project, 'AGENTS.md'), '# Fine\nok\n')
    write(join(w.project, 'CLAUDE.md'), '# Locked\n')
    write(join(w.project, 'docs', 'binary.md'), Uint8Array.from([0x23, 0x20, 0xff, 0xfe, 0x0a]))
    write(join(w.project, 'docs', 'huge.md'), `# Huge\n${'x'.repeat(300)}\n`)
    write(join(w.project, 'docs', 'ok.md'), '# Ok\n')
    w.fs.failRead.add(join('project', 'CLAUDE.md'))
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual(['AGENTS.md', `${DOCS}/ok.md`])
    expect(snapshot.diagnostics.map(d => [d.code, d.path])).toEqual([
      ['unreadable', 'CLAUDE.md'],
      ['not-utf8', `${DOCS}/binary.md`],
      ['too-large', `${DOCS}/huge.md`],
    ])
    for (const diagnostic of snapshot.diagnostics) expect(diagnostic.message.length).toBeGreaterThan(0)
  })

  it('recovers the source and clears the diagnostic once the file is readable again', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\n')
    w.fs.failRead.add('AGENTS.md')
    const broken = await w.index.snapshot(scopeOf(w))
    expect(broken.sources).toEqual([])
    expect(broken.diagnostics.map(d => d.code)).toEqual(['unreadable'])
    w.fs.failRead.clear()
    const fixed = await w.index.snapshot(scopeOf(w))
    expect(fixed.sources.map(source => source.path)).toEqual(['AGENTS.md'])
    expect(fixed.diagnostics).toEqual([])
  })

  it('reports directories that cannot be listed and the documentation limits it applied', async () => {
    const w = await world({ maxDocFiles: 2, maxDocDepth: 1 })
    write(join(w.project, 'docs', 'a.md'), '# A\n')
    write(join(w.project, 'docs', 'b.md'), '# B\n')
    write(join(w.project, 'docs', 'c.md'), '# C\n')
    write(join(w.project, 'docs', '0bad', 'hidden.md'), '# Hidden\n')
    write(join(w.project, 'docs', '1deep', 'inner', 'd.md'), '# D\n')
    write(join(w.project, 'doc', 'e.md'), '# E\n')
    w.fs.failList.add(join('docs', '0bad'))
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual([`${DOCS}/a.md`, `${DOCS}/b.md`])
    expect(snapshot.diagnostics.map(d => [d.code, d.path])).toEqual([
      ['directory-unreadable', `${DOCS}/0bad`],
      ['limit-exceeded', `${DOCS}/1deep/inner`],
      ['limit-exceeded', 'docs'],
    ])
  })

  it('reports files skipped by the total source budget and directories deeper than the depth limit', async () => {
    const w = await world({ maxTotalSourceBytes: 40, maxDocDepth: 1 })
    write(join(w.project, 'AGENTS.md'), '# A\n123456789\n')
    write(join(w.project, 'docs', 'big.md'), `# Big\n${'x'.repeat(60)}\n`)
    write(join(w.project, 'docs', 'sub', 'deeper', 'z.md'), '# Z\n')
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual(['AGENTS.md'])
    expect(snapshot.diagnostics.map(d => [d.code, d.path])).toEqual([
      ['limit-exceeded', `${DOCS}/sub/deeper`],
      ['limit-exceeded', `${DOCS}/big.md`],
    ])
  })
})

describe('documentation listings across refreshes', () => {
  /** A documentation tree whose directories were last changed a minute ago, so any later change gives them a new version. */
  async function tree(): Promise<World> {
    const w = await world()
    write(join(w.project, DOCS, 'a', 'one.md'), '# One\n')
    write(join(w.project, DOCS, 'b', 'two.md'), '# Two\n')
    const past = new Date(Date.now() - 60_000)
    for (const directory of ['a', 'b', '']) utimesSync(join(w.project, DOCS, directory), past, past)
    await w.index.snapshot(scopeOf(w))
    w.fs.listCalls = []
    return w
  }
  const paths = async (w: World): Promise<string[]> => (await w.index.snapshot(scopeOf(w))).sources.map(source => source.path)

  it('lists no unchanged directory again and still sees an edited file', async () => {
    const w = await tree()
    write(join(w.project, DOCS, 'a', 'one.md'), '# One\n\nEdited.\n')
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sections.find(section => section.path === `${DOCS}/a/one.md`)?.hash).toBe(contentHash('# One\n\nEdited.\n'))
    expect(w.fs.listCalls).toEqual([])
  })

  it('lists only the directory whose entries changed for an added, renamed, or deleted file', async () => {
    const w = await tree()
    write(join(w.project, DOCS, 'a', 'three.md'), '# Three\n')
    expect(await paths(w)).toEqual([`${DOCS}/a/one.md`, `${DOCS}/a/three.md`, `${DOCS}/b/two.md`])
    expect(w.fs.listCalls.map(path => path.slice(w.project.length + 1))).toEqual([`${DOCS}/a`])
    w.fs.listCalls = []
    renameSync(join(w.project, DOCS, 'b', 'two.md'), join(w.project, DOCS, 'b', 'deux.md'))
    expect(await paths(w)).toEqual([`${DOCS}/a/one.md`, `${DOCS}/a/three.md`, `${DOCS}/b/deux.md`])
    expect(w.fs.listCalls.map(path => path.slice(w.project.length + 1))).toEqual([`${DOCS}/b`])
    rmSync(join(w.project, DOCS, 'a', 'three.md'))
    rmSync(join(w.project, DOCS, 'b'), { recursive: true })
    expect(await paths(w)).toEqual([`${DOCS}/a/one.md`])
  })

  it('lists a directory once more after its version held for the settle interval, so an entry that kept the version appears', async () => {
    const w = await world()
    write(join(w.project, DOCS, 'one.md'), '# One\n')
    // A coarse timestamp leaves the version unchanged when an entry is added in the same step.
    w.fs.pinned.set(`/${DOCS}`, FsVersion('pinned-docs-version'))
    const now = performance.now.bind(performance)
    let elapsed = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now() + elapsed)
    await w.index.snapshot(scopeOf(w))
    write(join(w.project, DOCS, 'two.md'), '# Two\n')
    w.fs.listCalls = []
    expect(await paths(w), 'inside the interval the listing is reused').toEqual([`${DOCS}/one.md`])
    expect(w.fs.listCalls).toEqual([])
    elapsed += LISTING_SETTLE_MS
    expect(await paths(w), 'after the interval the directory is listed once more').toEqual([`${DOCS}/one.md`, `${DOCS}/two.md`])
    expect(w.fs.listCalls).toHaveLength(1)
    elapsed += 10 * LISTING_SETTLE_MS
    await w.index.snapshot(scopeOf(w))
    expect(w.fs.listCalls, 'a settled listing is trusted while the version holds').toHaveLength(1)
  })

  it('reports a kept-listing directory or file that can no longer be inspected and skips its documents', async () => {
    const w = await tree()
    w.fs.failStat.set(`${DOCS}/a`, new FsError('denied', 'FS_PERMISSION_DENIED'))
    let snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual([`${DOCS}/b/two.md`])
    expect(snapshot.diagnostics.map(d => [d.code, d.path, d.message])).toEqual([
      ['directory-unreadable', `${DOCS}/a`, 'cannot inspect directory: FS_PERMISSION_DENIED: denied'],
    ])
    w.fs.failStat.clear()
    w.fs.failStat.set(`${DOCS}/b/two.md`, new Error('disk on fire'))
    snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual([`${DOCS}/a/one.md`])
    expect(snapshot.diagnostics.map(d => [d.code, d.path, d.message])).toEqual([
      ['unreadable', `${DOCS}/b/two.md`, 'cannot inspect file: disk on fire'],
    ])
  })
})

describe('latest refresh and last reads', () => {
  it('reports the latest committed refresh of a directory without refreshing', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\nx\n')
    write(join(w.project, 'pkg', 'AGENTS.md'), '# P\n')
    expect(w.index.latest(scopeOf(w))).toBeUndefined()
    expect(w.index.refreshes()).toBe(0)
    const first = await w.index.snapshot(scopeOf(w))
    expect(w.index.latest(scopeOf(w))).toEqual({ snapshot: first, refresh: 1 })
    await w.index.snapshot(scopeOf(w, 'pkg'))
    await w.index.snapshot(scopeOf(w))
    expect(w.index.refreshes()).toBe(3)
    const reads = w.fs.readCalls.length
    write(join(w.project, 'AGENTS.md'), '# A\nchanged\n')
    expect(w.index.latest(scopeOf(w))).toEqual({ snapshot: first, refresh: 3 })
    expect(w.fs.readCalls).toHaveLength(reads)
    expect(() => w.index.latest({ workingDirectory: 'relative' })).toThrow(ContextIndexError)
  })

  it('remembers the hash each section was last read as until the section is gone', async () => {
    const w = await world({ maxIndexedDirectories: 1 })
    write(join(w.project, 'AGENTS.md'), '# A\nx\n')
    write(join(w.project, DOCS, 'guide.md'), '# Guide\nread me\n')
    const sections = (await w.index.snapshot(scopeOf(w))).sections
    const guide = sections.find(section => section.path === `${DOCS}/guide.md`)!
    expect(w.index.lastRead(scopeOf(w)).size).toBe(0)
    await w.index.read(scopeOf(w), [guide.id])
    write(join(w.project, DOCS, 'guide.md'), '# Guide\nedited\n')
    const edited = (await w.index.snapshot(scopeOf(w))).sections.find(section => section.id === guide.id)!
    expect(edited.hash).not.toBe(guide.hash)
    expect([...w.index.lastRead(scopeOf(w))], 'the text read before the edit').toEqual([[guide.id, guide.hash]])
    await w.index.read(scopeOf(w), [guide.id])
    expect(w.index.lastRead(scopeOf(w)).get(guide.id)).toBe(edited.hash)
    rmSync(join(w.project, DOCS, 'guide.md'))
    await w.index.snapshot(scopeOf(w))
    expect(w.index.lastRead(scopeOf(w)).size, 'a deleted section has no last read').toBe(0)
    await w.index.read(scopeOf(w), [sections[0]!.id])
    write(join(w.project, 'pkg', 'AGENTS.md'), '# P\n')
    await w.index.snapshot(scopeOf(w, 'pkg'))
    expect(w.index.lastRead(scopeOf(w)).size, 'an evicted directory keeps no reads').toBe(0)
  })
})

describe('read', () => {
  async function prepared(config: Config = {}): Promise<{ w: World; ids: ContextSectionId[] }> {
    const w = await world(config)
    write(join(w.project, 'AGENTS.md'), '# First\nalpha\n# Wide\nhéllo 界\n# Third\ngamma\n')
    const { sections } = await w.index.snapshot(scopeOf(w))
    return { w, ids: sections.map(section => section.id) }
  }

  it('returns bodies in request order with full-section hashes', async () => {
    const { w, ids } = await prepared()
    const snapshot = await w.index.snapshot(scopeOf(w))
    const result = await w.index.read(scopeOf(w), [ids[2] as ContextSectionId, ids[0] as ContextSectionId])
    expect(result.sections.map(section => section.text)).toEqual(['# Third\ngamma\n', '# First\nalpha\n'])
    expect(result.sections.map(section => section.hash)).toEqual([snapshot.sections[2]?.hash, snapshot.sections[0]?.hash])
    expect(result.sections.map(section => section.anchor)).toEqual(['AGENTS.md#Third', 'AGENTS.md#First'])
    expect(result.usedBytes).toBe(result.sections.reduce((sum, section) => sum + section.bytes, 0))
    expect(result.revision).toBe(snapshot.revision)
    expect(result.missing).toEqual([])
    expect(result.omitted).toEqual([])
  })

  it('reports unknown ids as missing and ignores repeated ids', async () => {
    const { w, ids } = await prepared()
    const unknown = ContextSectionIdOf('sec_0123456789abcdef')
    const result = await w.index.read(scopeOf(w), [ids[0] as ContextSectionId, unknown, ids[0] as ContextSectionId])
    expect(result.sections).toHaveLength(1)
    expect(result.missing).toEqual([unknown])
    expect(() => ContextSectionIdOf('nope')).toThrow(ContextIndexError)
  })

  it('accepts an exact budget, truncates one byte below it, and omits ids after truncation', async () => {
    const { w, ids } = await prepared()
    const [first, wide, third] = ids as [ContextSectionId, ContextSectionId, ContextSectionId]
    const total = (await w.index.read(scopeOf(w), [first])).usedBytes
    expect(total).toBe(14)

    const exact = await w.index.read(scopeOf(w), [first, wide], { maxBytes: total })
    expect(exact.sections).toHaveLength(1)
    expect(exact.sections[0]).toMatchObject({ truncated: false, bytes: total })
    expect(exact.omitted).toEqual([wide])

    const below = await w.index.read(scopeOf(w), [first, wide], { maxBytes: total - 1 })
    expect(below.sections[0]).toMatchObject({ truncated: true, bytes: total - 1, totalBytes: total })
    expect(below.sections[0]?.text).toBe('# First\nalpha')
    expect(below.omitted).toEqual([wide])
    expect(below.usedBytes).toBe(total - 1)
    expect(below.sections[0]?.hash).toBe((await w.index.read(scopeOf(w), [first])).sections[0]?.hash)

    const spread = await w.index.read(scopeOf(w), [first, wide, third], { maxBytes: total + 5 })
    expect(spread.sections.map(section => section.truncated)).toEqual([false, true])
    expect(spread.omitted).toEqual([third])
  })

  it('cuts multibyte text at character boundaries at every limit', async () => {
    const { w, ids } = await prepared()
    const wide = ids[1] as ContextSectionId
    const full = (await w.index.read(scopeOf(w), [wide])).sections[0]
    expect(full?.text).toBe('# Wide\nhéllo 界\n')
    for (let limit = 1; limit <= (full?.totalBytes ?? 0); limit++) {
      const result = await w.index.read(scopeOf(w), [wide], { maxBytes: limit })
      const body = result.sections[0]
      expect(body?.bytes).toBeLessThanOrEqual(limit)
      expect(Buffer.byteLength(body?.text ?? '', 'utf8')).toBe(body?.bytes)
      expect(body?.text).not.toContain('�')
      expect(full?.text.startsWith(body?.text ?? '?')).toBe(true)
      expect(body?.truncated).toBe(limit < (full?.totalBytes ?? 0))
    }
    // "é" occupies bytes 9-10 of the section: a cut after byte 9 drops the whole character.
    expect((await w.index.read(scopeOf(w), [wide], { maxBytes: 9 })).sections[0]?.text).toBe('# Wide\nh')
    expect((await w.index.read(scopeOf(w), [wide], { maxBytes: 10 })).sections[0]?.text).toBe('# Wide\nhé')
  })

  it('returns an empty truncated body when the budget is smaller than the first character', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '界 only\n')
    const { sections } = await w.index.snapshot(scopeOf(w))
    const result = await w.index.read(scopeOf(w), [sections[0]?.id as ContextSectionId], { maxBytes: 2 })
    expect(result.sections[0]).toMatchObject({ text: '', bytes: 0, truncated: true })
  })

  it('lowers a larger request to the configured ceiling and rejects invalid budgets', async () => {
    const { w, ids } = await prepared({ maxReadBytes: 20 })
    const result = await w.index.read(scopeOf(w), ids, { maxBytes: 1_000_000 })
    expect(result.maxBytes).toBe(20)
    expect(result.usedBytes).toBeLessThanOrEqual(20)
    expect((await w.index.read(scopeOf(w), ids)).maxBytes).toBe(20)
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(w.index.read(scopeOf(w), ids, { maxBytes })).rejects.toMatchObject({ code: 'CONTEXT_INDEX_INVALID_INPUT' })
    }
  })

  it('serves the text on disk now and reports a file that became unreadable', async () => {
    const { w, ids } = await prepared()
    write(join(w.project, 'AGENTS.md'), '# First\nchanged\n# Wide\nw\n# Third\ng\n')
    w.fs.failRead.add('AGENTS.md')
    const unreadable = await w.index.read(scopeOf(w), [ids[0] as ContextSectionId])
    expect(unreadable.sections).toEqual([])
    expect(unreadable.diagnostics.some(d => d.code === 'unreadable')).toBe(true)
    w.fs.failRead.clear()
    const fresh = await w.index.read(scopeOf(w), [ids[0] as ContextSectionId])
    expect(fresh.sections[0]?.text).toBe('# First\nchanged\n')
  })

  it('describes a body edited after the refresh by that body, not by the indexed text', async () => {
    const w = await world()
    const path = join(w.project, 'AGENTS.md')
    write(path, '# Rules\nold\n')
    const id = (await w.index.snapshot(scopeOf(w))).sections[0]!.id
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    w.fs.entered = () => { entered.resolve(undefined) }
    w.fs.gate = release.promise
    const pending = w.index.read(scopeOf(w), [id])
    await entered.promise
    write(path, '# Rules\nnew and longer\n')
    release.resolve(undefined)
    const body = (await pending).sections[0]!
    expect(body.text).toBe('# Rules\nnew and longer\n')
    expect({ hash: body.hash, totalBytes: body.totalBytes }).toEqual({
      hash: contentHash(body.text),
      totalBytes: Buffer.byteLength(body.text),
    })
  })
})

describe('disposal', () => {
  it('waits for an accepted section-body read to settle before it completes', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# Rules\nbody\n')
    const snapshot = await w.index.snapshot(scopeOf(w))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const originalRead = w.fs.readBytes.bind(w.fs)
    let activeReads = 0
    vi.spyOn(w.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
      activeReads++
      entered.resolve(undefined)
      try {
        // Physical I/O acknowledges cancellation only after it settles.
        await release.promise
        return await originalRead(target, signal, maxBytes)
      } finally { activeReads-- }
    })
    const settled = w.index.read(scopeOf(w), [snapshot.sections[0]!.id]).catch(() => undefined)
    await entered.promise
    const disposed = w.ctx.fiber.dispose()
    // Disposal only awaits promise chains, so the timer fires after it would have completed without a drain.
    setTimeout(() => { release.resolve(undefined) }, 0)
    const activeWhenDisposed = await disposed.then(() => activeReads)
    await settled
    expect(activeWhenDisposed).toBe(0)
  })

  it('waits for a refresh whose last waiter was cancelled', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# Rules\nbody\n')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const originalRead = w.fs.readBytes.bind(w.fs)
    let activeReads = 0
    vi.spyOn(w.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
      activeReads++
      entered.resolve(undefined)
      try {
        await release.promise
        return await originalRead(target, signal, maxBytes)
      } finally { activeReads-- }
    })
    const caller = new AbortController()
    const cancelled = w.index.snapshot(scopeOf(w), caller.signal).catch(() => undefined)
    await entered.promise
    caller.abort(new Error('caller left'))
    await cancelled
    const disposed = w.ctx.fiber.dispose()
    setTimeout(() => { release.resolve(undefined) }, 0)
    expect(await disposed.then(() => activeReads)).toBe(0)
  })
})

describe('catalog through the service', () => {
  it('uses the configured ceiling and default and rejects invalid budgets', async () => {
    const w = await world({ maxCatalogBytes: 120 })
    write(join(w.project, 'AGENTS.md'), Array.from({ length: 12 }, (_, i) => `# Heading ${i}\nbody\n`).join(''))
    const { sections } = await w.index.snapshot(scopeOf(w))
    const catalog = w.index.renderCatalog(sections)
    expect(catalog.maxBytes).toBe(120)
    expect(catalog.bytes).toBeLessThanOrEqual(120)
    expect(catalog.omitted).toBeGreaterThan(0)
    expect(w.index.renderCatalog(sections, { maxBytes: 9999 }).maxBytes).toBe(120)
    expect(w.index.renderCatalog(sections, { maxBytes: 60 }).bytes).toBeLessThanOrEqual(60)
    expect(() => w.index.renderCatalog(sections, { maxBytes: 0 })).toThrow(ContextIndexError)
  })

  it('shortens long headings in anchors but keeps ids from the full heading', async () => {
    const w = await world({ maxHeadingBytes: 24 })
    write(join(w.project, 'AGENTS.md'), `# ${'界'.repeat(30)}\nx\n`)
    const { sections } = await w.index.snapshot(scopeOf(w))
    expect(Buffer.byteLength(sections[0]?.headingPath[0] ?? '', 'utf8')).toBe(90)
    expect(sections[0]?.anchor.endsWith('...')).toBe(true)
    expect(Buffer.byteLength(sections[0]?.anchor.split('#')[1] ?? '', 'utf8')).toBeLessThanOrEqual(24)
  })
})

describe('concurrency and cancellation', () => {
  function barrier(w: World): { release: () => void; entered: Promise<void> } {
    let release!: () => void
    let enter!: () => void
    w.fs.gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { enter = resolve })
    w.fs.entered = enter
    return { release, entered }
  }

  it('coalesces concurrent refreshes of one working directory into one pass', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\n')
    const { release, entered } = barrier(w)
    const first = w.index.snapshot(scopeOf(w))
    await entered
    const second = w.index.snapshot(scopeOf(w))
    const read = w.index.read(scopeOf(w), [])
    release()
    const [a, b, r] = await Promise.all([first, second, read])
    expect(b).toBe(a)
    expect(r.revision).toBe(a.revision)
    expect(w.fs.readsOf('AGENTS.md')).toBe(1)
  })

  it('refreshes different working directories independently', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\n')
    write(join(w.project, 'pkg', 'AGENTS.md'), '# P\n')
    const [a, b] = await Promise.all([w.index.snapshot(scopeOf(w)), w.index.snapshot(scopeOf(w, 'pkg'))])
    expect(a.sources.map(source => source.path)).toEqual(['AGENTS.md'])
    expect(b.sources.map(source => source.path)).toEqual(['AGENTS.md', 'pkg/AGENTS.md'])
  })

  it('rejects an already aborted call without touching the filesystem', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\n')
    const reason = new Error('already stopped')
    await expect(w.index.snapshot(scopeOf(w), AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(w.fs.readCalls).toEqual([])
  })

  it('stops the shared refresh when the last caller aborts and starts clean afterwards', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\n')
    const { release, entered } = barrier(w)
    const controller = new AbortController()
    const call = w.index.snapshot(scopeOf(w), controller.signal)
    await entered
    const reason = new Error('stop')
    controller.abort(reason)
    await expect(call).rejects.toBe(reason)
    expect(w.fs.readSignals[0]?.aborted).toBe(true)
    release()

    w.fs.gate = undefined
    w.fs.entered = undefined
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.revision).toBe(1)
    expect(snapshot.sources.map(source => source.path)).toEqual(['AGENTS.md'])
  })

  it('lets the remaining caller finish when one of two joined callers aborts', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\n')
    const { release, entered } = barrier(w)
    const leaving = new AbortController()
    const first = w.index.snapshot(scopeOf(w), leaving.signal)
    await entered
    const staying = w.index.snapshot(scopeOf(w))
    const reason = new Error('left')
    leaving.abort(reason)
    await expect(first).rejects.toBe(reason)
    expect(w.fs.readSignals[0]?.aborted).toBe(false)
    release()
    expect((await staying).sources).toHaveLength(1)
    expect(w.fs.readsOf('AGENTS.md')).toBe(1)
  })

  it('does not commit a cancelled refresh', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# A\n')
    const { release, entered } = barrier(w)
    const controller = new AbortController()
    const call = w.index.snapshot(scopeOf(w), controller.signal)
    await entered
    controller.abort(new Error('stop'))
    await call.catch(() => undefined)
    release()
    w.fs.gate = undefined
    await w.index.snapshot(scopeOf(w))
    expect(w.fs.readsOf('AGENTS.md')).toBe(2)
  })
})

describe('disposal', () => {
  it('removes the service, aborts in-flight refreshes, and rejects later calls (HMR safety)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-index-')))
    roots.push(root)
    mkdirSync(join(root, '.git'))
    write(join(root, 'AGENTS.md'), '# A\n')
    vi.stubEnv('DSH_HOME', join(root, 'none'))
    vi.stubEnv('DSH_AGENTS_HOME', join(root, 'none2'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ProbeFileSystem, { cwd: '/' })
    const fiber = ctx.plugin(ContextIndexService)
    await fiber
    const fs = ctx.fs as ProbeFileSystem
    const index = ctx.contextIndex
    let release!: () => void
    let enter!: () => void
    fs.gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { enter = resolve })
    fs.entered = enter

    const pending = index.snapshot({ workingDirectory: root })
    await entered
    await fiber.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'CONTEXT_INDEX_DISPOSED' })
    expect(fs.readSignals[0]?.aborted).toBe(true)
    release()
    expect(ctx.get('contextIndex')).toBeUndefined()
    await expect(index.snapshot({ workingDirectory: root })).rejects.toMatchObject({ code: 'CONTEXT_INDEX_DISPOSED' })
    expect(() => index.renderCatalog([])).toThrow(ContextIndexError)

    fs.gate = undefined
    await ctx.plugin(ContextIndexService)
    expect((await ctx.contextIndex.snapshot({ workingDirectory: root })).sources).toHaveLength(1)
  })
})

describe('configuration', () => {
  it('needs no configuration and applies the documented defaults', () => {
    const defaults = ConfigSchema({})
    expect(defaults).toEqual({
      projectRootMarkers: ['.git'],
      instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md'],
      localInstructionFileCandidates: ['AGENTS.local.md', 'CLAUDE.local.md'],
      docRoots: ['docs', 'doc'],
      docExtensions: ['.md', '.markdown'],
      maxSourceBytes: 1_048_576,
      maxSectionBytes: 8192,
      maxHeadingBytes: 120,
      maxDocFiles: 1024,
      maxDocDepth: 8,
      maxTotalSourceBytes: 16_777_216,
      maxReadBytes: 65_536,
      maxCatalogBytes: 8192,
      maxIndexedDirectories: 16,
    })
  })

  it('fails loudly on misconfiguration', async () => {
    const bad: Config[] = [
      { maxSectionBytes: 8 },
      { maxReadBytes: 0 },
      { maxCatalogBytes: 1.5 },
      { instructionFileCandidates: ['sub/AGENTS.md'] },
      { localInstructionFileCandidates: ['..'] },
      { projectRootMarkers: [''] },
      { docRoots: ['/abs'] },
      { docRoots: [`${DOCS}/../x`] },
      { docExtensions: ['md'] },
    ]
    for (const config of bad) {
      expect(() => resolveConfig(config), JSON.stringify(config)).toThrow(ContextIndexError)
      expect(() => resolveConfig(config)).toThrow(/./)
    }
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ProbeFileSystem, { cwd: '/' })
    await expect(ctx.plugin(ContextIndexService, { maxSectionBytes: 8 })).rejects.toThrow()
  })
})

describe('Loader composition', () => {
  it('boots from cordis.yml with no configuration and indexes the working directory', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-index-loader-')))
    roots.push(root)
    mkdirSync(join(root, 'project', '.git'), { recursive: true })
    write(join(root, 'project', 'AGENTS.md'), '# Rules\nbe kind\n')
    write(join(root, 'project', 'docs', 'guide.md'), '# Guide\n## Steps\ndo it\n')
    vi.stubEnv('DSH_HOME', join(root, 'h'))
    vi.stubEnv('DSH_AGENTS_HOME', join(root, 'a'))
    const configPath = join(root, 'cordis.yml')
    const rows = [
      { name: 'cordis:@deepseek-ai/dsh-fs-local', config: { cwd: '/' } },
      { name: 'cordis:@deepseek-ai/dsh-experimental-context-index' },
    ]
    writeFileSync(configPath, rows.map(row => `- ${JSON.stringify(row)}`).join('\n') + '\n')
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      '@deepseek-ai/dsh-fs-local': LocalFileSystem,
      '@deepseek-ai/dsh-experimental-context-index': ContextIndexService,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    const scope = { workingDirectory: join(root, 'project') }
    const snapshot = await ctx.contextIndex.snapshot(scope)
    expect(snapshot.sections.map(section => section.anchor)).toEqual([
      'AGENTS.md#Rules',
      `${DOCS}/guide.md#Guide`,
      `${DOCS}/guide.md#Guide > Steps`,
    ])
    const catalog = ctx.contextIndex.renderCatalog(snapshot.sections)
    expect(catalog.text.split('\n')[1]).toMatch(/^sec_[0-9a-f]{16} 16B AGENTS\.md#Rules$/)
    const body = await ctx.contextIndex.read(scope, [snapshot.sections[0]?.id as ContextSectionId])
    expect(body.sections[0]?.text).toBe('# Rules\nbe kind\n')
  })
})

describe('discovery failures and limits', () => {
  const diagnosticsOf = (snapshot: { diagnostics: readonly { code: string; path: string; message: string }[] }): string[][] => (
    snapshot.diagnostics.map(d => [d.code, d.path, d.message])
  )

  it('treats a file the filesystem reports as missing or below a non-directory as absent', async () => {
    const w = await world()
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md']) write(join(w.project, name), '# T\n')
    w.fs.failStat.set(`${w.project}/AGENTS.md`, new FsError('gone', 'FS_NOT_FOUND'))
    w.fs.failStat.set(`${w.project}/CLAUDE.md`, new FsError('parent is a file', 'FS_NOT_DIRECTORY'))
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual(['AGENTS.local.md'])
    expect(snapshot.diagnostics).toEqual([])
  })

  it('reports why an instruction file cannot be inspected, keeping the message short', async () => {
    const w = await world()
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']) write(join(w.project, name), '# T\n')
    w.fs.failStat.set(`${w.project}/AGENTS.md`, new FsError('no access', 'FS_PERMISSION_DENIED'))
    w.fs.failStat.set(`${w.project}/CLAUDE.md`, new Error('disk on fire'))
    w.fs.failStat.set(`${w.project}/AGENTS.local.md`, 'plain string failure')
    w.fs.failStat.set(`${w.project}/CLAUDE.local.md`, new Error('x'.repeat(300)))
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources).toEqual([])
    expect(diagnosticsOf(snapshot)).toEqual([
      ['unreadable', 'AGENTS.md', 'cannot inspect file: FS_PERMISSION_DENIED: no access'],
      ['unreadable', 'CLAUDE.md', 'cannot inspect file: disk on fire'],
      ['unreadable', 'AGENTS.local.md', 'cannot inspect file: plain string failure'],
      ['unreadable', 'CLAUDE.local.md', `cannot inspect file: ${'x'.repeat(197)}...`],
    ])
  })

  it('takes the working directory as the project root when no marker is found, and reports a marker it could not probe', async () => {
    const w = await world({ projectRootMarkers: ['.marker'] })
    write(join(w.project, 'AGENTS.md'), '# Project\n')
    write(join(w.project, 'pkg', 'AGENTS.md'), '# Pkg\n')
    w.fs.failStat.set(`${w.project}/pkg/.marker`, new FsError('denied', 'FS_PERMISSION_DENIED'))
    const snapshot = await w.index.snapshot(scopeOf(w, 'pkg'))
    expect(snapshot.sources.map(source => [source.path, source.kind])).toEqual([['AGENTS.md', 'project-instructions']])
    expect(snapshot.sections[0]?.headingPath).toEqual(['Pkg'])
    expect(diagnosticsOf(snapshot)).toEqual([
      ['unreadable', `${w.project}/pkg/.marker`, 'project root marker probe failed: FS_PERMISSION_DENIED: denied'],
    ])
  })

  it('lists documentation in name order whatever order the filesystem returns', async () => {
    const w = await world()
    for (const name of ['b', 'c', 'a', 'd']) write(join(w.project, DOCS, `${name}.md`), `# ${name}\n`)
    w.fs.reverseList = true
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual([`${DOCS}/a.md`, `${DOCS}/b.md`, `${DOCS}/c.md`, `${DOCS}/d.md`])
  })

  it('lists a documentation file once when the filesystem reports its name twice', async () => {
    const w = await world()
    for (const name of ['b', 'a']) write(join(w.project, DOCS, `${name}.md`), `# ${name}\n`)
    w.fs.repeatList = true
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual([`${DOCS}/a.md`, `${DOCS}/b.md`])
  })

  it('stops walking once the documentation file limit is reached, including the remaining directories', async () => {
    const w = await world({ maxDocFiles: 1 })
    for (const directory of ['a', 'b', 'c']) write(join(w.project, DOCS, directory, 'x.md'), '# X\n')
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual([`${DOCS}/a/x.md`])
    expect(snapshot.diagnostics.map(d => [d.code, d.path])).toEqual([['limit-exceeded', `${DOCS}/b`]])
  })

  it('reports a documentation root that cannot be inspected and still indexes the other root', async () => {
    const w = await world()
    write(join(w.project, DOCS, 'one.md'), '# One\n')
    write(join(w.project, 'doc', 'two.md'), '# Two\n')
    w.fs.failStat.set(`${w.project}/${DOCS}`, new FsError('denied', 'FS_PERMISSION_DENIED'))
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual(['doc/two.md'])
    expect(diagnosticsOf(snapshot)).toEqual([
      ['directory-unreadable', DOCS, 'cannot inspect documentation root: FS_PERMISSION_DENIED: denied'],
    ])
  })

  it('maps filesystem size and text rejections of a read to their diagnostics', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# Big\n')
    write(join(w.project, 'CLAUDE.md'), '# Binary\n')
    w.fs.failReadWith.set(`${w.project}/AGENTS.md`, 'FS_TOO_LARGE')
    w.fs.failReadWith.set(`${w.project}/CLAUDE.md`, 'FS_NOT_TEXT')
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources).toEqual([])
    expect(diagnosticsOf(snapshot)).toEqual([
      ['too-large', 'AGENTS.md', 'file is larger than maxSourceBytes (1048576)'],
      ['not-utf8', 'CLAUDE.md', 'file is not UTF-8 text'],
    ])
  })

  it('applies the total source budget to files whose size the filesystem did not report', async () => {
    const w = await world({ maxTotalSourceBytes: 40 })
    write(join(w.project, 'AGENTS.md'), '# A\n123456789\n')
    write(join(w.project, 'CLAUDE.md'), `# Big\n${'x'.repeat(60)}\n`)
    w.fs.hideSize = true
    const snapshot = await w.index.snapshot(scopeOf(w))
    expect(snapshot.sources.map(source => source.path)).toEqual(['AGENTS.md'])
    expect(diagnosticsOf(snapshot)).toEqual([
      ['limit-exceeded', 'CLAUDE.md', 'total source size would exceed maxTotalSourceBytes (40)'],
    ])
  })

  it('rejects a working directory that cannot be inspected with the cause in the message', async () => {
    const w = await world()
    w.fs.failStat.set(w.project, new FsError('denied', 'FS_PERMISSION_DENIED'))
    await expect(w.index.snapshot(scopeOf(w))).rejects.toMatchObject({
      code: 'CONTEXT_INDEX_INVALID_INPUT',
      message: `workingDirectory "${w.project}" cannot be inspected: denied`,
    })
    w.fs.failStat.set(w.project, 'plain string failure')
    await expect(w.index.snapshot(scopeOf(w))).rejects.toMatchObject({
      code: 'CONTEXT_INDEX_INVALID_INPUT',
      message: `workingDirectory "${w.project}" cannot be inspected: plain string failure`,
    })
  })
})

describe('read racing a change to its files', () => {
  async function pendingRead(w: World, id: ContextSectionId, change: () => void | Promise<void>, signal?: AbortSignal): Promise<Awaited<ReturnType<ContextIndexService['read']>>> {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    w.fs.entered = () => { entered.resolve(undefined) }
    w.fs.gate = release.promise
    const pending = w.index.read(scopeOf(w), [id], {}, signal)
    await entered.promise
    await change()
    release.resolve(undefined)
    return pending
  }

  async function indexed(config: Config = {}): Promise<{ w: World; id: ContextSectionId }> {
    const w = await world(config)
    write(join(w.project, 'AGENTS.md'), '# Rules\nold\n')
    return { w, id: (await w.index.snapshot(scopeOf(w))).sections[0]!.id }
  }

  it('reports an id missing when the file no longer has that section', async () => {
    const { w, id } = await indexed()
    const result = await pendingRead(w, id, () => { write(join(w.project, 'AGENTS.md'), '# Other\nnew\n') })
    expect(result.sections).toEqual([])
    expect(result.missing).toEqual([id])
    expect(result.diagnostics).toEqual([])
  })

  it('reports the diagnostic and a missing id when the file becomes unreadable after the refresh', async () => {
    const { w, id } = await indexed()
    const result = await pendingRead(w, id, () => { w.fs.failRead.add('AGENTS.md') })
    expect(result.sections).toEqual([])
    expect(result.missing).toEqual([id])
    expect(result.diagnostics.map(d => [d.code, d.path])).toEqual([['unreadable', 'AGENTS.md']])
  })

  it('rejects a body read with the reason its caller aborted with', async () => {
    const { w, id } = await indexed()
    const controller = new AbortController()
    const reason = new Error('left')
    await expect(pendingRead(w, id, () => { controller.abort(reason) }, controller.signal)).rejects.toBe(reason)
  })

  it('rejects a caller aborted with a non-Error reason with an Error carrying it', async () => {
    const { w } = await indexed()
    write(join(w.project, 'AGENTS.md'), '# Rules\nchanged so the refresh reads the file\n')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    w.fs.entered = () => { entered.resolve(undefined) }
    w.fs.gate = release.promise
    const controller = new AbortController()
    const pending = w.index.snapshot(scopeOf(w), controller.signal)
    await entered.promise
    controller.abort('stop now')
    const error: unknown = await pending.catch((caught: unknown) => caught)
    release.resolve(undefined)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('stop now')
  })

  it('keeps no last-read hash for a directory evicted while its read was in flight', async () => {
    const { w, id } = await indexed({ maxIndexedDirectories: 1 })
    const other = join(w.root, 'other')
    mkdirSync(join(other, '.git'), { recursive: true })
    const result = await pendingRead(w, id, async () => {
      // The other directory has no files to read, so the gated read does not block its refresh.
      await w.index.snapshot({ workingDirectory: other })
    })
    expect(result.sections.map(body => body.id)).toEqual([id])
    expect(w.index.lastRead(scopeOf(w)).size).toBe(0)
  })
})
