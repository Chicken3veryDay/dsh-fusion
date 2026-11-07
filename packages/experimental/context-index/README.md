---
description: "Deterministic, addressable sections of instruction files and documentation, with bounded section reads and catalogs, for developers building on-demand context loading."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-context-index

English | [中文](README.zh.md)

## Summary

The context index splits the user-global and project instruction files and the Markdown under the documentation roots of a working directory into sections. Each section has a stable id, a content hash, a byte size, and a path and heading anchor. The service registers `ctx.contextIndex` and offers `snapshot` (metadata only), `read` (bounded bodies), `renderCatalog` (a bounded listing), and `latest`, `refreshes`, and `lastRead`, which report earlier refreshes and reads without touching the filesystem. It makes no model calls, registers no tools, and needs no configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-experimental-context-index` after a `ctx.fs` provider such as `@deepseek-ai/dsh-fs-local`. Every call takes a scope, `{ workingDirectory }`, which must be an absolute path to an existing directory. No shipped profile mounts the package.

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-experimental-context-index'

export async function listSections(ctx: Context, workingDirectory: string) {
  const snapshot = await ctx.contextIndex.snapshot({ workingDirectory })
  const catalog = ctx.contextIndex.renderCatalog(snapshot.sections, { maxBytes: 4096 })
  const ids = snapshot.sections.slice(0, 1).map(section => section.id)
  const read = await ctx.contextIndex.read({ workingDirectory }, ids, { maxBytes: 8192 })
  return { catalog, read }
}
```

### Sources

The index covers the same files as [`@deepseek-ai/dsh-agent-instructions`](../../context/agent-instructions/README.md), in the same order:

1. `AGENTS.md` in the harness home (`$DSH_HOME`), then in the shared agents root (`$DSH_AGENTS_HOME`).
2. For each directory from the project root (the nearest ancestor holding a `projectRootMarkers` entry, else the working directory) down to the working directory: the `instructionFileCandidates`, then the `localInstructionFileCandidates`.
3. Markdown files (`docExtensions`, compared without case) under each `docRoots` directory of the working directory, in name order, skipping entries whose name starts with `.` and `node_modules`.

A source with a larger `order` is more specific and takes precedence among instructions. Within the two user-global files, and within one project directory, a file whose trimmed content equals an earlier file's is left out, as agent-instructions does; this is not reported. A file reachable twice is indexed once.

The index reads only through `ctx.fs`: it resolves, stats, lists, and reads files with that service, never with host paths. `dsh-agent-instructions` exports `discoverBaselineInstructionFiles`, but that function reads the host filesystem, so this package repeats its discovery rules over `ctx.fs`. A test compares both orders on a nested fixture.

### Sections and ids

Each ATX heading (`#` to `######`, outside fenced code) starts a section that runs to the next heading of any level; `headingPath` holds the enclosing headings. Text before the first heading is a level-0 section unless it is blank. A section above `maxSectionBytes` is split at paragraph boundaries (blank lines outside fenced code), then at line boundaries, then at character boundaries; the parts concatenate to the exact section text and are numbered `part` of `partCount`.

A section id (`sec_` plus 16 hex digits) derives from the source identity (kind and display path), the heading path, how many earlier sections of that source share the heading path, and the part number. It does not derive from content, so editing a section keeps its id. Renaming a heading, moving a file, or reordering repeated headings changes ids. A section that grows past `maxSectionBytes` keeps its part-1 id.

The `hash` of a section (and of a source) is a `sha256:` digest of its exact text (bytes for a source). `snapshot().revision` increases when a source, hash, order, or diagnostic changes; an unchanged refresh returns the same snapshot object.

### Refresh

Every `snapshot` or `read` call revalidates the index; nothing runs in the background. It re-discovers files and compares each file's filesystem version and size with the cached record. A documentation directory whose own version is unchanged is not listed again; its kept listing is reused and each of its documentation files is still statted, so an edit is seen at once and an added, renamed, or deleted entry, which changes the directory's version, makes only that directory listed again. Because filesystem timestamps are coarse, an entry added in the same timestamp step as a listing can leave the directory's version unchanged, so a listing is reused without listing again only within 2 seconds of being taken or once a second listing confirmed the version held for 2 seconds. An unchanged file is not read again. A changed file is read and hashed, and when its hash equals the cached hash only the version is updated. Calls that arrive during a refresh of the same working directory share it, so a shared refresh may report state observed slightly before the later call began. A call that is cancelled stops waiting at once; the shared refresh stops when no caller is left, and a cancelled refresh changes nothing. Disposing the service aborts running refreshes, rejects them and later calls with `CONTEXT_INDEX_DISPOSED`, and clears the cache.

`latest(scope)` returns the snapshot the latest refresh of a working directory committed, with that refresh's ordinal, and `refreshes()` returns the latest ordinal across all directories; a caller that notes `refreshes()` and later finds a higher `latest` ordinal can reuse that refresh instead of starting another. `lastRead(scope)` maps each section to the hash of the text its latest `read` returned, whoever read it; it forgets sections that left the index and directories that were evicted.

### Reads and catalogs

`read(scope, ids, { maxBytes })` resolves ids against a fresh snapshot, re-reads each needed file through `ctx.fs`, and returns bodies in request order. `hash` and `totalBytes` describe the whole section and `text` is cut at a character boundary when the budget ends inside it. After a cut body the remaining ids are listed in `omitted`; ids the index does not contain are listed in `missing`. Bodies come from the file at call time, so compare `hash` with the hash you hold to detect a change.

