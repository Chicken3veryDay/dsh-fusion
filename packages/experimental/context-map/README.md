---
description: "An agent-maintained project map of grouped context sections, tools, and cited notes, edited only by the curator role holder, with a zero-configuration background curator, for developers composing lean-context profiles."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-context-map

English | [中文](README.zh.md)

## Summary

The context map records how a project's instructions, documents, and tools belong together: named groups with a one-line summary, and short notes that cite their sources. The [context tree](../context-tree/README.md) shows these groups and grants the map's core sections up front. Only the curator role holder edits the map. A background default curator holds the role unless another holder claims it, runs on a cheaper model route, and keeps its transcript out of the working conversation. The working agent gets one tool, `context_note`. No configuration is needed.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the [context tree](../context-tree/README.md) with its tools, then this package (default export `ContextMapService`), then `ContextMapTools` and optionally `DefaultContextCurator`, each through a module that re-exports it as its default, because the Loader mounts only a default export. The [profile layer](../context-profile/README.md) ships those modules and mounts all of it for a profile. No shipped profile mounts the package.

### The map

| Record | Contents |
|---|---|
| Group | id, path `Root/Origin/name` (`Instructions`, `Sources`, or `Tools`; `Global` or `Project`), title, one-line summary, member section ids, member tool names, notes |
| Note | id, text, and at least one citation: a section id with the hash of the text last read from it, or a `ref:` evidence pointer |
| Pending note | text filed by `context_note`, waiting for the curator |
| Core | section ids the tree grants at the start of every conversation, within the tree's `coreBytes` budget |

A note whose cited section changed or vanished is stale: its group summary says so until the curator re-reads the source and verifies or retires it. A section citation carries the hash of the text the index last returned for that section, or the indexed hash when nobody read it, so a file edited after the curator read it leaves the new note stale at once. A note can never cite another note. Every edit carries the revision it was based on, and an edit against an older revision fails with `CONTEXT_MAP_CONFLICT`.

### The curator role

The role is a durable grant recorded in the log, checked against the exact live agent that calls, never against a Session id passed in. There is exactly one holder per map; a reverse holder index is rebuilt from prepared live Session projections on load and updated on agent creation and map commits. A holder may curate several maps; pass `root_session_id` to a curator tool, or `rootSessionId` to a service edit, to select another conversation’s map. An omitted target always selects the caller’s own root conversation, including when the caller holds other maps. Disposal releases every held map. `claim` replaces the previous holder and logs the handoff; with `expectedHolder` it replaces only that holder (`null` for an unclaimed map) and fails with `CONTEXT_MAP_CONFLICT` otherwise. `claim` checks its signal and `expectedHolder` after its index read, immediately before the commit, so a canceled claim neither replaces a newer holder nor counts as an attempt. `release` gives the role up. A `context_note` from a holder other than the owner, or from an agent that holder started, fails with `CONTEXT_MAP_UNAUTHORIZED` and points at `map_note`: the holder files what it finds itself, and a pending note of its own would be work for its next run. A holder that disappears without releasing is recorded as gone and the role is free again. The curator tools `map_view`, `map_group`, `map_note`, and `map_core` are declared only for the holder, and the service rejects any other caller at execution, so a stale tool set gains nothing. No package here imports an assistant: a later assistant claims the role through `ctx.contextMap.claim`.

### The default curator

`DefaultContextCurator` starts a run when curation work waits and no other agent holds the role, and not on every step. Work is a context index the last completed run did not acknowledge, a pending note, a stale note, or a note the working agent filed that was refused because the map is full. Every owner step that finds waiting work announces it with a `work-waiting` change that carries the work's fingerprint and logged attempts; the service remembers no announcement, so a curator whose start failed before its claim sees the work again at the next owner step. A curator that loads beside live owners checks each of them at once, so work accepted while it was not loaded resumes without another owner step. The map observes an owner step after every other step hook, including the context tree's catalog check, and reuses the index refresh that check made; the curator decides an announcement from the work it carries. An owner step therefore refreshes the index once and reads no map view. A run:

