/** Review sweep (Fable): per-request restat cost, symlinks, byte bounds, and section id derivation. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FsDirEntry, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContextIndexService, { type Config } from '../src/index.ts'

/** Local filesystem that counts every service call the index makes. */
class CountingFileSystem extends LocalFileSystem {
  counts = { resolve: 0, stat: 0, listDir: 0, readBytes: 0 }

  reset(): void { this.counts = { resolve: 0, stat: 0, listDir: 0, readBytes: 0 } }

  override resolve(path: string, options?: { signal?: AbortSignal }): Promise<FsTarget> {
    this.counts.resolve++
    return super.resolve(path, options)
  }

  override stat(target: FsTarget, signal?: AbortSignal): Promise<{ version: FsVersion; type: 'file' | 'directory' | 'other'; size: number | undefined } | undefined> {
    this.counts.stat++
    return super.stat(target, signal) as never
  }

  override listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    this.counts.listDir++
    return super.listDir(target, signal)
  }

  override readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    this.counts.readBytes++
    return super.readBytes(target, signal, maxBytes)
  }
}

interface World {
  root: string
  home: string
  project: string
  ctx: Context
  fs: CountingFileSystem
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-fable-index-')))
  roots.push(root)
  const home = join(root, 'home')
  const project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(root, 'agents-home'))
  mkdirSync(join(project, '.git'), { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'agents-home'))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(CountingFileSystem, { cwd: '/' })
  await ctx.plugin(ContextIndexService, config)
  return { root, home, project, ctx, fs: ctx.fs as CountingFileSystem, index: ctx.contextIndex }
}

const scope = (w: World) => ({ workingDirectory: w.project })

describe('restat cost per request', () => {
  it('an unchanged refresh re-walks every documentation directory and re-stats every file', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# Rules\n\nUse pnpm.\n')
    const directories = 30
    const filesPerDirectory = 4
    for (let d = 0; d < directories; d++) {
      for (let f = 0; f < filesPerDirectory; f++) {
        write(join(w.project, 'docs', `area-${String(d).padStart(2, '0')}`, `topic-${String(f)}.md`), `# Topic ${String(d)}.${String(f)}\n\nBody.\n`)
      }
    }
    const first = await w.index.snapshot(scope(w))
    expect(first.sections.length).toBe(1 + directories * filesPerDirectory)
    w.fs.reset()
    const second = await w.index.snapshot(scope(w))
    expect(second, 'nothing changed, so the same snapshot object comes back').toBe(first)
    expect(w.fs.counts.readBytes, 'unchanged files are not read again').toBe(0)
    // The cost of one unchanged refresh: one listDir per documentation directory (each of which
    // stats every entry inside fs-local), plus one resolve and one stat per instruction candidate.
    expect(w.fs.counts, 'an unchanged refresh should not re-list every directory').toEqual({ resolve: expect.any(Number), stat: expect.any(Number), listDir: 0, readBytes: 0 })
  })
})

describe('symlinks', () => {
  it('indexes a symlinked instruction file and follows a symlinked documentation directory once', async () => {
    const w = await world()
    write(join(w.root, 'shared', 'AGENTS.md'), '# Shared\n\nShared rule.\n')
    symlinkSync(join(w.root, 'shared', 'AGENTS.md'), join(w.project, 'AGENTS.md'))
    write(join(w.root, 'elsewhere', 'guide.md'), '# Guide\n\nLinked doc.\n')
    mkdirSync(join(w.project, 'docs'))
    symlinkSync(join(w.root, 'elsewhere'), join(w.project, 'docs', 'linked'))
    // A loop back into the documentation root and one up to the project root.
    symlinkSync(join(w.project, 'docs'), join(w.project, 'docs', 'loop'))
    symlinkSync(w.project, join(w.project, 'docs', 'up'))
    const snapshot = await w.index.snapshot(scope(w))
    const paths = snapshot.sources.map(source => `${source.kind}:${source.path}`)
    expect(paths).toContain('project-instructions:AGENTS.md')
    expect(paths).toContain('doc:docs/linked/guide.md')
    // The project root reached through docs/up is walked as a documentation directory, but the
    // instruction file it contains was already indexed and is not listed twice.
    expect(paths.filter(path => path.endsWith('AGENTS.md'))).toHaveLength(1)
    expect(snapshot.diagnostics).toEqual([])
  })

  it('collapses CLAUDE.md that is a symlink to AGENTS.md in the same directory', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# Rules\n\nUse pnpm.\n')
    symlinkSync(join(w.project, 'AGENTS.md'), join(w.project, 'CLAUDE.md'))
    const snapshot = await w.index.snapshot(scope(w))
    expect(snapshot.sources.map(source => source.path)).toEqual(['AGENTS.md'])
  })
})

