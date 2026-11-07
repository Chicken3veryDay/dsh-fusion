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

Mount `@deepseek-ai/dsh-experimental-context-index`, then this package (default export `ContextTreeService`), then mount the named export `ContextTreeTools` through a module that re-exports it as its default, because the Loader mounts only a default export (the profile layer ships such a module), after the tool registry, compaction, and Session projection services. The [profile layer](../context-profile/README.md) does this for a profile. No shipped profile mounts the package. Without `ContextTreeTools` the admission policy still hides every tool outside `baseTools`, so the first step that hides one for an agent logs an error naming the hidden tools and the missing plugin.

### The tree

| Root | Global | Project |
|---|---|---|
| `Instructions` | sections of the user-global instruction files | sections of the project instruction files |
| `Sources` | empty; no index source is global documentation | Markdown under the project documentation roots |
| `Tools` | tools registered with `global` or no recorded origin | tools registered with `project` origin, or placed under `Project` by a hint or assigner |

`Tools` lists only tools the agent could be declared: those that passed their own `when` condition and the admission policies that run before this one when the agent's newest step resolved its tools. Before an agent's first step resolution, the tree lists every registered tool.

The origin comes from where a file or registration is from, never from its name. Files take their origin from the context index source. A registered tool takes its origin from the registration (`ctx.tools.originOf`), which the producer that reads the configuration layer records: an MCP server with `origin: project` or an ACP session server places its tools under `Project`, and `origin: global` places them under `Global`. A hint or assigner overrides it. A tool whose registration recorded no origin reads as `unknown`, stays under `Global`, and is listed by `unresolvedToolOrigins`. Tool groups come from `registerToolGroup` hints, else from the tool name: `mcp__<server>__*` becomes group `mcp-<server>`, a prefix before the first `_` shared by at least two tools becomes that group, and the rest go to `other`.

A path is the node's segments joined by `/`, as `context_browse` prints it, for example `Tools/Global/probe`. `context_load` also accepts a bare section id or `Tools/@/<encoded-tool-name>` independently of the current grouping. A previously logged section path resolves by its final section id after regrouping. Tool compaction stubs and the dropped catalog use stable tool addresses; retained activation records also resolve their previous group paths. A `%` or `/` inside a segment, such as the `/` in `$DSH_HOME/AGENTS.md`, is written `%25` or `%2F`.

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

Both return the disposer for the registration. `registerToolPlacement` is the seam for a curator that regroups tools: an assigner returns a placement or `undefined`. The service also exposes `browse`, `load`, `activeTools`, `isBaseTool`, and `unresolvedToolOrigins`.

### Curator seams

Three generic registrations let a curator shape the tree without the tree importing it; the [context map](../context-map/README.md) uses them.

- `registerCuratedGroups(provider)`: for an agent, returns groups (`root`, `origin`, `name`, `title`, `summary`, member `sections` and `tools`). A curated group is a folder node with its own title and summary. Its sections leave their file node, and its tools are placed ahead of hints and names. The catalog lists each non-empty curated group under its origin folder.
- `registerEagerCore(provider)`: returns section ids that the tree grants once at the start of a conversation and again after compaction, as ordinary logged grants within `coreBytes`. A section that does not fit the bytes left is skipped, never granted in part, and later smaller sections still fit. A section whose file changed is granted again with its current text when that text fits after the out-of-date copy's charge moves to it; the new grant says it replaces that copy.
- `registerManagedTools(names, admit)`: tools that only the agents `admit` accepts may see, enforced in tool admission.

### Configuration

Every field has a default.

| Field | Default | Meaning |
|---|---|---|
| `baseTools` | `read`, `read_image`, `write`, `edit`, `apply_patch`, `glob`, `grep`, `bash`, `web_search`, `web_fetch`, `todo_write`, `skill`, `context_browse`, `context_load`, `context_note` | tools always declared; unregistered names are absent, and the two tree tools are always added |
| `maxBrowseDepth` | 3 | deepest level one browse can list |
| `maxBrowseNodes` | 64 | nodes in one listing |
| `maxBrowseBytes` | 8192 | rendered bytes of one listing |
| `maxLoadPaths` | 16 | paths in one load call |
| `maxLoadBytes` | 32768 | bytes of the grant messages one load adds, frames included |
| `maxActivatedTools` | 32 | tools one load can activate |
| `maxSummaryBytes` | 160 | bytes of a node summary |
| `maxDroppedBytes` | 1024 | bytes of the revoked-section list a republished catalog keeps across later compactions |
| `coreBytes` | 4096 | section bytes an eager core provider may grant at the start of a conversation |

