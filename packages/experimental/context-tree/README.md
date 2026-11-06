---
description: "A browsable tree of instructions, reference documents, and tools that an agent loads on demand and that compaction revokes, for developers composing lean-context profiles."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-context-tree

English | [中文](README.zh.md)

## Summary

The context tree gives an agent a small set of always-visible tools and a tree of everything else. The roots are `Instructions`, `Sources`, and `Tools`, each split into `Global` and `Project`. The model browses titles and one-line "use these when" summaries with `context_browse`, then calls `context_load` to add instruction or source text to the conversation or to make a group of hidden tools callable from the next step. Compaction revokes loaded text and activations and republishes the catalog. The service makes no model calls and needs no configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-experimental-context-index`, then this package (default export `ContextTreeService`), then mount the named export `ContextTreeTools` through a module that re-exports it as its default, because the Loader mounts only a default export (the profile layer ships such a module), after the tool registry, compaction, and Session projection services. The [profile layer](../context-profile/README.md) does this for a profile. No shipped profile mounts the package.

### The tree

| Root | Global | Project |
|---|---|---|
| `Instructions` | sections of the user-global instruction files | sections of the project instruction files |
| `Sources` | empty; no index source is global documentation | Markdown under the project documentation roots |
| `Tools` | tools registered with `global` or no recorded origin | tools registered with `project` origin, or placed under `Project` by a hint or assigner |

The origin comes from where a file or registration is from, never from its name. Files take their origin from the context index source. A registered tool takes its origin from the registration (`ctx.tools.originOf`), which the producer that reads the configuration layer records: an MCP server with `origin: project` or an ACP session server places its tools under `Project`, and `origin: global` places them under `Global`. A hint or assigner overrides it. A tool whose registration recorded no origin reads as `unknown`, stays under `Global`, and is listed by `unresolvedToolOrigins`. Tool groups come from `registerToolGroup` hints, else from the tool name: `mcp__<server>__*` becomes group `mcp-<server>`, a prefix before the first `_` shared by at least two tools becomes that group, and the rest go to `other`.

A path is the node's segments joined by `/`, as `context_browse` prints it, for example `Tools/Global/probe`. A `%` or `/` inside a segment, such as the `/` in `$DSH_HOME/AGENTS.md`, is written `%25` or `%2F`.

### Tools

- `context_browse(path?, depth = 1, offset = 0)` lists children with path, title, and summary. Depth is capped by `maxBrowseDepth`, and a listing past `maxBrowseNodes` or `maxBrowseBytes` ends with the offset that continues it.
- `context_load(paths)` loads every named node, or every node under a folder. All loads in one call form one change.

### Service API

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-experimental-context-tree'

export function placeTools(ctx: Context) {
  const group = ctx.contextTree.registerToolGroup({ origin: 'project', group: 'tickets', prefix: 'ticket_', summary: 'Use for work-board tickets.' })
  const placement = ctx.contextTree.registerToolPlacement(tool => (tool.name.startsWith('lint_') ? { origin: 'project', group: 'lint' } : undefined))
  return async () => { await group(); await placement() }
}
```

Both return the disposer for the registration. `registerToolPlacement` is the seam for a later curator that regroups tools: an assigner returns a placement or `undefined`. The service also exposes `browse`, `load`, `activeTools`, `isBaseTool`, and `unresolvedToolOrigins`.

### Configuration

Every field has a default.

| Field | Default | Meaning |
|---|---|---|
| `baseTools` | `read`, `read_image`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `bash`, `web_search`, `web_fetch`, `todo_write`, `skill`, `context_browse`, `context_load` | tools always declared; unregistered names are absent, and the two tree tools are always added |
| `maxBrowseDepth` | 3 | deepest level one browse can list |
| `maxBrowseNodes` | 64 | nodes in one listing |
| `maxBrowseBytes` | 8192 | rendered bytes of one listing |
| `maxLoadPaths` | 16 | paths in one load call |
| `maxLoadBytes` | 32768 | section bytes one load adds |
| `maxActivatedTools` | 32 | tools one load can activate |
| `maxSummaryBytes` | 160 | bytes of a node summary |

An unusable value fails at load with `CONTEXT_TREE_INVALID_CONFIG`.

### Events

The package adds no event type. It uses the existing `user/message` event with three source kinds: `context-tree-catalog` (the published tree), `context-grant` (loaded section text), and `context-activation` (tools made callable). The kinds `context-grant` and `context-activation` are registered as revocable compaction sources.

<a id="understand-the-implementation"></a>
## Understand the implementation

