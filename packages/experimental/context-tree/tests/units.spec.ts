/** Pure helpers of the context tree: configuration, paths, text bounds, rendering, and compaction stubs. */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { ContextTreeError } from '../src/error.ts'
import { activationStub, grantStub } from '../src/messages.ts'
import { formatPath, parsePath } from '../src/paths.ts'
import { browseFooter, browseHeader, browseLine, renderBrowse, renderLoad } from '../src/render.ts'
import { byteLength, clip, firstSentence, oneLine } from '../src/text.ts'
import type { ContextLoadResult, ContextNodeView } from '../src/types.ts'

const view = (overrides: Partial<ContextNodeView>): ContextNodeView => ({
  path: 'Tools/Global/deploy', kind: 'tool-group', title: 'deploy', summary: 'Use for deploys.', children: 0, ...overrides,
})

const load = (overrides: Partial<ContextLoadResult>): ContextLoadResult => ({
  granted: [], activated: [], alreadyLoaded: [], alreadyActive: [], missing: [], omittedSections: [], omittedTools: [], ...overrides,
})

describe('configuration', () => {
  it('fills every default and always keeps the two tree tools in the base set', () => {
    const config = resolveConfig({ baseTools: ['read'] })
    expect(config.baseTools).toEqual(['read', 'context_browse', 'context_load'])
    expect(config.maxBrowseDepth).toBe(3)
  })

  it('fails loudly on a number below its minimum or a fraction', () => {
    expect(() => resolveConfig({ maxBrowseDepth: 0 })).toThrow(/maxBrowseDepth must be a safe integer of at least 1/)
    expect(() => resolveConfig({ maxSummaryBytes: 31 })).toThrow(ContextTreeError)
    expect(() => resolveConfig({ maxLoadPaths: 1.5 })).toThrow(ContextTreeError)
  })

  it('fails loudly on a base tool name that is empty or holds whitespace', () => {
    expect(() => resolveConfig({ baseTools: [''] })).toThrow(/baseTools entries must be tool names/)
    expect(() => resolveConfig({ baseTools: ['two words'] })).toThrow(ContextTreeError)
  })
})

describe('paths', () => {
  it('round-trips segments that hold the escape characters', () => {
    const segments = ['Instructions', 'Global', '$DSH_HOME/AGENTS.md', '100%']
    expect(parsePath(formatPath(segments))).toEqual(segments)
  })

  it('ignores surrounding slashes and rejects an empty segment inside a path', () => {
    expect(parsePath(' /Tools/ ')).toEqual(['Tools'])
    expect(parsePath('')).toEqual([])
    expect(() => parsePath('Tools//Global')).toThrow(/empty segment/)
  })
})

describe('text bounds', () => {
  it('cuts on a character boundary and counts the ellipsis inside the bound', () => {
    expect(clip('short', 10)).toBe('short')
    const cut = clip('héllo wörld, long text', 9)
    expect(cut.endsWith('…')).toBe(true)
    expect(byteLength(cut)).toBeLessThanOrEqual(9)
    expect(clip('abcdef', 0)).toBe('…')
  })

  it('collapses whitespace and keeps the first sentence', () => {
    expect(oneLine('  a \n b\t c ')).toBe('a b c')
    expect(firstSentence('Deploy the app.  Then wait.')).toBe('Deploy the app.')
    expect(firstSentence('No sentence end')).toBe('No sentence end')
  })
})

describe('rendering', () => {
  it('prints a root header, a capped marker, and a path header', () => {
    expect(browseHeader('', 1, false)).toBe('Context tree at (root), depth 1; (n) counts children:')
    expect(browseHeader('Tools', 3, true)).toBe('Context tree at Tools, depth 3 (capped); (n) counts children:')
  })

  it('drops a title that repeats the last path segment and shows child counts', () => {
    expect(browseLine(view({}))).toBe('- Tools/Global/deploy: Use for deploys.')
    expect(browseLine(view({ title: 'Deploy tools', children: 2 }))).toBe('- Tools/Global/deploy (2): Deploy tools — Use for deploys.')
    expect(browseLine(view({ path: '', title: 'Context tree', kind: 'folder' }))).toBe('- (root): Context tree — Use for deploys.')
  })

  it('tells how to continue a cut listing and says when nothing is there', () => {
    expect(browseFooter(3, 2, 4)).toBe('4 more not listed; continue with offset 5, or browse a narrower path.')
    expect(browseFooter(0, 0, 0)).toBe('Nothing here.')
    expect(browseFooter(2, 0, 0)).toBe('')
  })

  it('renders a listing with and without a footer', () => {
    const base = { path: '', depth: 1, depthCapped: false, total: 1, offset: 0 }
    const full = renderBrowse({ ...base, nodes: [view({})], remaining: 0 })
    expect(full.split('\n')).toHaveLength(2)
    expect(renderBrowse({ ...base, nodes: [view({})], remaining: 5 })).toContain('5 more not listed')
  })

  it('renders every part of a load result', () => {
    expect(renderLoad(load({}))).toBe('Nothing was loaded.')
    const text = renderLoad(load({
      granted: [{ path: 'Instructions/Project/AGENTS.md', anchor: 'AGENTS.md#Rules', bytes: 12, truncated: true }],
      activated: [{ path: 'Tools/Global/deploy', tools: ['deploy_run', 'deploy_status'] }],
      alreadyLoaded: ['a'],
      alreadyActive: ['b'],
      omittedSections: ['c'],
      omittedTools: ['d'],
      missing: ['e'],
    }))
    expect(text).toContain('cut at the load budget')
    expect(text).toContain('Activated from Tools/Global/deploy: deploy_run, deploy_status')
    for (const part of ['Already in the conversation: a', 'Already callable: b', 'byte budget reached: c', 'per-load limit reached: d', 'No such node: e']) {
      expect(text).toContain(part)
    }
    expect(renderLoad(load({ granted: [{ path: 'p', anchor: 'a', bytes: 1, truncated: false }] }))).not.toContain('cut at')
  })
})

describe('compaction stubs', () => {
  it('names a revoked grant by anchor and stable section id', async () => {
    const stub = grantStub({
      kind: 'context-grant', form: 'instructions', key: 'k', path: 'Instructions/Project/AGENTS.md', anchor: 'AGENTS.md#Rules',
      sourceKind: 'project-instructions', hash: 'sha256:x',
    })
    expect(stub).toEqual({
      key: 'k',
      text: 'loaded AGENTS.md#Rules; reload with context_load("k") if needed',
    })
    await expect(stub.text + '\n').toMatchFileSnapshot('./expected/section-reload-stub.txt')
  })

  it('lists at most four revoked tools and counts the rest', async () => {
    const base = { kind: 'context-activation', form: 'notice', summary: 's', key: 'k', nodes: ['Tools/Global/deploy'] } as const
    expect(activationStub({ ...base, tools: ['a', 'b'] }).text).toBe('tools no longer callable: a, b; load Tools/@/a, Tools/@/b again with context_load if needed')
    const text = activationStub({ ...base, tools: ['a', 'b', 'c', 'd', 'e', 'f'] }).text
    expect(text).toContain('a, b, c, d and 2 more')
    await expect(text + '\n').toMatchFileSnapshot('./expected/tool-reload-stub.txt')
  })
})