An unusable value fails at load with `CONTEXT_TREE_INVALID_CONFIG`. A browse keeps its full path in the result and clips only the displayed header when needed to fit `maxBrowseBytes`. A partial section grant can be loaded again; only complete grants suppress duplicate loads. Eager grants record their byte charge in the Session source. The newest held grant of each section, including earlier selections and queued or claimed grants, sets its charge against `coreBytes` until revocation: an eager grant charges what it recorded, and an explicit load of a selected section charges that section's size. Changing the core cannot accumulate another full budget before compaction. Earlier grants without a recorded charge defer new eager grants until revocation, because their eager or explicit origin is unknown.

### Events

The package adds no event type. It uses the existing `user/message` event with three source kinds: `context-tree-catalog` (the published tree), `context-grant` (loaded section text), and `context-activation` (tools made callable). The kinds `context-grant` and `context-activation` are registered as revocable compaction sources. The pre-step publisher and `system-prompt/request-context` share these messages: after request-time compaction, missing catalog and eager-core messages are restored before sending. The request-time hook counts eager grants among the accepted pending messages against `coreBytes` and as held, so the two hooks never grant two budgets in one request. It adds no second catalog when the step's pending messages already carry one; compaction since then only moves entries into the dropped list, and the compaction stubs in the history name them for that request. Core sections that compaction removed are still granted again in that request, within `coreBytes`. Sections the request grants again are left out of the dropped list. The loop commits every addition to the Session log before deriving the request.

<a id="understand-the-implementation"></a>
## Understand the implementation

- [`src/types.ts`](src/types.ts) holds the types, including the message source shapes.
- [`src/tree.ts`](src/tree.ts) builds the tree from the context index snapshot and the tool registry, with origin placement and grouping. Recorded tool origins take precedence over conflicting placement hints; unknown origins may be assigned. A curated folder sharing a file path includes the file's ungrouped sections at that same address.
- [`src/paths.ts`](src/paths.ts) encodes and splits paths; [`src/render.ts`](src/render.ts) renders browse and load results; [`src/messages.ts`](src/messages.ts) builds the catalog, grant, and activation messages.
- [`src/projection.ts`](src/projection.ts) is the Session projection that derives loaded sections, activations, and the published catalog from the log. Compaction lists a section as dropped only when no retained grant for that section remains. The service intersects logged candidates with the Session-owned current surface, so any surface replacement permits removed sections to be loaded again and revokes removed activations.
- [`src/index.ts`](src/index.ts) is the service: the admission policy, the pre-step catalog hook, revocable sources, browse, and load. The admission policy records, per agent, which registered tools did not reach it as candidates, and the tree leaves those out.
- [`src/tools.ts`](src/tools.ts) registers the two model tools.

Tool admission removes tools from a request and orders the rest. It keeps `baseTools` in their configured order, so a provider that reloads does not move its tools, then every tool the projection reports active in activation order. The activation order is derived from the logged activation messages, so the declarations stay reconstructable from the session log. A hidden tool that a model still calls fails at dispatch as unknown. Admission for a step runs after the step claims its inbox and before the claimed messages are logged, so the projection also follows the durable inbox splice: an activation counts from the moment it is queued, through the claim, until the logged message takes over. This makes the tools callable on the very next request without a change to the agent loop.

Curator-managed tools append after already activated tools, so gaining the role preserves the existing declaration prefix. A republished catalog omits active tools from its dropped list even when they were reloaded separately from their original group.

A load plans its sections against `maxLoadBytes` with each grant's frame counted: whole sections with the full frame while they fit, then one cut section with the most detailed frame that leaves room for text. The rendered messages are checked against the budget again, so a file that grew after the snapshot cannot push a load past it.

Compaction revokes grants, activations, and the catalog only when its replacement message commits. A log-only summary without its replacement preserves the visible sections and tool declarations, including after restart; dropped-section bookkeeping changes with the replacement.

Before each step the service renders the catalog and, when its digest differs from the projected one, appends a catalog message. The digest covers the non-empty origin folders and the curated groups under them, with their summaries. After compaction removed the earlier catalog, the new one says it replaces any earlier listing.

<a id="model-experience"></a>
## Model Experience

### Context tree tools