1. picks a route from the working agent's provider: the smallest model with at least `minContextTokens` of window, at its least reasoning effort. The catalog carries no price, so this is the proxy for "cheap". The route must undercut the working agent's own route (smaller window, or the same window while the working agent runs above its least effort); otherwise `CONTEXT_MAP_NO_CHEAP_ROUTE` is logged and the curator does not run, because an expensive curator is worse than none;
2. claims the role for a reserved child id and starts a subagent through the existing subagent service, bounded by `maxSteps` and `maxTokens`;
3. ends when its work is done, the step bound is reached, or another holder claims the role (it yields at once and restarts only after that holder is gone or releases the role);
4. cancels a pending catalog read on disposal, observes any late catalog failure, releases the role and settles the subagent before the next run or before disposal.

Each live map owner has one lifecycle record, and one transition function is the only code that changes its state:

| State | Meaning | Leaves on |
|---|---|---|
| `idle` | nothing in progress | a trigger → `announced`; owner or service disposal → `disposed` |
| `announced` | checking the map: a live holder, the waiting work (as the owner step announced it, otherwise read once), its logged attempts | eligible work → `claiming`; no work, a live holder, `maxAttempts` used, no cheap route for this work and route, or a failed read → `idle`; disposal → `disposed` |
| `claiming` | selecting the route, claiming with `expectedHolder: null`, starting the subagent | started → `running`; a stop → `yielding`; a failed or canceled start → `settling` |
| `running` | the subagent works under the role | a stop → `yielding`; the subagent ends → `settling` |
| `yielding` | aborted and waiting for the start or subagent to end | it ends → `settling` |
| `settling` | disposing the subagent, releasing the role it still holds, acknowledging a completed index | settled → `idle`, or `disposed` when the owner or service is gone |
| `disposed` | terminal; the record is removed | — |

A trigger is an owner step's announcement, a filed or refused note, a foreign holder gone, a live holder releasing the role, the curator loading beside a live owner, or a run that yielded to a holder that has since gone. A stop is another holder committing the role (`role moved`), the step bound, owner disposal, or curator disposal. A filed note or a gone holder during a run starts another run after it settles only when the work changed; an owner step's announcement does not, so an interrupted run is retried by a later owner step. A failed start before the claim leaves the work eligible for the next owner step and logs a repeated failure once; `CONTEXT_MAP_NO_CHEAP_ROUTE` is not retried until the work or the owner's route changes. Owner disposal aborts the run and removes the record once the run settles; a new agent for the same Session gets a new record.

A claim returns `observedIndexDigest` without marking the index curated. After successful completion, the holder or the owner of the released map calls `acknowledgeIndex` with that digest; its `index-ack` event records completion. Step limits, errors, cancellation, and restart leave the previous digest intact. Recovery treats legacy claim-time digests without an `index-ack` as incomplete. Another owner step or note can trigger a new attempt; an interrupted run does not immediately retry itself. An index change during a run remains eligible after that run completes. Each claim logs a fingerprint of the work it serves, and replay counts claims for the same fingerprint. After `maxAttempts` (default 2) runs for unchanged work, further owner steps and notes start none until the work changes (a new index digest, another pending or stale note, a map of a different size when full). The count lives in the Session log, so a restart does not reset it. A claim made for work during which an assistant held the role also counts.

### Service API

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-experimental-context-map'