describe('byte bounds', () => {
  it('indexes a file of exactly maxSourceBytes and refuses one byte more', async () => {
    const w = await world({ maxSourceBytes: 64 })
    write(join(w.project, 'AGENTS.md'), `# A\n\n${'x'.repeat(64 - 5)}`)
    write(join(w.project, 'docs', 'big.md'), `# B\n\n${'y'.repeat(64 - 4)}`)
    const snapshot = await w.index.snapshot(scope(w))
    expect(snapshot.sources.map(source => [source.path, source.bytes])).toEqual([['AGENTS.md', 64]])
    expect(snapshot.diagnostics).toEqual([expect.objectContaining({ code: 'too-large', path: 'docs/big.md' })])
  })

  it('cuts a read inside a multibyte character on the character boundary and never over the budget', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# Emoji\n\n😀😀😀😀😀\n')
    const snapshot = await w.index.snapshot(scope(w))
    const id = snapshot.sections[0]!.id
    for (const budget of [10, 11, 12, 13, 14]) {
      const read = await w.index.read(scope(w), [id], { maxBytes: budget })
      const body = read.sections[0]!
      expect(body.bytes).toBeLessThanOrEqual(budget)
      expect(body.truncated).toBe(true)
      expect(Buffer.from(body.text, 'utf8').toString('utf8')).toBe(body.text)
      expect(body.text).not.toContain('�')
    }
  })

  it('a read budget that cuts inside the first section omits every later id and reports the full hash', async () => {
    const w = await world()
    write(join(w.project, 'AGENTS.md'), '# One\n\nfirst body text\n\n# Two\n\nsecond body\n')
    const snapshot = await w.index.snapshot(scope(w))
    const ids = snapshot.sections.map(section => section.id)
    const read = await w.index.read(scope(w), ids, { maxBytes: 8 })
    expect(read.sections).toHaveLength(1)
    expect(read.sections[0]!.hash).toBe(snapshot.sections[0]!.hash)
    expect(read.omitted).toEqual([ids[1]])
    expect(read.usedBytes).toBeLessThanOrEqual(8)
  })
})

describe('section identity under edits', () => {
  it('keeps ids across a body edit, gives a renamed file new ids, and reports a deleted file\'s ids as missing', async () => {
    const w = await world()
    write(join(w.project, 'docs', 'a.md'), '# A\n\nv1\n')
    const before = await w.index.snapshot(scope(w))
    const id = before.sections[0]!.id
    write(join(w.project, 'docs', 'a.md'), '# A\n\nv2\n')
    const edited = await w.index.snapshot(scope(w))
    expect(edited.sections[0]!.id).toBe(id)
    expect(edited.sections[0]!.hash).not.toBe(before.sections[0]!.hash)
    rmSync(join(w.project, 'docs', 'a.md'))
    write(join(w.project, 'docs', 'b.md'), '# A\n\nv2\n')
    const renamed = await w.index.snapshot(scope(w))
    expect(renamed.sections[0]!.id).not.toBe(id)
    const read = await w.index.read(scope(w), [id])
    expect(read.missing).toEqual([id])
    expect(read.sections).toEqual([])
  })

  it('derives distinct ids for a heading that contains the id separator and a nested heading pair', async () => {
    const w = await world()
    // `A<NUL>B` at level 1 versus the path `A > B`: the id joins heading segments with NUL.
    write(join(w.project, 'AGENTS.md'), '# A\n\n## B\n\nnested\n\n# A\u0000B\n\nflat\n')
    const snapshot = await w.index.snapshot(scope(w))
    const ids = snapshot.sections.map(section => section.id)
    expect(new Set(ids).size, `section ids must be unique: ${ids.join(', ')}`).toBe(ids.length)
  })
})