#### What the model sees

Two tool schemas, `context_browse` and `context_load`, with the descriptions in [`src/tools.ts`](src/tools.ts). `context_browse` returns lines of path, title, and summary and a continuation offset when the listing was cut. `context_load` returns which paths were granted, activated, already loaded, already active, missing, or omitted for size. A tool whose own condition excludes the agent is not in the tree, so loading it reports the path as missing. Tools outside `baseTools` and not activated are absent from the request.

#### Token effect

The two schemas add a fixed cost. Every other tool schema is removed until loaded, which is the saving. A browse adds up to `maxBrowseBytes`; a load adds grant messages up to `maxLoadBytes` plus one activation line.

#### KV Cache effect

Tool declarations sit in the request prefix, so removing hidden tools shortens it once. An activation appends one message and declares the tool after the base tools and earlier activations, so the declarations before it are unchanged and only the new tail is uncached. Activations stay until compaction and several loads in one step form one change, appended in the order the loads were logged. Compaction replaces earlier tokens anyway.

### Tree catalog

#### What the model sees

One user message, `<context_tree>`, with one line per non-empty origin folder and, indented under it, one line per curated group, appended before the first model step and again after compaction. Its text is data-dependent on instruction files, documentation, registered tools, and curated groups.

#### Token effect

A fixed frame, at most six folder lines, the dropped list within `maxDroppedBytes`, and curated group lines within `maxBrowseBytes`; groups past that bound are counted on one line.

#### KV Cache effect

Append-only. It is appended again only when the digest changes, which happens when an origin folder or a curated group appears, disappears, or changes its summary, or when compaction removed the earlier catalog.

### Loaded sections and activations

#### What the model sees

A `<context-grant path=… section=… hash=…>` message holds loaded section text. When a load budget cannot hold that frame, the message drops `section` and `hash`, then `path`, and a cut ends with `[cut]` instead of the full notice. A grant of a section whose earlier copy in the conversation no longer matches the file carries `replaces="<old hash>"` and opens with a line saying the earlier copy is out of date. A `<context-activation>` message names the tools now callable and the nodes they came from. After compaction a bounded stub, "Revoked context (reload if needed):", names what was revoked.

#### Token effect

Grant messages up to `maxLoadBytes` per load, frames included, retained until compaction, then replaced by a stub of at most the compaction stub bound.

#### KV Cache effect

Append-only growth until compaction, which replaces earlier request tokens as it always does. The request that runs the compaction still declares the activated tools, because the tool set resolves before the compaction pre-step; the declarations drop one step later.

## Known Limitations and Deferred Work

- **Tool origin depends on the producer** — only producers that record an origin place tools under `Tools/Project` (`dsh-mcp-client` and the ACP session servers do). Other registrations read as `unknown`, stay under `Tools/Global`, and appear in `unresolvedToolOrigins` until their producer records one.
- **Skills are not in the tree** — `skill` stays a base tool.
- **Compaction request** — the request that compacts still declares activated tools; declarations drop on the next step. Fixing it needs the tool set to resolve after the compaction pre-step.
- **Later compactions** — a second compaction summarizes the first checkpoint, so earlier revocation stubs fold into the summary.
- **Out-of-date copies** — a section loaded again after an edit leaves its earlier copy in the conversation until compaction; the new grant marks it out of date, and only the newest grant of a section charges `coreBytes`. An edited core section whose new text does not fit the core budget is not granted again, and its earlier copy stays unmarked until compaction or an explicit load.
- **Tools registered within a step** — the tree filters tools by the agent's newest step resolution, so a tool registered after it is listed until the next step resolves its condition.
- **Duplicate grants** — a section whose complete grant is queued or claimed but not yet logged counts as loaded, so a second load in that window is not granted twice.
- **Subagents** — a subagent starts with the base tools; activations are not inherited.
- **Refresh cost** — the context index re-stats instruction and documentation files on every step.
- **Dropped sections** — compaction folds earlier revocation stubs into its summary on a second compaction. The tree keeps its own list of revoked sections in projection state (bounded by `maxDroppedBytes`) and republishes it with the catalog, which mitigates but does not fix this; the fix belongs to compaction.
- **Curator** — the context map provides the curator; with none mounted the tree behaves as before.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The design is in the orchestration store of the context-grants wave. This package is experimental and has no stability promise. It makes no model calls: grouping and summaries come from file text, registration hints, and tool descriptions.

</details>