export async function curate(ctx: Context, assistant: Agent, owner: Agent) {
  await ctx.contextMap.claim(assistant, { holderId: assistant.id, rootSessionId: owner.id })
  const view = await ctx.contextMap.view(assistant, { rootSessionId: owner.id })
  await ctx.contextMap.setGroup(assistant, {
    rootSessionId: owner.id, expectedRevision: view.revision,
    group: { path: 'Tools/Global/shell', title: 'Shell tools', summary: 'Use when running commands.', tools: ['bash'] },
  })
}
```

The service also exposes `watch`, `curatedRoots`, `isCurator`, `curatorOf`, `snapshotOf`, `note`, `mergeGroups`, `retireGroup`, `addNote`, `verifyNote`, `retireNote`, `filePending`, `dropPending`, `setCore`, and `curationWork` (the waiting `CurationWork`: reasons, a fingerprint, and the claims already logged for it).

### Tools

- `context_note(text, cites?)` for every agent except a holder other than the owner and the agents it started: records one short fact. It returns the pending id and how many notes wait. A subagent's note goes to the map of the conversation it belongs to.
- `map_view(pending_after?, group_after?, group_id?, note_after?)`, `map_group(action, …)`, `map_note(action, …)`, `map_core(sections)` for the curator only.

The view budgets the complete serialized result. Continue pending notes with `nextPendingAfter` as `pending_after`, groups with `nextGroupAfter` as `group_after`, and an incomplete group's notes with its id as `group_id` and `nextNoteAfter` as `note_after`. Cursors follow ids in lexical order and remain valid after filing, dropping, or retiring earlier entries. New entries before a cursor appear on a fresh scan. Group pages omit pending notes, so a full queue cannot hide groups. Each group's `omittedNotes` counts notes left after its page. Metadata or a single item that cannot fit fails with `CONTEXT_MAP_LIMIT`; increase `maxViewBytes`. At load, `maxViewBytes` must cover the page metadata and a maximum-size pending note at the configured text and citation limits, including JSON escaping. An edit that would make a single pending note, group header, or group note exceed the view budget fails before it is logged. A rejected note at a full queue wakes the default curator again.

### Configuration

Every field has a default.

| Field | Default | Meaning |
|---|---|---|
| `maxGroups` | 32 | groups in the map |
| `maxGroupMembers` | 32 | sections plus tools in one group |
| `maxNotesPerGroup` | 8 | filed notes in one group |
| `maxCitesPerNote` | 4 | citations on one note |
| `maxNoteBytes` | 400 | bytes of note text |
| `maxEvidenceBytes` | 200 | bytes of a `ref:` evidence pointer |
| `maxPendingNotes` | 16 | notes waiting for the curator |
| `maxTitleBytes` | 80 | bytes of a group title |
| `maxSummaryBytes` | 160 | bytes of a group summary |
| `maxCoreSections` | 8 | sections in the core |
| `maxSnapshotBytes` | 65536 | serialized map with `curatorId`, `route`, and `indexDigest` set to null |
| `maxViewBytes` | 8192 | bytes `map_view` returns |

The default curator adds `provider` (`spawn`, the in-process subagent provider), `maxSteps` (24), `maxTokens` (4096), `minContextTokens` (32768), `maxRoutesInspected` (16), and `maxAttempts` (2). The values are bounds chosen so a full map stays within one view and a run stays within one cheap model call budget; they are not tuned to a workload. An unusable value fails at load with `CONTEXT_MAP_INVALID_CONFIG`.

Role changes and index acknowledgement are metadata operations exempt from `maxSnapshotBytes`. Every content edit uses the same metadata-free measurement, so releasing a role gives pending notes no extra room. A full map can always be claimed for shrinking. A `context_note` refused for lack of room marks the map as needing space until the next finished role hold: `map_view` then carries `needsSpace: true`, the default curator starts a run, and its prompt tells it to merge and retire until there is room. The mark is process memory that ends with the owner agent; the working agent's retry sets it again after a restart. The service also keeps each live owner's section hashes for stale markers and drops them when the owner agent is disposed. The refusal asks the working agent to shorten the note or retry after space is freed.

### Events

The package adds the event type `context-map/state`. Each record carries the operation (`claim`, `release`, `index-ack`, `group-set`, `group-merge`, `group-retire`, `note-add`, `note-verify`, `note-retire`, `note-pending`, `note-file`, `pending-drop`, or `core-set`), the acting agent, and the whole map snapshot with a contiguous revision. A Session projection folds the records back into the map and fails on a gap. The Session format version does not change; see the persistence change record `2026-11-06-context-map-index-ack`.

<a id="understand-the-implementation"></a>
## Understand the implementation

- [`src/types.ts`](src/types.ts) holds the map records, requests, and configuration types.
- [`src/projection.ts`](src/projection.ts) is the Session projection and the strict schemas of the event.
- [`src/edits.ts`](src/edits.ts) holds the pure edit rules: path parsing, member and citation checks, hashing, and staleness.
- [`src/index.ts`](src/index.ts) is the service: revision checks, the role check, commit, observation of index changes, and registration with the tree through its curated-group, eager-core, and managed-tool seams.
- [`src/tools.ts`](src/tools.ts) registers the model tools. [`src/route.ts`](src/route.ts) selects the curator route. [`src/curator.ts`](src/curator.ts) is the default curator.

The service commits one event per edit: it appends, flushes, and only then updates the cached map and tells watchers. A note's staleness is computed from the content hashes stored with its citations and the hashes of the current index, so no background job decides it. The map belongs to the root Session of a lineage. A subagent files notes to its root, and the curator child is never given the map of its own Session.

<a id="model-experience"></a>
## Model Experience

### Context note tool

#### What the model sees

One tool schema, `context_note`, with the description in [`src/tools.ts`](src/tools.ts). It returns the pending note id and how many notes are waiting. The curator tools are absent from the working agent's request.

#### Token effect

A fixed schema cost for one tool plus the note text the model writes.

#### KV Cache effect

The schema sits among the declared tools and is a base tool, so it is part of the stable prefix. A call appends a short tool call and result.

### Map groups in the tree

#### What the model sees

The tree catalog and `context_browse` show curated groups as folders with the curator's title and summary, and a stale marker before the summary of a group that holds a stale note, so summary clipping preserves the warning. Grouped sections leave their file node. Filed notes are read by the curator and by assistants through `map_view` and `snapshotOf`; the working agent sees only the stale marker, not the note text.

#### Token effect

Titles and summaries replace raw file and tool names within the tree's existing `maxBrowseBytes`. The tree catalog lists the curated groups and is republished when a group appears, disappears, or changes its summary, at most once per change; other map edits, such as notes and core choices, do not republish it.

#### KV Cache effect

Append-only like the tree catalog: a changed catalog is one appended message. The eager core is granted once at the start of a conversation and again after compaction, within `coreBytes`.

### Curator run

#### What the model sees

Nothing. The curator runs in its own Session; the working conversation receives neither its prompt nor its tool calls. The working agent's Session log holds only the `context-map/state` records.

#### Token effect

None in the working conversation. The curator's own tokens are billed to its cheaper route.

#### KV Cache effect

None for the working conversation.

## Known Limitations and Deferred Work

- **No price metadata** — the model catalog has no price, so "cheap" is a documented proxy (smallest adequate window at the least effort, undercutting the working agent's route). A deployment where that proxy is wrong has to claim the role with its own agent.
- **One provider** — route selection looks only at the working agent's provider.
- **Index changes are seen at a step** — a change is noticed at the root agent's next step, not when the file is written.
- **Tool membership is by name** — a group lists tool names; a renamed or removed tool leaves a stale member until the curator edits the group.
- **Dropped sections after compaction** — the context tree keeps the list of revoked sections it republishes, bounded by `maxDroppedBytes`. Compaction itself still folds the previous revocation stubs into the summary on a second compaction, and fixing that needs a change in compaction.
- **Notes are not shown to the working agent** — the tree shows groups and a stale marker, not note text, so a filed note helps the curator and later assistants but does not yet reach the working conversation. Showing note text needs a model-visible grant with its own session event.
- **Citations use the latest read in the working directory** — the index remembers one last-read hash per section, whoever read it. When another agent reads the edited text before the curator files its note, the citation names that newer text although the curator read the older one.
- **`context_note` stays declared for the curator** — the context tree declares it as a base tool for every agent; the service refuses it for the holder, and the curator prompt says so.
- **No cross-conversation map** — the map belongs to one root Session; a new conversation starts with an empty map.
- **No assistant yet** — the role is built for a harness assistant, but nothing here imports or ships one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The design is in the orchestration store of the context-grants wave. This package is experimental and has no stability promise. It depends on the context tree only; the tree knows the map through generic registration seams (`registerCuratedGroups`, `registerEagerCore`, `registerManagedTools`) and never imports it.

</details>