`renderCatalog(sections, { maxBytes })` returns a header line, one `id sizeB anchor` line per section (plus `[part n/m]` for split sections), and, when sections are left out, a final `(N more sections not listed)` line. The bound covers the complete text. Lines are whole; the listing stops at the first line that does not fit together with the final count, and the text is empty when not even the header and final count fit.

### Diagnostics

A file the index cannot use is absent from `sections` and appears in `diagnostics` with a code, its display path, and a message: `unreadable` (stat or read failed), `not-utf8`, `too-large` (above `maxSourceBytes`), `limit-exceeded` (`maxDocFiles`, `maxDocDepth`, or `maxTotalSourceBytes` reached), and `directory-unreadable`. A file that stops being readable disappears from the index until it can be read again; the index does not serve its last good content. A missing candidate is normal and not reported.

### Configuration

Every field is optional and validated when the service mounts; an invalid value throws `ContextIndexError` with `CONTEXT_INDEX_INVALID_CONFIG`. Per-call budgets above `maxReadBytes` or `maxCatalogBytes` are lowered to them; a budget that is not a positive safe integer throws `CONTEXT_INDEX_INVALID_INPUT`.

| Field | Default | Evidence |
| --- | --- | --- |
| `projectRootMarkers` | `['.git']` | agent-instructions default |
| `instructionFileCandidates` | `['AGENTS.md', 'CLAUDE.md']` | agent-instructions default |
| `localInstructionFileCandidates` | `['AGENTS.local.md', 'CLAUDE.local.md']` | agent-instructions default |
| `docRoots` | `['docs', 'doc']` | conventional roots; this repository uses `docs/` |
| `docExtensions` | `['.md', '.markdown']` | Markdown extensions |
| `maxSourceBytes` | 1,048,576 | agent-instructions `maxSourceBytes`; the largest file in this repository's `docs/` is 472,780 bytes |
| `maxSectionBytes` | 8,192 | covers p99 of 10,432 sections in this repository's `docs/` (6,124 bytes) and the largest of its AGENTS.md sections (8,483 bytes, split into two parts) |
| `maxHeadingBytes` | 120 | the longest of 10,164 headings in `docs/` is 113 bytes (p99.9: 93) |
| `maxDocFiles` | 1,024 | `docs/` here has 601 Markdown files |
| `maxDocDepth` | 8 | the deepest file in `docs/` here is at depth 4 |
| `maxTotalSourceBytes` | 16,777,216 | twice the 8.4 MB of Markdown in `docs/` here |
| `maxReadBytes` | 65,536 | the `dsh-base` agent-instructions budget per chain |
| `maxCatalogBytes` | 8,192 | one eighth of the instruction budget; about 100 listing lines |
| `maxIndexedDirectories` | 16 | working directories kept; the least recently used is evicted |

Minimums: `maxSectionBytes` and `maxHeadingBytes` at least 16, every other number at least 1. The harness homes come from the process environment through `@deepseek-ai/dsh-home-paths`, as in agent-instructions, and cannot be set here. `projectRootMarkers`, `instructionFileCandidates`, and `localInstructionFileCandidates` entries must be plain names; `docRoots` entries must be relative, `/`-separated paths without `.` or `..`; `docExtensions` entries look like `.md`.

## Understand the implementation

- [`src/types.ts`](src/types.ts) holds the browser-safe types: branded ids, section and source metadata, diagnostics, budgets, results, and `Config`. Import `@deepseek-ai/dsh-experimental-context-index/types` for them.
- [`src/text.ts`](src/text.ts) sections Markdown, splits oversized sections, and cuts text on UTF-8 character boundaries.
- [`src/sources.ts`](src/sources.ts) discovers candidates over `ctx.fs`, reads them under the size bound, and builds records.
- [`src/catalog.ts`](src/catalog.ts) renders the bounded catalog.
- [`src/ids.ts`](src/ids.ts) and [`src/config.ts`](src/config.ts) derive ids and hashes and validate configuration.
- [`src/index.ts`](src/index.ts) is the service: the per-directory cache, shared refreshes with caller-aware cancellation, and disposal.

The cache keeps section metadata and file versions but no section text; `read` reads the file again. A committed state is replaced as a whole, so a reader never sees a partly refreshed index.

<a id="model-experience"></a>
## Model Experience

None, as the package adds no tool, prompt, or message; a later package that injects `renderCatalog` output or a `read` body owns its own model input and must log what it injects.

#### KV Cache effect

The package does not change the request prefix, so it has no effect; the catalog and read byte bounds only let a later consumer budget (at the default `maxCatalogBytes`, a catalog is at most 8,192 bytes).

## Known Limitations and Deferred Work

- Nothing consumes the index yet. Session logging of what a consumer injects, a durable project map, and a model-facing load tool belong to later packages.
- Each call re-stats every documentation directory and candidate file; only unchanged directory listings are reused. A consumer that calls on every model step pays that cost each time; the package has no minimum refresh interval.
- A symlinked entry whose target changes type (a file becoming a directory) without the link or its directory changing keeps its kept listing type until that directory changes.
- Only ATX headings split sections. Setext headings (underlined with `===` or `---`) and HTML headings stay in the text of the section above.
- Documentation roots are relative to the working directory, not the project root, and the index follows `ctx.fs` directory entries only; it ignores `.gitignore`.
- A file that becomes unreadable is dropped from the index instead of keeping its last content, so consumers see its ids disappear.
- Section ids change when a heading is renamed, a file moves, or repeated headings are reordered. Consumers that store ids should store the hash with them.

<a id="dev-note"></a>
### Dev Note

This package is experimental and has no stability promise. The index is a cache of files that people own; the files remain the authority.