- [`src/types.ts`](src/types.ts) holds the types, including the message source shapes.
- [`src/tree.ts`](src/tree.ts) builds the tree from the context index snapshot and the tool registry, with origin placement and grouping.
- [`src/paths.ts`](src/paths.ts) encodes and splits paths; [`src/render.ts`](src/render.ts) renders browse and load results; [`src/messages.ts`](src/messages.ts) builds the catalog, grant, and activation messages.
- [`src/projection.ts`](src/projection.ts) is the Session projection that derives loaded sections, activations, and the published catalog from the log.
- [`src/index.ts`](src/index.ts) is the service: the admission policy, the pre-step catalog hook, revocable sources, browse, and load.
- [`src/tools.ts`](src/tools.ts) registers the two model tools.

Tool admission removes tools from a request and orders the rest. It keeps `baseTools` in registration order, then every tool the projection reports active in activation order. The activation order is derived from the logged activation messages, so the declarations stay reconstructable from the session log. A hidden tool that a model still calls fails at dispatch as unknown. Admission for a step runs after the step claims its inbox and before the claimed messages are logged, so the projection also follows the durable inbox splice: an activation counts from the moment it is queued, through the claim, until the logged message takes over. This makes the tools callable on the very next request without a change to the agent loop.

Before each step the service renders the catalog and, when its digest differs from the projected one, appends a catalog message. After compaction removed the earlier catalog, the new one says it replaces any earlier listing.

<a id="model-experience"></a>
## Model Experience

### Context tree tools

#### What the model sees

Two tool schemas, `context_browse` and `context_load`, with the descriptions in [`src/tools.ts`](src/tools.ts). `context_browse` returns lines of path, title, and summary and a continuation offset when the listing was cut. `context_load` returns which paths were granted, activated, already loaded, already active, missing, or omitted for size. Tools outside `baseTools` and not activated are absent from the request.

#### Token effect

The two schemas add a fixed cost. Every other tool schema is removed until loaded, which is the saving. A browse adds up to `maxBrowseBytes`; a load adds section text up to `maxLoadBytes` plus one activation line.

#### KV Cache effect

Tool declarations sit in the request prefix, so removing hidden tools shortens it once. An activation appends one message and declares the tool after the base tools and earlier activations, so the declarations before it are unchanged and only the new tail is uncached. Activations stay until compaction and several loads in one step form one change, appended in the order the loads were logged. Compaction replaces earlier tokens anyway.

### Tree catalog

#### What the model sees

One user message, `<context_tree>`, with the root nodes and counts, appended before the first model step and again after compaction. Its text is data-dependent on instruction files, documentation, and registered tools.

#### Token effect

Bounded by `maxBrowseBytes`.

#### KV Cache effect

Append-only. It is appended again only when the digest of the tree changes or compaction removed the earlier catalog.

### Loaded sections and activations

#### What the model sees

A `<context-grant path=… section=… hash=…>` message holds loaded section text. A `<context-activation>` message names the tools now callable and the nodes they came from. After compaction a bounded stub, "Revoked context (reload if needed):", names what was revoked.

#### Token effect

Section text up to `maxLoadBytes` per load, retained until compaction, then replaced by a stub of at most the compaction stub bound.

#### KV Cache effect

Append-only growth until compaction, which replaces earlier request tokens as it always does. The request that runs the compaction still declares the activated tools, because the tool set resolves before the compaction pre-step; the declarations drop one step later.

## Known Limitations and Deferred Work

- **Tool origin depends on the producer** — only producers that record an origin place tools under `Tools/Project` (`dsh-mcp-client` and the ACP session servers do). Other registrations read as `unknown`, stay under `Tools/Global`, and appear in `unresolvedToolOrigins` until their producer records one.
- **Skills are not in the tree** — `skill` stays a base tool.
- **Compaction request** — the request that compacts still declares activated tools; declarations drop on the next step. Fixing it needs the tool set to resolve after the compaction pre-step.
- **Later compactions** — a second compaction summarizes the first checkpoint, so earlier revocation stubs fold into the summary.
- **Duplicate grants** — a section loaded twice before its first grant is logged is granted twice.
- **Subagents** — a subagent starts with the base tools; activations are not inherited.
- **Refresh cost** — the context index re-stats instruction and documentation files on every step.
- **No curator** — regrouping tools by a model is deferred; `registerToolPlacement` is its seam.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The design is in the orchestration store of the context-grants wave. This package is experimental and has no stability promise. It makes no model calls: grouping and summaries come from file text, registration hints, and tool descriptions.

</details>
